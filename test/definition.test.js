import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkProject } from "../src/check-project.js";

const ts = createRequire(import.meta.url)("typescript");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prose definition 😀 "));
  const write = (name, source) => {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file;
  };
  write("package.json", '{"type":"module"}');
  write("tsconfig.json", '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]}}');
  return { root, write,
    check: (file, extra = {}) => checkProject({ cwd: root, targets: [file], definitionTargets: [file], typescript: ts, ...extra }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}
function position(source, needle, word = needle) {
  const start = source.indexOf(needle);
  assert.ok(start >= 0, needle);
  const prefix = source.slice(0, start + needle.lastIndexOf(word)).split(/\r?\n/);
  return { line: prefix.length, column: prefix.at(-1).length + 1, endColumn: prefix.at(-1).length + word.length + 1 };
}
const find = (result, source, needle, word) => {
  const { line, column } = position(source, needle, word);
  return result.definitions.find(item => item.line === line && item.column === column);
};
function goesTo(result, source, needle, word, file, targetSource, targetNeedle, targetWord = word) {
  const definition = find(result, source, needle, word);
  assert.ok(definition, `No definition: ${needle}: ${word}`);
  assert.deepEqual(definition.targets, [{ file, ...position(targetSource, targetNeedle, targetWord) }]);
}

test("definitions find variables, first assignments, parameters, and functions declared after a call", () => {
  const f = fixture();
  const source = [
    'count is 1', 'count is count + 1', 'print count', 'print double count',
    'function double takes number as number giving number', '    return number * 2',
    'shout is function takes text return text.to_upper_case run', 'print shout "hello"'
  ].join('\n');
  try {
    const file = f.write('main.prose', source), result = f.check(file);
    goesTo(result, source, 'print count', 'count', file, source, 'count is 1');
    goesTo(result, source, 'print double count', 'double', file, source, 'function double');
    goesTo(result, source, 'return number', 'number', file, source, 'takes number');
    goesTo(result, source, 'print shout', 'shout', file, source, 'shout is');
    goesTo(result, source, 'text.to_upper_case', 'text', file, source, 'takes text');
    assert.ok(!('hovers' in result));
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.ok(!('definitions' in checkProject({ targets: [file], typescript: ts })));
  } finally { f.close(); }
});

test("lexical shadowing, captured variables, destructuring, and loop indexes navigate to their own binding", () => {
  const f = fixture();
  const source = [
    'value is 99', 'function outer takes value',
    '    transform is function takes value', '        return value + 1',
    '    capture is function takes delta return value + delta', '    return transform value',
    'items is 1, 2', 'for each entry in items', '    print entry',
    'first, second are items', 'print second', 'for i is 1 to 2', '    print items.i'
  ].join('\n');
  try {
    const file = f.write('main.prose', source), result = f.check(file);
    goesTo(result, source, 'return value + 1', 'value', file, source, 'transform is function takes value');
    goesTo(result, source, 'return value + delta', 'value', file, source, 'outer takes value');
    goesTo(result, source, 'transform value', 'value', file, source, 'outer takes value');
    goesTo(result, source, 'print entry', 'entry', file, source, 'each entry');
    goesTo(result, source, 'print second', 'second', file, source, 'first, second');
    goesTo(result, source, 'print items.i', 'i', file, source, 'for i');
  } finally { f.close(); }
});

test("imported snake_case functions navigate to Prose source through fresh declarations and TypeScript reexports", () => {
  const f = fixture();
  const childSource = '"Move to the next day."\nexport function next_day takes key as text giving text\n    return key';
  const source = 'use next_day from "./dates.prose"\nprint next_day "2026-10-29"';
  try {
    const child = f.write('dates.prose', childSource), file = f.write('main.prose', source);
    f.write('dates.d.prose.ts', 'export declare function nextDay(): never;');
    let result = f.check(file);
    goesTo(result, source, 'use next_day', 'next_day', child, childSource, 'function next_day');
    goesTo(result, source, 'print next_day', 'next_day', child, childSource, 'function next_day');
    f.write('barrel.ts', 'export { nextDay } from "./dates.prose";');
    const throughBarrel = source.replace('./dates.prose', './barrel');
    result = f.check(file, { overlays: [[file, throughBarrel]] });
    goesTo(result, throughBarrel, 'print next_day', 'next_day', child, childSource, 'function next_day');
    assert.ok(result.definitions.every(item => item.targets.every(target => !/\.d\.prose\.ts|__prose_check__/.test(target.file))));
  } finally { f.close(); }
});

test("unsaved dependency edits update target ranges without saving or executing code", () => {
  const f = fixture();
  const source = 'use double from "./math.prose"\nprint double 3\nfail "must not run"';
  const childSource = 'export function double takes value giving number\n    return value * 2';
  try {
    const file = f.write('main.prose', source), child = f.write('math.prose', childSource);
    const unsaved = '\n\n' + childSource;
    const result = f.check(file, { overlays: [[child, unsaved]] });
    goesTo(result, source, 'print double', 'double', child, unsaved, 'function double');
    assert.equal(readFileSync(child, 'utf8'), childSource);
    const invalid = f.check(file, { overlays: [[file, 'value is "unfinished']] });
    assert.deepEqual(invalid.definitions, []);
  } finally { f.close(); }
});

test("wrapped headers, tabs, CRLF, and emoji keep original UTF-16 definition ranges", () => {
  const f = fixture();
  const source = [
    'function greet takes', '\tname as text,', 'giving text', '\treturn "😀" + name', 'print greet "Ada"'
  ].join('\r\n');
  try {
    const file = f.write('main.prose', source), result = f.check(file);
    goesTo(result, source, '"😀" + name', 'name', file, source, '\tname as');
    goesTo(result, source, 'print greet', 'greet', file, source, 'function greet');
  } finally { f.close(); }
});

test("object fields never navigate to same-named variables or unrelated exported functions", () => {
  const f = fixture();
  const source = 'pages is 99\nbook is object pages is 500\nprint book.pages';
  try {
    const file = f.write('main.prose', source), result = f.check(file);
    assert.equal(find(result, source, 'book.pages', 'pages'), undefined);
    goesTo(result, source, 'print book', 'book', file, source, 'book is');
    f.write('books.prose', 'export type Book is object\n    label as text\nexport function label giving text\n    return "other"');
    const typed = 'use type Book from "./books.prose"\nfunction title takes book as Book giving text\n    return book.label';
    const typedResult = f.check(file, { overlays: [[file, typed]] });
    assert.equal(find(typedResult, typed, 'book.label', 'label'), undefined);
  } finally { f.close(); }
});

test("project aliases and real TypeScript imports navigate to their original files", () => {
  const f = fixture();
  const dependencySource = 'export function nextDay(key: string): string { return key; }';
  const source = 'use next_day from "@dates"\nprint next_day "today"';
  try {
    f.write('tsconfig.json', '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","paths":{"@dates":["./dates.ts"]},"types":[]}}');
    const dependency = f.write('dates.ts', dependencySource), file = f.write('main.prose', source);
    const result = f.check(file);
    const target = find(result, source, 'print next_day', 'next_day').targets[0];
    assert.deepEqual(target, { file: dependency, ...position(dependencySource, 'function nextDay', 'nextDay'), endLine: 1 });
  } finally { f.close(); }
});

test("compiler temporary names do not become definitions for source variables", () => {
  const f = fixture();
  const source = '_limit0 is 2\nfor i is 1 to _limit0\n    print i\ntry\n    fail "expected"\non error __error\n    print __error.message';
  try {
    const file = f.write('main.prose', source), result = f.check(file);
    goesTo(result, source, 'to _limit0', '_limit0', file, source, '_limit0 is');
    goesTo(result, source, 'print __error', '__error', file, source, 'error __error');
  } finally { f.close(); }
});

test("unnamed function-type parameters do not shadow real Prose parameters", () => {
  const f = fixture();
  const source = 'function apply takes callback as function taking text giving text, arg1 as number giving number\n    print callback "hello"\n    return arg1';
  try {
    const file = f.write('main.prose', source), result = f.check(file, { hoverTargets: [file] });
    goesTo(result, source, 'return arg1', 'arg1', file, source, 'arg1 as number');
    const target = position(source, 'arg1 as number', 'arg1');
    assert.equal(result.hovers.find(item => item.line === target.line && item.column === target.column).code, 'arg1 as number');
  } finally { f.close(); }
});
