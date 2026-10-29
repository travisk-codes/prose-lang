import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkProject } from "../src/check-project.js";

const ts = createRequire(import.meta.url)("typescript");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prose hover 😀 "));
  const write = (name, source) => {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    return file;
  };
  write("package.json", '{"type":"module"}');
  write("tsconfig.json", '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]},"include":["*.prose","*.ts"]}');
  return { root, write, check: (file, extra = {}) => checkProject({ cwd: root, targets: [file], hoverTargets: [file], typescript: ts, ...extra }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}
function at(result, source, needle, word = needle) {
  const offset = source.indexOf(needle) + needle.indexOf(word);
  assert.ok(offset >= 0, needle);
  const before = source.slice(0, offset).split(/\r?\n/);
  const item = result.hovers.find(item => item.line === before.length && item.column === before.at(-1).length + 1);
  assert.ok(item, `Missing hover for ${needle}: ${word}`);
  assert.equal(item.endColumn - item.column, word.length);
  return item;
}

test("hovers show row and callback inference, properties, lists, and function contracts", () => {
  const f = fixture();
  const source = [
    'shelf is ("Long", 880, true), ("Short", 272, false)', 'books is array',
    'for each title, pages, done in shelf', '    books.push object title, pages, done',
    'labels is books.map function takes book', '    return book.title + " (long)"',
    '        if book.pages > 500', '        else book.title',
    '"Multiply a number by two."', 'function double takes value as number giving number',
    '    return value * 2', 'print double 3'
  ].join('\n');
  try {
    const result = f.check(f.write("main.prose", source));
    assert.equal(at(result, source, 'labels is', 'labels').code, 'labels as list of text');
    assert.equal(at(result, source, 'if book.pages', 'pages').code, 'pages as number');
    assert.equal(at(result, source, 'else book.title', 'title').code, 'title as text');
    assert.equal(at(result, source, 'each title, pages', 'pages').code, 'pages as number');
    assert.match(at(result, source, 'takes book', 'book').code, /^book as object\n.*title as text\n.*pages as number\n.*done as boolean/);
    const signature = at(result, source, 'function double', 'double');
    assert.equal(signature.code, 'function double takes value as number giving number');
    assert.equal(signature.documentation, 'Multiply a number by two.');
    assert.equal(at(result, source, 'print double', 'double').code, signature.code);
    assert.ok(result.hovers.every(item => !/__prose_|_prose_|__Prose/.test(item.code)));
  } finally { f.close(); }
});

test("hover mapping distinguishes repeated members, contextual dots, snake_case, and print scaffolding", () => {
  const f = fixture();
  const source = [
    'pages is "shadow"', 'book is object pages is 500, created_at is new Date',
    'print book.pages', 'print book.created_at',
    'person is object person is object person is "inner"', 'print person.person.person',
    'log is 1', 'console is 2', 'print log', 'print console',
    'value, ready are (3, true)', 'print value', 'print ready'
  ].join('\n');
  try {
    const result = f.check(f.write("main.prose", source));
    assert.equal(at(result, source, 'print book.pages', 'pages').code, 'pages as number');
    assert.equal(at(result, source, 'print book.created_at', 'created_at').code, 'created_at as Date');
    const line = source.split('\n').indexOf('print person.person.person') + 1;
    const members = result.hovers.filter(item => item.line === line);
    assert.equal(members.length, 3);
    assert.match(members[0].code, /person as object\n.*person as object/);
    assert.equal(members[1].code, 'person as object\n    person as text');
    assert.equal(members[2].code, 'person as text');
    assert.equal(at(result, source, 'print log', 'log').code, 'log as 1');
    assert.equal(at(result, source, 'print console', 'console').code, 'console as 2');
    assert.equal(at(result, source, 'value, ready', 'value').code, 'value as number');
    assert.equal(at(result, source, 'value, ready', 'ready').code, 'ready as boolean');
  } finally { f.close(); }
});

test("hovers follow wrapped headers and conditions with tabs, CRLF, and UTF-16 columns", () => {
  const f = fixture();
  const source = [
    'function greet takes', '\tname as text,', '\tgiving text', '\treturn "😀" + name',
    'print greet "Ada"'
  ].join('\r\n');
  try {
    const result = f.check(f.write("main.prose", source));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(at(result, source, '\tname as', 'name').code, 'name as text');
    assert.equal(at(result, source, '"😀" + name', 'name').code, 'name as text');
    assert.equal(at(result, source, 'function greet', 'greet').code, 'function greet takes name as text giving text');
  } finally { f.close(); }
});

test("hover snapshots use unsaved Prose and TypeScript dependencies without writing or executing them", () => {
  const f = fixture();
  try {
    const mainText = 'use answer from "./child.prose"\nuse value from "./value"\nresult is answer run\nprint value';
    const main = f.write('main.prose', mainText);
    const child = f.write('child.prose', 'export function answer giving text\n    return "saved"');
    const dependency = f.write('value.ts', 'export const value = 3;');
    const unsaved = mainText + '\nfail "Must never execute"';
    const result = f.check(main, { overlays: [
      [main, unsaved], [child, 'export function answer giving number\n    return 42'],
      [dependency, 'export const value = "unsaved";']
    ] });
    assert.equal(at(result, unsaved, 'result is', 'result').code, 'result as number');
    assert.equal(at(result, unsaved, 'print value', 'value').code, 'value as "unsaved"');
    assert.equal(readFileSync(main, 'utf8'), mainText);
    assert.match(readFileSync(child, 'utf8'), /giving text/);
    assert.equal(readFileSync(dependency, 'utf8'), 'export const value = 3;');
    const fresh = join(f.root, 'new.prose');
    assert.equal(at(f.check(fresh, { overlays: [[fresh, 'value is "new"']] }), 'value is "new"', 'value').code, 'value as "new"');
  } finally { f.close(); }
});

test("hovers respect project aliases and do not return stale types for invalid buffers", () => {
  const f = fixture();
  try {
    f.write('tsconfig.json', '{"compilerOptions":{"paths":{"@types":["./types.ts"]},"module":"esnext","moduleResolution":"bundler","types":[]}}');
    f.write('types.ts', 'export interface Book { pages: number; title: string }');
    const source = 'use type Book from "@types"\nfunction label takes book as Book giving text\n    return book.title';
    const main = f.write('main.prose', source);
    const result = f.check(main);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(at(result, source, 'takes book', 'book').code, 'book as Book');
    const invalid = f.check(main, { overlays: [[main, 'value is "unfinished']] });
    assert.equal(invalid.exitCode, 1);
    assert.deepEqual(invalid.hovers, []);
    assert.ok(!('hovers' in checkProject({ cwd: f.root, targets: [main], typescript: ts })));
  } finally { f.close(); }
});

test("hover types use Prose names for builtins, maybe values, maps, and generics", () => {
  const f = fixture();
  const source = [
    'function identity takes value as item giving item', '    return value',
    'function optional takes value as maybe number giving maybe number', '    return value',
    'counts as map from text to number is new Map', 'print counts',
    'print length "😀"', 'print char_to_number "a"', 'print number_to_char 97'
  ].join('\n');
  try {
    const result = f.check(f.write('main.prose', source));
    assert.equal(at(result, source, 'function identity', 'identity').code, 'function identity takes value as item giving item');
    assert.equal(at(result, source, 'function optional', 'optional').code, 'function optional takes value as maybe number giving maybe number');
    assert.equal(at(result, source, 'print counts', 'counts').code, 'counts as map from text to number');
    assert.equal(at(result, source, 'print length', 'length').code, 'function length takes value as text or list of unknown giving number');
    assert.equal(at(result, source, 'print char_to_number', 'char_to_number').code, 'function char_to_number takes value as text giving number');
    assert.equal(at(result, source, 'print number_to_char', 'number_to_char').code, 'function number_to_char takes value as number giving text');
  } finally { f.close(); }
});

test("interop hovers distinguish code points, UTF-16 units, and native method positions", () => {
  const f = fixture();
  const source = [
    'word is "😀a"', 'print length word', 'print word.length',
    'print word.slice with 0, 2', 'print word.at 0', 'print word.index_of "a"',
    'print word.1', 'print word.("length")', 'print word:("length")',
    'print word.(1)',
    'for i is 1 to 2', '    print word.i',
    'function first takes items as list of text', '    return items:at 0'
  ].join('\n');
  try {
    const result = f.check(f.write('main.prose', source));
    assert.deepEqual(result.diagnostics, []);
    assert.match(at(result, source, 'print length', 'length').notes.join('\n'), /Unicode code points.*length "😀" is 1/);
    assert.match(at(result, source, 'word.length', 'length').notes.join('\n'), /UTF-16 code units.*length 2/);
    for (const needle of ['word.("length")', 'word:("length")']) {
      assert.match(at(result, source, needle, '"length"').notes.join('\n'), /used literally.*UTF-16 code units/s);
    }
    assert.match(at(result, source, 'word.slice', 'slice').notes.join('\n'), /zero-based.*end is excluded.*UTF-16/);
    assert.match(at(result, source, 'word.at', 'at').notes.join('\n'), /0 is the first item.*negative/);
    assert.match(at(result, source, 'word.index_of', 'index_of').notes.join('\n'), /indexOf returns a zero-based position, or -1/);
    assert.match(at(result, source, 'word.1', '1').notes.join('\n'), /positions start at 1.*Unicode code point/);
    assert.match(at(result, source, 'word.(1)', '1').notes.join('\n'), /positions start at 1/);
    assert.match(at(result, source, 'word.i\n', 'i').notes.join('\n'), /Here i supplies the position.*:i/);
    assert.match(at(result, source, 'items:at', 'at').notes.join('\n'), /Colon access.*zero-based/s);
  } finally { f.close(); }
});

test("property spelling, colon escapes, and literal keys explain exactly what is accessed", () => {
  const f = fixture();
  const source = [
    'record is object user_id is 7', 'print record.user_id', 'print record:user_id',
    'words is "first", "second"', 'map is 1', 'print words.map',
    'print words:map function takes word return word',
    'data is JSON.parse "{}"', 'print data.("user_id")', 'print data:(1)',
    'print data.("😀")', 'print "text with data.(\\"user_id\\") inside it"',
    'print pattern "data.(user_id)"'
  ].join('\r\n');
  try {
    const result = f.check(f.write('main.prose', source));
    assert.deepEqual(result.diagnostics, []);
    assert.match(at(result, source, 'record.user_id', 'user_id').notes.join('\n'), /"user_id" is spelled "userId".*\.\("user_id"\)/);
    assert.match(at(result, source, 'record:user_id', 'user_id').notes.join('\n'), /Colon access reads the JavaScript property "userId"/);
    assert.match(at(result, source, 'words.map', 'map').notes.join('\n'), /Here map supplies the position.*:map/);
    assert.match(at(result, source, 'words:map', 'map').notes.join('\n'), /Colon access.*"map"/);
    assert.match(at(result, source, 'data.("user_id")', '"user_id"').notes.join('\n'), /used literally.*without snake_case/);
    assert.match(at(result, source, 'data:(1)', '1').notes.join('\n'), /JavaScript property.*one-based position adjustment/);
    assert.match(at(result, source, 'data.("😀")', '"😀"').notes.join('\n'), /used literally/);
    const quoted = source.split('\r\n').findIndex(line => line.startsWith('print "text with')) + 1;
    assert.ok(!result.hovers.some(item => item.line === quoted));
    assert.doesNotThrow(() => JSON.stringify(result));
  } finally { f.close(); }
});

test("custom fields and unknown receivers do not receive native-method claims", () => {
  const f = fixture();
  const source = [
    'custom is object length is 2, slice is function takes start, end return start',
    'print custom.length', 'print custom.slice with 0, 2',
    'function inspect takes value', '    print value.length', '    return value.slice with 0, 2',
    'function dynamic takes values, i', '    return values.i'
  ].join('\n');
  try {
    const result = f.check(f.write('main.prose', source));
    assert.deepEqual(result.diagnostics, []);
    for (const [needle, word] of [['custom.length', 'length'], ['custom.slice', 'slice'], ['value.length', 'length'], ['value.slice', 'slice']]) {
      assert.equal(at(result, source, needle, word).notes, undefined, needle);
    }
    assert.match(at(result, source, 'values.i', 'i').notes.join('\n'), /numeric i.*otherwise.*property "i"/);
  } finally { f.close(); }
});

test("computed numeric dots distinguish list positions from object property keys", () => {
  const f = fixture();
  const source = [
    'use type Table from "./types"', 'table as Table is JSON.parse "{}"',
    'print table.(1)', 'print table:(1)', 'unknown is JSON.parse "{}"',
    'print unknown.(1)', 'items is "first", "second"', 'print items.(1)',
    'print items:(1)'
  ].join('\n');
  try {
    f.write('types.ts', 'export interface Table { [key: number]: string }');
    const result = f.check(f.write('main.prose', source));
    assert.deepEqual(result.diagnostics, []);
    assert.match(at(result, source, 'table.(1)', '1').notes.join('\n'), /On this object.*JavaScript property key/);
    assert.match(at(result, source, 'unknown.(1)', '1').notes.join('\n'), /one-based position.*other receivers/);
    assert.match(at(result, source, 'items.(1)', '1').notes.join('\n'), /positions start at 1/);
    for (const needle of ['table:(1)', 'items:(1)']) assert.match(at(result, source, needle, '1').notes.join('\n'), /used literally.*without.*one-based position adjustment/);
  } finally { f.close(); }
});
