import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkProject } from '../src/check-project.js';

const ts = createRequire(import.meta.url)('typescript');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prose strict 😀 '));
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  write('tsconfig.json', '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]},"include":["*.prose"]}');
  return { root, write, check: (file, extra = {}) => checkProject({ cwd: root, targets: [file], typescript: ts, ...extra }), close: () => rmSync(root, { recursive: true, force: true }) };
}
const boundary = result => result.diagnostics.filter(item => String(item.code).startsWith('PROSE_UNCHECKED_'));

test('strict checks are opt-in and report parameters, return contracts and value exports', () => {
  const f = fixture(), source = 'function echo takes value\n    return value\nexport function answer\n    return 42\nexport cache is object count is 1';
  try {
    const file = f.write('main.prose', source);
    assert.equal(f.check(file).exitCode, 0);
    const result = f.check(file, { strict: true });
    assert.equal(result.strict, true);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(boundary(result).map(({ code, line, column }) => [code, line, column]), [
      ['PROSE_UNCHECKED_PARAMETER', 1, 21], ['PROSE_UNCHECKED_RETURN', 3, 17], ['PROSE_UNCHECKED_EXPORT', 5, 8]
    ]);
    assert.equal(readFileSync(file, 'utf8'), source);
    assert.doesNotMatch(JSON.stringify(boundary(result)), /__prose_|_prose_|__Prose/);
  } finally { f.close(); }
});

test('concrete contextual parameters, generic identities, unknown and native types pass', () => {
  const f = fixture(), source = [
    'function identity takes value as item giving item', '    return value',
    'function inspect takes value as unknown', '    return value',
    'values is 1, 2', 'doubled is values.map function takes entry return entry * 2',
    'export function today takes date as Date giving number', '    return date:get_full_year run',
    'export dates as list of Date is (new Date,)',
    'export counts as map from text to number is new Map',
    'export add as function taking number and number giving number is',
    '    function takes left, right return left + right'
  ].join('\n');
  try {
    const result = f.check(f.write('main.prose', source), { strict: true });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.exitCode, 0);
  } finally { f.close(); }
});

test('nested and aliased any is found in recursive contracts and list parameters', () => {
  const f = fixture(), source = [
    'type Safe is object', '    count as number', '    next as maybe Safe',
    'type Unsafe is object', '    payload as any', '    next as maybe Unsafe',
    'type Batch is list of any', 'function first takes values as Batch', '    return values.1',
    'export good as Safe is object count is 1, next is unset',
    'export bad as Unsafe is object payload is 1, next is unset',
    'export function unsafe giving list of any', '    return 1, 2'
  ].join('\n');
  try {
    const result = f.check(f.write('main.prose', source), { strict: true });
    assert.deepEqual(boundary(result).map(({ code, line }) => [code, line]), [
      ['PROSE_UNCHECKED_PARAMETER', 8], ['PROSE_UNCHECKED_EXPORT', 11], ['PROSE_UNCHECKED_RETURN', 12]
    ]);
  } finally { f.close(); }
});

test('private fields and inherited native implementation members do not contaminate public contracts', () => {
  const f = fixture();
  try {
    f.write('types.d.ts', 'export class Store extends Date { private cache: any; protected hidden: any; count: number; }\nexport function create(): Store;');
    const file = f.write('main.prose', 'use type Store from "./types"\nuse create from "./types"\nexport store as Store is create run');
    assert.deepEqual(f.check(file, { strict: true }).diagnostics, []);
  } finally { f.close(); }
});

test('strict checks follow closed Prose dependencies and fresh unsaved contracts', () => {
  const f = fixture();
  try {
    const child = f.write('child.prose', 'export function answer\n    return 42');
    f.write('child.d.prose.ts', 'export function answer(): number;');
    const main = f.write('main.prose', 'use answer from "./child.prose"\nprint answer run\nfail "Do not execute"');
    const result = f.check(main, { strict: true });
    assert.equal(result.files.length, 2);
    assert.deepEqual(boundary(result).map(({ file, code }) => [file, code]), [[child, 'PROSE_UNCHECKED_RETURN']]);
    const updated = f.check(main, { strict: true, overlays: [[child, 'export function answer giving number\n    return 42']] });
    assert.equal(updated.exitCode, 0);
    assert.deepEqual(boundary(updated), []);
    assert.equal(readFileSync(child, 'utf8'), 'export function answer\n    return 42');
  } finally { f.close(); }
});

test('wrapped untyped parameters retain Prose ranges and unresolved types keep ordinary diagnostics', () => {
  const f = fixture(), source = ['"😀"', 'export function sample takes', '\tfirst as number,', '\traw_input,', 'giving number', '\treturn first', 'function broken takes value as Missing', '    return value'].join('\r\n');
  try {
    const result = f.check(f.write('main.prose', source), { strict: true });
    assert.deepEqual(boundary(result).map(({ code, line, column }) => [code, line, column]), [['PROSE_UNCHECKED_PARAMETER', 4, 2]]);
    assert.ok(result.diagnostics.some(item => item.code === 2304));
  } finally { f.close(); }
});

test('async export return contracts are checked through Promise type arguments', () => {
  const f = fixture();
  try {
    const file = f.write('main.prose', 'export function load\n    return wait for Promise.resolve 1');
    const result = f.check(file, { strict: true });
    assert.deepEqual(boundary(result).map(item => item.code), ['PROSE_UNCHECKED_RETURN']);
    const fixed = f.check(file, { strict: true, overlays: [[file, 'export function load giving number\n    return wait for Promise.resolve 1']] });
    assert.deepEqual(fixed.diagnostics, []);
  } finally { f.close(); }
});
