import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkProject } from '../src/check-project.js';

const ts = createRequire(import.meta.url)('typescript');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prose any hover 😀 '));
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  write('tsconfig.json', '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]}}');
  return { root, write, check: (file, extra = {}) => checkProject({ cwd: root, targets: [file], hoverTargets: [file], typescript: ts, ...extra }), close: () => rmSync(root, { recursive: true, force: true }) };
}
function notes(result, source, needle, word) {
  const offset = source.indexOf(needle) + needle.lastIndexOf(word);
  const lines = source.slice(0, offset).split(/\r?\n/);
  const item = result.hovers.find(item => item.line === lines.length && item.column === lines.at(-1).length + 1);
  assert.ok(item, 'Missing hover: ' + needle);
  return (item.notes ?? []).join('\n');
}

test('any origins follow untyped parameters through aliases and local return values', () => {
  const f = fixture(), source = 'function forward takes raw_input\n    copy is raw_input\n    return copy\nresult is forward 3\nprint result';
  try {
    const result = f.check(f.write('main.prose', source));
    assert.deepEqual(result.diagnostics, []);
    for (const [needle, word] of [['takes raw_input', 'raw_input'], ['copy is', 'copy'], ['print result', 'result'], ['function forward', 'forward']]) {
      assert.match(notes(result, source, needle, word), /Parameter "raw_input" has no type annotation/);
    }
    assert.doesNotMatch(JSON.stringify(result.hovers), /__prose_|_prose_|__Prose/);
  } finally { f.close(); }
});

test('library any, explicit annotations, and placeholders have distinct explanations', () => {
  const f = fixture(), source = [
    'data is JSON.parse "{}"', 'alias is data', 'print alias.user_id',
    'explicit as any is 3', 'print explicit', 'empty is array', 'print empty',
    'object_value is object', 'print object_value', 'draft', 'print draft',
    'record is object pending is unset', 'print record.pending'
  ].join('\n');
  try {
    const result = f.check(f.write('main.prose', source));
    assert.deepEqual(result.diagnostics, []);
    assert.match(notes(result, source, 'data is', 'data'), /JavaScript library function "JSON.parse" specifies any/);
    assert.match(notes(result, source, 'alias.user_id', 'user_id'), /"userId".*Unchecked type.*JSON.parse/s);
    assert.match(notes(result, source, 'print explicit', 'explicit'), /declared type explicitly includes/);
    assert.match(notes(result, source, 'print empty', 'empty'), /List element: An empty-list placeholder/);
    assert.match(notes(result, source, 'print object_value', 'object_value'), /empty-object placeholder/);
    assert.match(notes(result, source, 'print draft', 'draft'), /unset or null placeholder/);
    assert.match(notes(result, source, 'record.pending', 'pending'), /unset or null placeholder/);
  } finally { f.close(); }
});

test('imports explain unannotated Prose export contracts and typed overlays remove the note', () => {
  const f = fixture(), source = 'use answer, value from "./child.prose"\nresult is answer run\nprint result\nprint value';
  try {
    const child = f.write('child.prose', 'export function answer\n    return 42\nexport value is object count is 1');
    const file = f.write('main.prose', source), result = f.check(file);
    assert.match(notes(result, source, 'print result', 'result'), /Imported Prose function "answer" has no giving return annotation/);
    assert.match(notes(result, source, 'print value', 'value'), /Imported Prose value "value" has no declared export type/);
    const updated = f.check(file, { overlays: [[child, 'export function answer giving number\n    return 42\nexport value as number is 1']] });
    assert.doesNotMatch(notes(updated, source, 'print result', 'result'), /Unchecked type/);
    assert.doesNotMatch(notes(updated, source, 'print value', 'value'), /Unchecked type/);
    assert.match(readFileSync(child, 'utf8'), /export function answer\n/);
  } finally { f.close(); }
});

test('unknown, contextual inference, and shadowed JavaScript names are not mislabeled', () => {
  const f = fixture(), source = [
    'function safe takes value as unknown', '    print value', '    return value.field',
    'function identity takes value as number giving number', '    return value',
    'items is 1, 2', 'doubled is items.map function takes item return item * 2',
    'JSON is object parse is function takes text as text giving number return 3',
    'value is JSON.parse "{}"', 'print value',
    'empty is array', 'copied is empty.map function takes entry return entry'
  ].join('\n');
  try {
    const result = f.check(f.write('main.prose', source));
    assert.deepEqual(result.diagnostics, []);
    assert.doesNotMatch(notes(result, source, 'print value\n    return', 'value'), /Unchecked type/);
    assert.match(notes(result, source, 'value.field', 'field'), /receiver is unknown/);
    assert.doesNotMatch(notes(result, source, 'function identity', 'identity'), /Unchecked type/);
    assert.doesNotMatch(notes(result, source, 'takes item', 'item'), /Unchecked type/);
    assert.doesNotMatch(notes(result, source, 'print value\nempty', 'value'), /Unchecked type|library/);
    assert.match(notes(result, source, 'takes entry', 'entry'), /receives any from its contextual function type/);
  } finally { f.close(); }
});

test('several writes and recursive types use bounded, honest fallback explanations', () => {
  const f = fixture(), source = [
    'value is JSON.parse "{}"', 'value is JSON.parse "[]"', 'print value',
    'narrowed is JSON.parse "{}"', 'narrowed is 1', 'print narrowed',
    'function recursive takes input', '    if input return recursive input', '    return input',
    'result is recursive false', 'print result'
  ].join('\n');
  try {
    const file = f.write('main.prose', source), result = f.check(file);
    assert.match(notes(result, source, 'print value', 'value'), /several assignments/);
    assert.doesNotMatch(notes(result, source, 'print narrowed', 'narrowed'), /Unchecked type/);
    assert.ok(result.hovers.length);
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.deepEqual(result.diagnostics, f.check(file, { hoverTargets: [] }).diagnostics);
  } finally { f.close(); }
});

test('nested explicit any and unresolved annotations do not become missing-annotation claims', () => {
  const f = fixture(), source = [
    'function first takes values as list of any', '    return values.1',
    'callback is function takes value as any giving any return value',
    'function apply takes action as function taking any giving any', '    return action 1',
    'function broken takes value as Missing', '    return value',
    'use external from "./external"', 'print external'
  ].join('\n');
  try {
    f.write('external.d.ts', 'export const external: any;');
    const result = f.check(f.write('main.prose', source));
    assert.match(notes(result, source, 'takes values', 'values'), /declared type of parameter "values" includes any/);
    assert.match(notes(result, source, 'takes action', 'action'), /function type explicitly includes any/);
    assert.match(notes(result, source, 'takes value as Missing', 'value'), /annotation could not be resolved/);
    assert.match(notes(result, source, 'print external', 'external'), /declared type explicitly includes/);
    assert.doesNotMatch(notes(result, source, 'callback is', 'callback'), /_prose_|__Prose|no type annotation/);
    assert.ok(result.diagnostics.length);
  } finally { f.close(); }
});
