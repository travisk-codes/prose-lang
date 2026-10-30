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

test('identifier completion keeps Prose spelling, full token ranges and function signatures', () => {
  const f = fixture();
  try {
    const result = f.complete('function cipher takes message as text, rotate as number, giving text\n    return message\nletter_count is 12\nprint cip|her');
    const fn = item(result, 'cipher');
    assert.equal(fn.kind, 'function');
    assert.equal(fn.insertText, 'cipher');
    assert.equal(fn.startColumn, 7); assert.equal(fn.endColumn, 13);
    assert.match(fn.detail, /function cipher takes message as text, rotate as number giving text/);
    assert.equal(item(result, 'letter_count').insertText, 'letter_count');
    assert.equal(item(result, 'letter_count').kind, 'variable');
    assert.ok(!result.items.some(item => /_prose_|__prose_|console|Math/.test(item.label)));
    assert.doesNotThrow(() => JSON.stringify(result));
  } finally { f.close(); }
});

test('identifier scopes respect parameters, captured names, siblings and shadowing', () => {
  const f = fixture();
  try {
    const result = f.complete('shared is "outer"\nfunction hidden takes sibling\n    private_value is 2\n    return sibling\nfunction inspect takes shared as number, callback as function taking text giving text\n    local_value is "local"\n    action is function takes nested\n        return sha|\n    return local_value');
    assert.match(item(result, 'shared').detail, /shared as number/);
    assert.match(item(result, 'shared').documentation, /Parameter/);
    assert.equal(result.items.filter(item => item.label === 'shared').length, 1);
    assert.ok(item(result, 'nested')); assert.ok(item(result, 'local_value'));
    assert.equal(item(result, 'callback').kind, 'function');
    assert.ok(!result.items.some(item => ['sibling', 'private_value'].includes(item.label)));
    const outside = f.complete('function inspect takes inside\n    local_value is 1\n    return inside\nprint ins|');
    assert.ok(!outside.items.some(item => ['inside', 'local_value'].includes(item.label)));
  } finally { f.close(); }
});

test('typed callbacks infer parameter fields and keep captured bindings', () => {
  const f = fixture();
  try {
    const result = f.complete('heading is "Books"\nbooks is (object title is "A", pages is 12), (object title is "B", pages is 20)\nlabels is books.map function takes book\n    return bo|');
    assert.match(item(result, 'book').detail, /title as text/);
    assert.match(item(result, 'book').detail, /pages as number/);
    assert.ok(item(result, 'heading'));
  } finally { f.close(); }
});

test('identifier probes handle blank bodies, empty expressions, loops and forward functions', () => {
  const f = fixture();
  try {
    for (const tail of ['print |', 'value is |', 'print (|)', 'print (ci|', 'type is ci|', 'print ci| "hello", 2']) {
      assert.ok(item(f.complete('function cipher takes text, rotate\n    return text\n' + tail), 'cipher'), tail);
    }
    assert.ok(item(f.complete('function inspect takes input\n    |'), 'input'));
    assert.ok(item(f.complete('for i is 1 to 3\n    print i|'), 'i'));
    assert.ok(item(f.complete('items is 1, 2\nfor each entry in items\n    print en|'), 'entry'));
    assert.ok(item(f.complete('print la|\nfunction later takes value\n    return value'), 'later'));
    assert.ok(item(f.complete('function add takes left, right\n    return left + right\ncount is 2\nprint add co|'), 'count'));
  } finally { f.close(); }
});

test('constructor positions and user names resembling probes retain the real scope', () => {
  const f = fixture();
  try {
    f.write('types.ts', 'export class Widget { constructor(public title: string) {} }');
    const result = f.complete('use Widget from "./types"\n__prose_identifier_probe_0 is 2\nvalue is new Wid|get "Hello"');
    assert.equal(item(result, 'Widget').insertText, 'Widget');
    assert.ok(item(result, '__prose_identifier_probe_0'));
    assert.ok(!result.items.some(item => item.label === '__prose_identifier_probe_1'));
  } finally { f.close(); }
});

test('function values, aliases and already imported values complete from current overlays', () => {
  const f = fixture();
  try {
    const child = f.write('child.prose', 'export function title giving text\n    return "saved"');
    const changed = 'export function title takes pages as number, giving number\n    return pages\nfail "Never execute imports"';
    const result = f.complete('use title from "./child.prose"\nscale is function takes value as number return value * 2\nalias is scale\nprint ti|\nfail "Never execute source"', { overlays: [[child, changed]] });
    assert.match(item(result, 'title').detail, /takes pages as number giving number/);
    assert.equal(item(result, 'alias').kind, 'function');
    assert.match(item(result, 'scale').detail, /value as number/);
    assert.match(readFileSync(child, 'utf8'), /giving text/);
    f.write('types.ts', 'export interface Book { title: string; }\nexport const answer = 42;');
    const typed = f.complete('use type Book from "./types"\nuse answer from "./types"\nprint an|');
    assert.ok(item(typed, 'answer')); assert.ok(!typed.items.some(item => item.label === 'Book'));
  } finally { f.close(); }
});

test('identifier completion rejects strings, patterns, definitions, properties and types', () => {
  const f = fixture();
  try {
    for (const tail of ['print "na|me"', 'print pattern "na|me"', 'na|me is 1', 'value as na|me',
      'type Name is na|me', 'use na|me from "./types"', 'function na|me takes value\n    return value',
      'action is function takes na|me return 1', 'data is object\n    na|me is 1', 'data is object na|me is 1',
      'for na|me to 3\n    print 1', 'print 12|3', 'print tru|e']) {
      assert.deepEqual(f.complete('name is "existing"\n' + tail).items, [], tail);
    }
    assert.deepEqual(f.complete('function inspect takes unknown\n    return unknown.na|').items, []);
    assert.deepEqual(f.complete('broken is (\nname is 1\nprint na|').items, []);
  } finally { f.close(); }
});

test('identifier replacement uses UTF-16 columns and preserves wrapped CRLF source', () => {
  const f = fixture();
  try {
    const result = f.complete('letter_count is 3\r\nprint "😀", (\r\n\tletter_co|unt\r\n\t)');
    const value = item(result, 'letter_count');
    assert.equal(value.line, 3); assert.equal(value.startColumn, 2); assert.equal(value.endColumn, 14);
    const sameLine = item(f.complete('letter_count is 3\nprint "😀", letter_co|unt'), 'letter_count');
    assert.equal(sameLine.startColumn, 13); assert.equal(sameLine.endColumn, 25);
  } finally { f.close(); }
});
