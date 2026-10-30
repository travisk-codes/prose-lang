import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/transpile.js';
import { checkProject } from '../src/check-project.js';
import { format } from '../src/format.js';
import { run } from './run.js';

const ts = createRequire(import.meta.url)('typescript');
function check(source) {
  const root = mkdtempSync(join(tmpdir(), 'prose-generics-'));
  try {
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]}}');
    const file = join(root, 'main.prose'); writeFileSync(file, source);
    return checkProject({ cwd: root, typescript: ts, targets: [file], hoverTargets: [file] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('explicit generics preserve runtime code, inferred generics and call argument counts', () => {
  const body = ' takes value as item, giving item\n    return value\nprint identity 42';
  assert.equal(compile('function identity of item' + body).code, compile('function identity' + body).code);
  assert.deepEqual(run('function pair of left, right takes a as left, b as right\n    return a, b\nprint pair 1, "two"'), [[1, 'two']]);
  const exported = 'export function identity of item as text takes value as item, giving item\n    return value';
  assert.match(compile(exported).declarations, /identity<item extends string>\(value: item\): item/);
  assert.match(compile('use identity from "./identity.prose"\nprint identity "Ada"', { readModule: () => exported }).code, /_prose_identity\("Ada"\)/);
});

test('explicit object and alias parameters keep declaration order and constraints', () => {
  const source = 'export type Box of item as text is object\n    value as item\nexport type Pair of left as text, right as number is (left, right)\nexport function unbox of item as text takes box as Box of item, giving item\n    return box.value';
  const declarations = compile(source).declarations;
  assert.match(declarations, /interface Box<item extends string>/);
  assert.match(declarations, /type Pair<left extends string, right extends number> = \[left, right\]/);
  assert.match(declarations, /unbox<item extends string>\(box: Box<item>\): item/);
  assert.equal(check(source).exitCode, 0);
});

test('bounds validate bodies and reject incompatible inferred call arguments', () => {
  const source = 'function loud of item as text takes value as item, giving text\n    return value.to_upper_case run\nprint loud "Ada"\nprint loud 42';
  const result = check(source);
  assert.deepEqual(result.diagnostics.map(item => [item.line, item.code]), [[4, 2345]]);
  assert.ok(result.hovers.some(item => /function loud of item as text takes value as item giving text/.test(item.code)), JSON.stringify(result.hovers));
  const invalid = check('function identity of item as text takes value as item, giving item\n    return "another value"');
  assert.ok(invalid.diagnostics.some(item => item.code === 2322 && item.line === 2));
});

test('generic lambdas capture outer type parameters and can explicitly shadow them', () => {
  const source = 'function outer of item as text takes value as item, giving item\n    capture is function takes nested as item giving item return nested\n    identity is function of item as number takes nested as item giving item return nested\n    print identity 3\n    return capture value\nprint outer "Ada"';
  assert.equal(check(source).exitCode, 0);
  assert.deepEqual(run(source), [3, 'Ada']);
  const code = compile(source, { check: true }).code;
  assert.match(code, /<item extends number>\(_prose_nested: item\)/);
  assert.match(code, /_prose_capture = \(\(_prose_nested: item\)/);
  const typed = check('function outer of item as text takes value as item\n    convert is function of other as number takes input as other giving item return value\n    return convert 3');
  assert.equal(typed.exitCode, 0, JSON.stringify(typed.diagnostics));
});

test('explicit lists reject duplicate, builtin, uppercase and undeclared placeholders', () => {
  for (const [source, message] of [
    ['function identity of item, item takes value as item\n    return value', /Duplicate type parameter/],
    ['function identity of text takes value as text\n    return value', /lowercase placeholders/],
    ['function identity of T takes value as T\n    return value', /lowercase placeholders/],
    ['function identity of item takes value as other\n    return value', /other.*not declared/],
    ['type Box of item is object\n    value as other', /other.*not declared/],
    ['function identity of item as other takes value as item\n    return value', /other.*not declared/]
  ]) assert.throws(() => compile(source), message);
  assert.doesNotThrow(() => compile('function item takes value\n    return value\nfunction identity of item takes value as item\n    return value'));
});

test('dependent bounds, unions and cyclic constraints are handled by TypeScript', () => {
  assert.equal(check('function identity of item as base, base as text takes value as item, fallback as base, giving base\n    return value').exitCode, 0);
  assert.equal(check('function identity of item as ("day" or "week") takes value as item, giving item\n    return value\nprint identity "day"').exitCode, 0);
  const result = check('function identity of item as item takes value as item\n    return value');
  assert.ok(result.diagnostics.some(item => item.code === 2313 && item.line === 1));
});

test('multiline generic headers format safely and preserve constrained signatures', () => {
  const source = 'export function identity of item as text takes value as item, giving item\n    return value\n';
  const formatted = format(source, { width: 55 });
  assert.equal(format(formatted, { width: 55 }), formatted);
  assert.equal(compile(formatted).declarations, compile(source).declarations);
  const object = 'type Pair of left as text, right as number is object\n    first as left\n    second as right\n';
  assert.equal(compile(format(object, { width: 40 })).declarations, compile(object).declarations);
});
