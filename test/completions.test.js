import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { completeProject } from '../src/check-completion.js';
import { completionContext } from '../src/completions.js';

const ts = createRequire(import.meta.url)('typescript');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prose completion 😀 '));
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  write('tsconfig.json', '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]},"include":["*.prose","*.ts"]}');
  return { root, write, complete(marked, extra = {}) {
    const offset = marked.indexOf('|'); assert.ok(offset >= 0);
    const source = marked.slice(0, offset) + marked.slice(offset + 1), before = source.slice(0, offset).split(/\r?\n/);
    const file = write('main.prose', source), completion = { file, line: before.length, column: before.at(-1).length + 1 };
    const result = completeProject({ cwd: root, typescript: ts, completion, ...extra });
    assert.equal(readFileSync(file, 'utf8'), source);
    return result;
  }, close: () => rmSync(root, { recursive: true, force: true }) };
}
const item = (result, label) => { const found = result.items.find(item => item.label === label); assert.ok(found, 'Missing completion: ' + label); return found; };

test('object fields complete after dots and colons on unfinished standalone lines', () => {
  const f = fixture();
  try {
    for (const accessor of ['.', ':']) {
      const result = f.complete('book is object title is "Prose", pages is 12\nbook' + accessor + '|');
      assert.equal(result.exitCode, 0);
      assert.equal(item(result, 'title').insertText, 'title');
      assert.match(item(result, 'pages').detail, /pages as number/);
    }
    const result = f.complete('book is object title is "Prose"\nprint book.t|itle');
    assert.equal(item(result, 'title').startColumn, 12);
    assert.equal(item(result, 'title').endColumn, 17);
  } finally { f.close(); }
});

test('native methods use round-trippable Prose spellings and keep signatures', () => {
  const f = fixture();
  try {
    const result = f.complete('word is "hello"\nprint word.to_|');
    assert.equal(item(result, 'to_upper_case').insertText, 'to_upper_case');
    assert.match(item(result, 'to_upper_case').detail, /function to_upper_case.*giving text/);
    assert.equal(item(f.complete('date is new Date\ndate:|'), 'to_iso_string').insertText, 'to_iso_string');
    assert.equal(item(f.complete('Intl:|'), 'DateTimeFormat').insertText, 'DateTimeFormat');
  } finally { f.close(); }
});

test('exact JSON-style keys use computed strings instead of changing their spelling', () => {
  const f = fixture();
  try {
    f.write('types.ts', 'export interface User { user_id: string; userId: number; "given name": string; }');
    const result = f.complete('use type User from "./types"\nuser as User is JSON.parse "{}"\nuser:|');
    assert.equal(item(result, '("user_id")').insertText, '("user_id")');
    assert.equal(item(result, 'user_id').insertText, 'user_id');
    assert.equal(item(result, '("given name")').insertText, '("given name")');
  } finally { f.close(); }
});

test('numeric and unknown index variables use the colon escape for selected methods', () => {
  const f = fixture();
  try {
    const source = 'map is 1\nwords is "one", "two"\nwords.ma|';
    const escaped = item(f.complete(source), 'map');
    assert.equal(escaped.insertText, ':map');
    assert.equal(escaped.startColumn, 6);
    assert.equal(escaped.filterText, '.map');
    assert.match(escaped.documentation, /visible variable/);
    assert.equal(item(f.complete(source.replace('words.ma|', 'words:ma|')), 'map').insertText, 'map');
    assert.equal(item(f.complete('function show takes map\n    words is "one", "two"\n    words.ma|'), 'map').insertText, ':map');
    assert.equal(item(f.complete('map is "name"\nwords is "one", "two"\nwords.ma|'), 'map').insertText, 'map');
    assert.equal(item(f.complete('map is function takes value return value\nwords is "one", "two"\nwords.ma|'), 'map').insertText, 'map');
  } finally { f.close(); }
});

test('callbacks, chained receivers, assignment targets and existing arguments retain receiver inference', () => {
  const f = fixture();
  try {
    assert.ok(item(f.complete('books is (object title is "A", pages is 12), (object title is "B", pages is 20)\nlabels is books.map function takes book\n    return book.|'), 'title'));
    assert.ok(item(f.complete('state is object book is object title is "A"\nstate.book.|'), 'title'));
    assert.ok(item(f.complete('book is object pages is 12\nbook.pa|ges is 13'), 'pages'));
    assert.ok(item(f.complete('word is "abc"\nprint word.sl|ice with 0, 2'), 'slice'));
    assert.ok(item(f.complete('word is "abc"\nprint word.sl|ice 0, 2'), 'slice'));
    assert.ok(item(f.complete('words is "one", "two"\nwords.1.|'), 'to_upper_case'));
    assert.ok(item(f.complete('book is object pages is 12\nbook.("pages").|'), 'to_fixed'));
    assert.ok(item(f.complete('books is (object title is "A"), (object title is "B")\nfor each book in books\n    print book.|'), 'title'));
  } finally { f.close(); }
});

test('invalid contexts, unchecked receivers and unrelated syntax errors do not yield guessed members', () => {
  const f = fixture();
  try {
    for (const marked of ['print "book.|"', 'print pattern "book.|"', 'value is 12.|5', 'value as Intl:|', 'type Value is Intl:|']) {
      const offset = marked.indexOf('|'), source = marked.replace('|', '');
      assert.equal(completionContext(source, 1, offset + 1), undefined, marked);
    }
    assert.deepEqual(f.complete('function inspect takes value\n    return value.|').items, []);
    assert.deepEqual(f.complete('broken is (\nbook is object title is "A"\nbook.|').items, []);
  } finally { f.close(); }
});

test('current imported buffers and UTF-16 replacement positions work without writes or execution', () => {
  const f = fixture();
  try {
    const child = f.write('child.prose', 'export function book giving text\n    return "saved"');
    const source = 'use book from "./child.prose"\nvalue is book run\nprint "😀", value.|';
    const changed = 'export type Book is object\n    pages as number\nexport function book giving Book\n    return object pages is 12';
    const result = f.complete(source, { overlays: [[child, changed]] });
    assert.equal(item(result, 'pages').startColumn, 19);
    assert.match(readFileSync(child, 'utf8'), /giving text/);
    assert.doesNotThrow(() => JSON.stringify(result));
  } finally { f.close(); }
});
