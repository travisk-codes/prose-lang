import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { refactorProject } from '../src/check-refactor.js';
import { checkProject } from '../src/check-project.js';
const ts = createRequire(import.meta.url)('typescript');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prose project rename 😀 ')), saved = new Map();
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); saved.set(file, source); return file; };
  write('tsconfig.json', '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]},"include":["*.prose","*.ts"]}');
  return { root, saved, write, query(file, needle, newName, overlays = [], includeDeclaration = true) {
    const source = overlays.find(([name]) => name === file)?.[1] ?? readFileSync(file, 'utf8');
    const offset = source.indexOf(needle) + 1; assert.ok(offset > 0, needle);
    const before = source.slice(0, offset).split(/\r?\n/);
    const result = refactorProject({ cwd: root, typescript: ts, overlays, refactor: { file, line: before.length, column: before.at(-1).length + 1, ...(newName === undefined ? {} : { newName }), includeDeclaration } });
    for (const [name, text] of saved) assert.equal(readFileSync(name, 'utf8'), text);
    assert.doesNotThrow(() => JSON.stringify(result)); return result;
  }, apply(result, overlays = []) {
    assert.equal(result.renameError, undefined); assert.ok(result.edits?.length);
    const changed = new Map(overlays);
    for (const file of new Set(result.edits.map(item => item.file))) {
      const rows = (changed.get(file) ?? readFileSync(file, 'utf8')).split('\n');
      for (const item of result.edits.filter(item => item.file === file).sort((a,b) => b.line-a.line || b.column-a.column)) rows[item.line-1] = rows[item.line-1].slice(0,item.column-1) + item.newText + rows[item.line-1].slice(item.endColumn-1);
      changed.set(file, rows.join('\n'));
    }
    const checked = checkProject({ cwd: root, typescript: ts, targets: [...changed.keys()].filter(file => file.endsWith('.prose')), overlays: [...changed] });
    assert.equal(checked.exitCode, 0, JSON.stringify(checked.diagnostics)); return changed;
  }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('exported snake_case functions rename across closed direct consumers from either side of an import', () => {
  const f = fixture();
  try {
    const library = f.write('library.prose', 'export function next_day takes key as text, giving text\n    return key');
    const first = f.write('first.prose', 'use next_day from "./library.prose"\nprint next_day "today"');
    const second = f.write('second.prose', 'use next_day from "./library.prose"\nprint "😀", next_day "tomorrow"');
    f.write('library.d.prose.ts', 'export declare function nextDay(): never;');
    const result = f.query(library, 'next_day', 'following_day');
    assert.equal(result.references.length, 5); assert.equal(result.edits.length, 5);
    assert.equal(new Set(result.edits.map(item => item.file)).size, 3);
    const changed = f.apply(result);
    assert.match(changed.get(first), /use following_day.*\nprint following_day/s);
    assert.match(changed.get(second), /print "😀", following_day/);
    assert.equal(f.query(first, 'next_day', undefined, [], false).references.length, 2);
    const fromImport = f.query(second, 'next_day', 'following_day');
    assert.deepEqual(fromImport.edits, result.edits);
  } finally { f.close(); }
});

test('exported values preserve shorthand keys, scoped parameters and unrelated modules', () => {
  const f = fixture();
  try {
    const library = f.write('library.prose', 'export count is 12');
    const consumer = f.write('consumer.prose', 'use count from "./library.prose"\nrecord is object count\nfunction local takes count\n    return count\nprint count, record.count');
    f.write('other.prose', 'export count is 99');
    f.write('other-user.prose', 'use count from "./other.prose"\nprint count');
    const result = f.query(consumer, 'count', 'total'), changed = f.apply(result);
    assert.equal(result.edits.length, 4); assert.equal(changed.size, 2);
    assert.match(changed.get(library), /export total/);
    assert.match(changed.get(consumer), /object count is total/);
    assert.match(changed.get(consumer), /takes count\n    return count/);
    assert.match(changed.get(consumer), /print total, record.count/);
  } finally { f.close(); }
});

test('wrapped imports and unsaved or new consumer buffers participate without saving', () => {
  const f = fixture();
  try {
    const library = f.write('library.prose', 'export count is 1\nexport other is 2');
    const consumer = f.write('consumer.prose', 'print "saved"');
    const newlyCreated = join(f.root, 'new.prose');
    const overlays = [[consumer, 'use count,\r\n    other from "./library.prose"\r\nprint "😀", count + other'], [newlyCreated, 'use count from "./library.prose"\nprint count\nfail "Do not execute"']];
    const result = f.query(library, 'count', 'total', overlays), changed = f.apply(result, overlays);
    assert.equal(result.edits.length, 5);
    assert.match(changed.get(consumer), /use total,\r\n/);
    assert.match(changed.get(newlyCreated), /print total/);
  } finally { f.close(); }
});

test('consumer collisions, closure capture, export spelling collisions and new dot indexes reject every edit', () => {
  const f = fixture();
  try {
    const library = f.write('library.prose', 'export count is 1\nexport total_count is 2');
    for (const [source, name] of [
      ['use count from "./library.prose"\ntotal is 2\nprint count + total', 'total'],
      ['use count from "./library.prose"\nfunction read takes total\n    return count + total', 'total'],
      ['use count from "./library.prose"\nwords is "a", "b"\nprint words.slice, count', 'slice'],
      ['use count from "./library.prose"\nprint count', 'totalCount'],
    ]) {
      f.write('consumer.prose', source);
      const result = f.query(library, 'count', name);
      assert.ok(result.renameError, name); assert.equal(result.edits, undefined);
    }
  } finally { f.close(); }
});

test('unrelated malformed bodies are ignored but malformed connected consumers block rename', () => {
  const f = fixture();
  try {
    const library = f.write('library.prose', 'export count is 1');
    f.write('broken.prose', 'broken is "unfinished');
    assert.equal(f.query(library, 'count', 'total').edits.length, 1);
    f.write('consumer.prose', 'use count from "./library.prose"\nbroken is "unfinished');
    const result = f.query(library, 'count', 'total');
    assert.ok(result.renameError); assert.equal(result.edits, undefined);
  } finally { f.close(); }
});

test('known JavaScript, TypeScript, namespace, dynamic and re-export consumers prevent partial rename', () => {
  const f = fixture();
  try {
    const library = f.write('library.prose', 'export count is 1');
    f.write('consumer.prose', 'use count from "./library.prose"\nprint count');
    for (const source of ['import { count } from "./library.prose";', 'export { count } from "./library.prose";', 'import * as library from "./library.prose";', 'const library = import("./library.prose");', 'const library = require("./library.prose");']) {
      f.write('bridge.ts', source);
      const result = f.query(library, 'count', 'total');
      assert.match(result.renameError, /unsupported import or re-export/); assert.equal(result.edits, undefined);
      assert.equal(result.references.length, 3);
    }
  } finally { f.close(); }
});

test('project path aliases are recognized as unsupported consumers of the same export', () => {
  const f = fixture();
  try {
    f.write('tsconfig.json', '{"compilerOptions":{"moduleResolution":"bundler","paths":{"@library":["./library.prose"]}},"include":["*.prose","*.ts"]}');
    const library = f.write('library.prose', 'export count is 1');
    f.write('consumer.prose', 'use count from "@library"\nprint count');
    const result = f.query(library, 'count', 'total');
    assert.match(result.renameError, /unsupported import/); assert.equal(result.edits, undefined);
  } finally { f.close(); }
});

test('nested projects and ignored output stay outside the refactoring boundary', () => {
  const f = fixture();
  try {
    const library = f.write('library.prose', 'export count is 1');
    f.write('nested/tsconfig.json', '{}');
    f.write('nested/consumer.prose', 'use count from "../library.prose"\nprint count');
    f.write('dist/consumer.prose', 'use count from "../library.prose"\nprint count');
    const result = f.query(library, 'count', 'total');
    assert.equal(result.references.length, 1); assert.equal(result.edits.length, 1);
    assert.ok(result.projectSnapshot.files.every(item => !/[\\/]dist[\\/]|[\\/]nested[\\/]/.test(item.file)));
  } finally { f.close(); }
});
