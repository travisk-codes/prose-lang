import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { refactorProject } from '../src/check-refactor.js';
import { compile } from '../src/transpile.js';
const ts = createRequire(import.meta.url)('typescript');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prose rename 😀 '));
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  write('tsconfig.json', '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]},"include":["*.prose","*.ts"]}');
  return { root, write, query(marked, extra = {}, overlays = []) {
    const offset = marked.indexOf('|'); assert.ok(offset >= 0);
    const source = marked.replace('|', ''), before = source.slice(0, offset).split(/\r?\n/);
    const file = write('main.prose', source);
    const result = refactorProject({ cwd: root, typescript: ts, refactor: { file, line: before.length, column: before.at(-1).length + 1, ...extra }, overlays });
    assert.equal(readFileSync(file, 'utf8'), source);
    assert.doesNotThrow(() => JSON.stringify(result));
    return { result, source, file };
  }, close: () => rmSync(root, { recursive: true, force: true }) };
}
function changed({ source, result }) {
  assert.equal(result.renameError, undefined);
  assert.ok(result.edits?.length);
  for (const edit of [...result.edits].sort((a, b) => b.line - a.line || b.column - a.column)) {
    const rows = source.split('\n'), row = rows[edit.line - 1];
    rows[edit.line - 1] = row.slice(0, edit.column - 1) + edit.newText + row.slice(edit.endColumn - 1);
    source = rows.join('\n');
  }
  return source;
}
function output(source) { const lines = []; runInNewContext(compile(source).code, { console: { log: value => lines.push(JSON.stringify(value)) } }); return lines; }

test('references include assignments and repeated reads, with declaration filtering', () => {
  const f = fixture();
  try {
    const source = 'co|unt is 1\ncount is count + count\nprint count';
    assert.equal(f.query(source).result.references.length, 5);
    assert.equal(f.query(source, { includeDeclaration: false }).result.references.length, 4);
    const query = f.query(source, { newName: 'total' });
    assert.equal(changed(query), 'total is 1\ntotal is total + total\nprint total');
    assert.deepEqual(output(changed(query)), output(query.source));
  } finally { f.close(); }
});

test('parameters, lexical shadowing and captured variables retain binding identity', () => {
  const f = fixture();
  try {
    const source = 'value is 99\nfunction outer takes va|lue\n    transform is function takes value return value + 1\n    capture is function takes delta return value + delta\n    return capture (transform value)\nprint outer 2';
    const query = f.query(source, { newName: 'input' }), edited = changed(query);
    assert.equal(query.result.references.length, 3);
    assert.match(edited, /function outer takes input/);
    assert.match(edited, /takes value return value \+ 1/);
    assert.match(edited, /return input \+ delta/);
    assert.deepEqual(output(edited), output(query.source));
    const generic = f.query('function choose takes value as T, T| as number, giving number\n    return T\nprint choose "hi", 2', { newName: 'count' });
    assert.equal(generic.result.references.length, 2);
    assert.match(changed(generic), /value as T, count as number/);
    assert.deepEqual(output(changed(generic)), output(generic.source));
  } finally { f.close(); }
});

test('local named functions support forward calls, recursion and function-value aliases', () => {
  const f = fixture();
  try {
    const source = 'print down 2\nfunction do|wn takes number\n    if number = 0 then return 0\n    return down (number - 1)\naction is down\nprint action 2';
    const query = f.query(source, { newName: 'count_down' });
    assert.equal(query.result.references.length, 4);
    assert.deepEqual(output(changed(query)), output(query.source));
  } finally { f.close(); }
});

test('loop indexes, destructuring and exception bindings use their function scope', () => {
  const f = fixture();
  try {
    const loop = f.query('items is 10, 20\nfor i| is 1 to 2\n    print items.i\nprint items:("i")', { newName: 'position' });
    assert.equal(loop.result.references.length, 2);
    assert.match(changed(loop), /items.position\nprint items:\("i"\)/);
    const destructured = f.query('items is 1, 2\nfirst, se|cond are items\nprint second + second', { newName: 'last' });
    assert.equal(destructured.result.references.length, 3);
    assert.deepEqual(output(changed(destructured)), output(destructured.source));
    const caught = f.query('try\n    fail "expected"\non error pr|oblem\n    print problem.message', { newName: 'error' });
    assert.equal(caught.result.references.length, 2);
    assert.deepEqual(output(changed(caught)), output(caught.source));
  } finally { f.close(); }
});

test('object shorthand expands to preserve the original property key', () => {
  const f = fixture();
  try {
    const query = f.query('na|me is "Ada"\nrecord is object name, nested is object name\nprint record.name\nprint record.nested.name', { newName: 'person_name' });
    assert.equal(query.result.references.length, 3);
    assert.match(changed(query), /object name is person_name, nested is object name is person_name/);
    assert.deepEqual(output(changed(query)), output(query.source));
    const body = f.query('na|me is "Ada"\nrecord is object\n    name is name\nprint record.name', { newName: 'person_name' });
    assert.deepEqual(output(changed(body)), output(body.source));
  } finally { f.close(); }
});

test('same-named object properties, strings, comments and colon properties stay literal', () => {
  const f = fixture();
  try {
    const query = f.query('pa|ges is 99\nbook is object pages is 500\nprint book.pages\nprint book:pages\n"pages"\nprint "pages", pages', { newName: 'count' });
    assert.equal(query.result.references.length, 2);
    assert.deepEqual(output(changed(query)), output(query.source));
    assert.ok(f.query('pages is 99\nbook is object pages is 500\nprint book.pa|ges').result.renameError);
  } finally { f.close(); }
});

test('rename rejects collisions, closure capture, globals and new contextual dot indexes', () => {
  const f = fixture();
  try {
    for (const [source, name] of [
      ['co|unt is 1\ntotal is 2\nprint count + total', 'total'],
      ['va|lue is 2\nfunction read takes input\n    return value + input', 'input'],
      ['co|unt is 2\nprint Math.PI\nprint count', 'Math'],
      ['co|unt is 2\nwords is "one", "two"\nprint words.length\nprint count', 'length'],
      ['co|unt is 2\nwords is "one", "two"\nprint words.slice\nprint count', 'slice'],
      ['co|unt is 2\nprint count', 'if'],
      ['co|unt is 2\nprint count', 'two words'],
    ]) {
      const { result } = f.query(source, { newName: name });
      assert.ok(result.renameError, name); assert.equal(result.edits, undefined);
    }
  } finally { f.close(); }
});

test('ambiguous dots block rename while explicit index expressions are supported', () => {
  const f = fixture();
  try {
    const result = f.query('function read takes items, in|dex as number\n    return items.index', { newName: 'position' }).result;
    assert.match(result.renameError, /dot/); assert.equal(result.edits, undefined);
    const explicit = f.query('function read takes items, in|dex as number\n    return items.(index)', { newName: 'position' });
    assert.match(changed(explicit), /items.\(position\)/);
    assert.match(f.query('function read takes items as object\n    in|dex is 1\n    return items.index', { newName: 'position' }).result.renameError, /dot/);
    assert.match(f.query('items is 10, 20\nin|dex as Number is 1\nprint items.index', { newName: 'position' }).result.renameError, /dot/);
    f.write('types.ts', 'export class Numbers extends Array<number> {}');
    const derived = f.query('use Numbers from "./types"\nitems is new Numbers with 10, 20\nin|dex is 1\nprint items.index', { newName: 'position' });
    assert.match(changed(derived), /items.position/);
  } finally { f.close(); }
});

test('imports and exports have local references but cannot be renamed yet', () => {
  const f = fixture();
  try {
    const dependency = f.write('child.prose', 'export function action takes value\n    return value');
    const imported = f.query('use ac|tion from "./child.prose"\nprint action 1').result;
    assert.equal(imported.references.length, 2); assert.match(imported.renameError, /imported/);
    const exported = f.query('export co|unt is 1\nprint count').result;
    assert.equal(exported.references.length, 2); assert.match(exported.renameError, /exported/);
    const parameter = f.query('export function action takes va|lue\n    return value', { newName: 'input' });
    assert.match(changed(parameter), /takes input/);
    assert.equal(readFileSync(dependency, 'utf8'), 'export function action takes value\n    return value');
  } finally { f.close(); }
});

test('UTF-16 positions, wrapped headers and current buffers preserve source bytes', () => {
  const f = fixture();
  try {
    const query = f.query('function greet takes\r\n\tna|me as text,\r\ngiving text\r\n\treturn "😀" + name\r\nprint greet "Ada"', { newName: 'person' });
    assert.match(changed(query), /\r\n\treturn "😀" \+ person\r\n/);
    const file = join(f.root, 'main.prose');
    const overlay = 'title is "New"\nprint title\nfail "Do not execute"';
    const result = refactorProject({ cwd: f.root, typescript: ts, refactor: { file, line: 1, column: 2, newName: 'label' }, overlays: [[file, overlay]] });
    assert.equal(result.edits.length, 2);
    assert.equal(readFileSync(file, 'utf8'), query.source);
    assert.ok(f.query('co|unt is (').result.renameError);
  } finally { f.close(); }
});
