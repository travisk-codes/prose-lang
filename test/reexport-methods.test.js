import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compile, parse } from '../src/transpile.js';
import { format } from '../src/format.js';

const calculator = 'export calculator is object\n    add is function takes left as number, right as number giving number return left + right';
const modules = {
  './calculator.prose': calculator,
  './public/tools.prose': 'use calculator from "../calculator.prose"\nexport math is calculator',
  './entry.prose': 'use math from "./public/tools.prose"\nexport tools is object math'
};
function reader(files = modules) {
  const reads = [];
  return { reads, readModule: path => {
    reads.push(path);
    if (!Object.hasOwn(files, path)) throw new Error(`Missing ${path}`);
    return files[path];
  } };
}
const boundary = (source, files) => assert.throws(() => compile(source, reader(files)), error => error.code === 'PROSE_CALL_BOUNDARY');

test('method signatures follow forwarding chains and nested relative imports', () => {
  const options = reader();
  const source = 'use tools from "./entry.prose"\nprint tools.math.add 2, 3, 9';
  assert.match(compile(source, options).code, /\[2, 3\].*9\]/);
  assert.deepEqual(options.reads, ['./entry.prose', './public/tools.prose', './calculator.prose']);
  const formatted = format(source, { ...reader(), width: 30 });
  const meaning = source => JSON.stringify(parse(source, reader()), (key, value) => key === 'line' ? undefined : value);
  assert.equal(meaning(formatted), meaning(source));
  assert.equal(format(formatted, { ...reader(), width: 30 }), formatted);
});

test('direct and forwarded aliases preserve shared object identity', () => {
  boundary([
    'use calculator from "./calculator.prose"', 'use math from "./public/tools.prose"',
    'math.add is function takes value return value', 'print calculator.add 1, 2'
  ].join('\n'));
  boundary([
    'use calculator from "./calculator.prose"', 'use tools from "./entry.prose"',
    'tools.math.add is function takes value return value', 'print calculator.add 1, 2'
  ].join('\n'));
  assert.doesNotThrow(() => compile([
    'use calculator from "./calculator.prose"', 'use math from "./public/tools.prose"',
    'math.add is function takes a, b return a * b', 'print calculator.add 1, 2, 3'
  ].join('\n'), reader()));
});

test('method replacements inside a forwarding module withdraw signatures in every alias', () => {
  const files = { ...modules, './public/tools.prose': modules['./public/tools.prose'] + '\nmath.add is function takes value return value' };
  boundary('use calculator from "./calculator.prose"\nuse tools from "./entry.prose"\nprint calculator.add 1, 2', files);
  boundary('use math from "./public/tools.prose"\nprint math.add 1, 2', files);
});

test('forwarding preserves function aliases and methods referring to imported functions', () => {
  const files = {
    './math.prose': 'export function add takes a as number, b as number giving number\n    return a + b',
    './tools.prose': 'use add from "./math.prose"\nexport plus is add\nexport calculator is object add is add'
  };
  const result = compile('use plus, calculator from "./tools.prose"\nprint plus 1, 2, 3\nprint calculator.add 2, 3, 4', reader(files));
  assert.match(result.code, /__prose_call\(_prose_plus, \[1, 2\]/);
  assert.match(result.code, /\[2, 3\].*4\]/);
});

test('late imported counts never turn a returned array into a proved object', () => {
  const files = {
    './math.prose': 'type Calculator is object\n    add as function taking number and number giving number\nexport function create takes ignored giving Calculator\n    return object add is function takes a, b return a + b',
    './tools.prose': 'use create from "./math.prose"\nexport value is create 1, 9'
  };
  boundary('use value from "./tools.prose"\nprint value.add 1, 2', files);
});

test('forwarded declarations reference the exporting module without leaking private types', () => {
  const files = { ...modules, './calculator.prose': [
    'type Value is object', '    amount as number',
    'export calculator is object',
    '    add is function takes left as Value, right as Value giving number return left.amount + right.amount'
  ].join('\n') };
  const result = compile(modules['./public/tools.prose'], reader({ '../calculator.prose': files['./calculator.prose'] }));
  assert.match(result.declarations, /export let math: typeof import\("\.\.\/calculator\.prose"\)\.calculator;/);
  const nested = compile(modules['./entry.prose'], reader(files));
  assert.match(nested.declarations, /"math": typeof import\("\.\/public\/tools\.prose"\)\.math;/);
  assert.doesNotMatch(result.declarations, /left: Value/);
});

test('unresolved circular value forwarding falls back to explicit boundaries', () => {
  const files = {
    './a.prose': 'use other from "./b.prose"\nexport value is other',
    './b.prose': 'use value from "./a.prose"\nexport other is value'
  };
  boundary('use value from "./a.prose"\nprint value.add 1, 2', files);
  assert.doesNotThrow(() => compile('use value from "./a.prose"\nprint value.add with 1, 2', reader(files)));
});

test('forwarding reports missing dependencies and exports without executing imports', () => {
  assert.throws(() => compile('use math from "./public/tools.prose"\nprint math.add 1, 2', reader({ './public/tools.prose': modules['./public/tools.prose'] })), /In.*tools.prose.*Can't read.*calculator.prose/);
  assert.throws(() => compile('use math from "./public/tools.prose"', reader({ ...modules, './calculator.prose': 'export different is 1' })), /doesn't export 'calculator'/);
  assert.doesNotThrow(() => compile('use tools from "./entry.prose"\nprint tools.math.add 1, 2', reader({ ...modules, './calculator.prose': calculator + '\nfail "Do not execute"' })));
});

test('CLI runs a program through a real forwarding module', () => {
  const root = mkdtempSync(join(tmpdir(), 'prose reexports '));
  try {
    for (const [path, text] of Object.entries(modules)) {
      const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
    }
    const main = join(root, 'main.prose');
    writeFileSync(main, 'use tools from "./entry.prose"\nprint tools.math.add 2, 3, 9');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/prose.js', import.meta.url)), main, '--run'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.replaceAll('\r', ''), '[ 5, 9 ]\n');
    assert.equal(readFileSync(join(root, 'calculator.prose'), 'utf8'), calculator);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
