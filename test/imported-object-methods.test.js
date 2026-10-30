import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile, parse } from '../src/transpile.js';
import { format } from '../src/format.js';

const tools = [
  'export calculator is object',
  '    add is function takes left as number, right as number giving number return left + right',
  '    zero is function giving number return 0',
  'export alias is calculator', 'export nested is object math is calculator'
].join('\n');
const options = source => ({ readModule: () => source });
const boundary = (source, module = tools) => assert.throws(() => compile(source, options(module)), error => error.code === 'PROSE_CALL_BOUNDARY', source);

test('imported object methods retain fixed counts and ordinary explicit calls', () => {
  const prefix = 'use calculator from "./tools.prose"\n';
  for (const key of ['calculator.add', 'calculator:add', 'calculator.("add")']) {
    const source = prefix + `print ${key} 2, 3, 9`;
    assert.match(compile(source, options(tools)).code, /\[2, 3\].*9\]/);
  }
  assert.doesNotThrow(() => compile(prefix + 'print calculator.add with 2, 3', options(tools)));
  assert.doesNotThrow(() => compile(prefix + 'print calculator.zero run, 9', options(tools)));
  assert.throws(() => compile(prefix + 'print calculator.add run', options(tools)), /takes 2 arguments/);
  assert.throws(() => compile(prefix + 'print calculator.add with 1, 2, 3', options(tools)), /takes 2 arguments/);
  assert.throws(() => compile(prefix + 'print calculator.add 1, 2 + 3', options(tools)), /ambiguous/);
});

test('imported objects support local aliases, nested methods, like copies, and extracted functions', () => {
  const source = [
    'use calculator, nested from "./tools.prose"',
    'copy is calculator', 'print copy.add 1, 2, 3',
    'print nested.math.add 2, 3, 4',
    'spread is object like calculator', 'print spread.add 3, 4, 5',
    'action is calculator.add', 'print action 4, 5, 6'
  ].join('\n');
  assert.match(compile(source, options(tools)).code, /__prose_call\(_prose_action, \[4, 5\]/);
  const formatted = format(source, { ...options(tools), width: 40 });
  const meaning = source => JSON.stringify(parse(source, options(tools)), (key, value) => key === 'line' ? undefined : value);
  assert.equal(meaning(formatted), meaning(source));
  assert.equal(format(formatted, { ...options(tools), width: 40 }), formatted);
});

test('shared exported aliases keep identity across use lines and equivalent relative paths', () => {
  for (const source of [
    'use calculator, alias from "./tools.prose"',
    'use calculator from "./tools.prose"\nuse alias from "./tools.prose"',
    'use calculator from "./tools.prose"\nuse alias from "./sub/../tools.prose"',
    'use calculator, nested from "./tools.prose"\nalias is nested.math'
  ]) boundary(source + '\nalias.add is function takes value return value\nprint calculator.add 1, 2');
  assert.doesNotThrow(() => compile('use calculator, alias from "./tools.prose"\nalias.add is function takes a, b return a * b\nprint calculator.add 1, 2, 3', options(tools)));
  let reads = 0;
  compile('use calculator from "./tools.prose"\nuse alias from "./tools.prose"\nprint alias.add 1, 2', {
    readModule: () => { reads++; return tools; }
  });
  assert.equal(reads, 1);
  const single = tools.replace('left as number, right as number', 'left as number').replace('return left + right', 'return left');
  const distinct = compile('use calculator from "tools.prose"\nuse alias from "./tools.prose"\nprint calculator.add 1, 2\nprint alias.add 3, 4', {
    readModule: path => path === 'tools.prose' ? tools : single
  }).code;
  assert.match(distinct, /\[1, 2\]/);
  assert.match(distinct, /\[3\].*4\]/);
});

test('local writes, unknown keys, and scope shadowing withdraw imported object proofs', () => {
  const prefix = 'use calculator from "./tools.prose"\n';
  for (const change of [
    'calculator.add is function takes value return value\nprint calculator.add 1, 2',
    'key is "add"\ncalculator.(key) is function takes a, b return a + b\nprint calculator.add 1, 2',
    'print calculator.("missing") 1, 2',
    'function apply takes calculator\n    return calculator.add 1, 2',
    'for each calculator in array\n    print calculator.add 1, 2',
    'function apply\n    calculator is JSON.parse "{}"\n    return calculator.add 1, 2'
  ]) boundary(prefix + change);
  assert.doesNotThrow(() => compile(prefix + 'copy is object like calculator\ncopy.add is function takes value return value\nprint calculator.add 1, 2, 3', options(tools)));
});

test('source-module mutation and unknown spreads remain uncertain in importers', () => {
  const source = 'use calculator from "./tools.prose"\nprint calculator.add 1, 2';
  for (const module of [
    tools + '\ncalculator.add is function takes value return value',
    tools + '\nkey is "note"\ncalculator.(key) is 1',
    'unknown is JSON.parse "{}"\nexport calculator is object add is function takes a, b return a + b, like unknown',
    'export calculator is JSON.parse "{}"'
  ]) boundary(source, module);
  assert.doesNotThrow(() => compile(source, options(tools + '\ncalculator.add is function takes a, b return a * b')));
});

test('declared object result types and nested typed fields survive module boundaries', () => {
  const module = [
    'type Binary is function taking number and number giving number',
    'type Calculator is object', '    add as Binary',
    'export function create giving Calculator', '    return object add is function takes a, b return a + b'
  ].join('\n');
  assert.match(compile('use create from "./tools.prose"\ncalculator is create run\nprint calculator.add 1, 2, 3', options(module)).code, /\[1, 2\].*3\]/);
});

test('signature discovery stays text-only and opaque dependency exports stay unknown', () => {
  const module = tools + '\nfail "Do not execute imported code"';
  assert.doesNotThrow(() => compile('use calculator from "./tools.prose"\nprint calculator.add 1, 2', options(module)));
  const opaque = 'use original from "./other.prose"\nexport calculator is original';
  let reads = 0;
  boundary('use calculator from "./tools.prose"\nprint calculator.add 1, 2', opaque);
  compile('use calculator from "./tools.prose"\nprint calculator.add with 1, 2', {
    readModule: path => { assert.equal(path, './tools.prose'); reads++; return opaque; }
  });
  assert.equal(reads, 1);
});

test('CLI runs a real imported-object program with preserved method call boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'prose imported methods '));
  try {
    const module = join(root, 'tools.prose'), main = join(root, 'main.prose');
    writeFileSync(module, tools);
    writeFileSync(main, 'use calculator, nested from "./tools.prose"\nprint calculator.add 2, 3, 9\nprint nested.math.add 4, 5');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/prose.js', import.meta.url)), main, '--run'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.replaceAll('\r', ''), '[ 5, 9 ]\n9\n');
    assert.equal(readFileSync(module, 'utf8'), tools);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
