import test from "node:test";
import assert from "node:assert/strict";
import { SourceMap } from "node:module";
import { runInNewContext } from "node:vm";
import { compile, parse } from "../src/transpile.js";
import { format } from "../src/format.js";

const meaning = source => JSON.stringify(parse(source), (key, value) => key === "line" ? undefined : value);
const run = source => {
  const output = [];
  runInNewContext(compile(source).code, { console: { log: value => output.push(value) } }, { timeout: 1000 });
  return output;
};
const range = [
  'range1 is function takes number',
  '    if number < 0',
  '    or number >= 10',
  '        return "0" + number:to_string run',
  '    return number:to_string run'
].join('\n');

test("leading or continues a lambda's condition at the header indentation", () => {
  assert.deepEqual(run(range + '\nfor each number in (-1, 0, 9, 10)\n    print range1 number'), ["0-1", "0", "9", "010"]);
  const inline = range.replace('number < 0\n    or', 'number < 0 or');
  assert.equal(meaning(range), meaning(inline));
});

test("leading logical lines work in while, else if, and nested conditions", () => {
  assert.deepEqual(run([
    'count is 0', 'while count < 2', 'and count >= 0', '    count is count + 1',
    'if count = 0', 'or count < 0', '    print "wrong"',
    'else if count = 2', 'and count > 0', '    if false', '    or true', '        print count',
    'else', '    print "wrong"', 'print 99'
  ].join('\n')), [2, 99]);
});

test("leading and/or keep precedence and short-circuit evaluation", () => {
  assert.deepEqual(run([
    'function noisy', '    print "evaluated"', '    return true',
    'if true', 'or noisy run', '    print "or"',
    'if false', 'and noisy run', '    print "wrong"', 'else', '    print "and"',
    'if true', 'or false', 'and false', '    print "precedence"'
  ].join('\n')), ["or", "and", "precedence"]);
});

test("leading continuations accept extra indentation, tabs, CRLF, blanks, and trailing operators", () => {
  for (const source of [
    range.replace('\n    or', '\n        or'),
    range.replace(/ {4}/g, '\t').replace(/\n/g, '\r\n'),
    range.replace('\n    or', '\n\n    or'),
    range.replace('number < 0\n    or number >= 10', 'number < 0 or\n        number = 10\n    or number > 10')
  ]) assert.deepEqual(run(source + '\nprint range1 10'), ["010"]);
});

test("object and type fields named if, while, and, or are not condition headers", () => {
  assert.deepEqual(run([
    'type Flags is object', '    if as boolean', '    or as boolean', '    and as boolean', '    while as boolean',
    'flags is object', '    if is true', '    or is false', '    and is true', '    while is false',
    'print flags.if', 'print flags.or', 'print flags.and', 'print flags.while'
  ].join('\n')), [true, false, true, false]);
});

test("leading logical lines cannot attach after a body, across a dedent, or to another statement", () => {
  for (const source of [
    'print true\nor false',
    'value is true\nand false',
    'if true then print 1\nor false',
    'function ready takes word\n    return true\nword is "yes"\nif ready word "inline comment"\nor false\n    print 1',
    'if true\n    print 1\nor false',
    'function test\n    if true\nor false\n        return 1',
    'and true'
  ]) assert.throws(() => compile(source), /Line \d+:/, source);
  assert.throws(() => compile('if true\nor false\nprint 1'), /Line 1: Expected an indented body/);
});

test("leading continuations honor local and imported function argument counts", () => {
  const source = [
    'use ready from "./conditions.prose"',
    'word is "yes"',
    'if ready word', 'or false', '    print 1'
  ].join('\n');
  const readModule = () => 'export function ready takes word\n    return true';
  assert.ok(compile(source, { readModule }).module);
  assert.ok(compile(source.replace('if ready word', 'if ready word + 1 > 0'), { readModule }).module);
  assert.throws(() => compile(source.replace('if ready word', 'if ready word "inline comment"'), { readModule }),
    /Line 4: A leading 'and' or 'or' can only continue a condition/);
  assert.deepEqual(run([
    'word is "yes"', 'if ready word', 'or false', '    print 1',
    'function ready takes word', '    return true'
  ].join('\n')), [1]);
  assert.deepEqual(run([
    'word is "yes"', 'if size word + 1 > 0', 'or false', '    print 1',
    'function size takes word', '    return length word'
  ].join('\n')), [1]);
});

test("format preserves fitting leading logical lines and safely reflows long conditions", () => {
  for (const source of [range, range.replace(/\n/g, '\r\n')]) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(format(source), source + eol);
    assert.equal(format(format(source)), source + eol);
  }
  const tabbed = range.replace(/ {4}/g, '\t');
  assert.equal(format(tabbed, { insertSpaces: false }), tabbed + '\n');
  const source = [
    'function accepts takes record',
    '    if record.first_flag and record.second_flag',
    '    or record.third_flag', '        return true', '    return false'
  ].join('\n');
  const formatted = format(source, { width: 32 });
  assert.equal(meaning(formatted), meaning(source));
  assert.ok(formatted.split('\n').every(line => line.length <= 32));
  assert.equal(format(formatted, { width: 32 }), formatted);
});

test("source maps locate calls on the physical leading-operator line", () => {
  const source = 'if false\nor JSON.parse "bad"\n    print 1';
  const result = compile(source, { sourceMap: true, filename: 'leading.prose' });
  const offset = result.code.indexOf('__prose_dot_method(JSON');
  assert.ok(offset >= 0);
  const before = result.code.slice(0, offset).split('\n');
  const entry = new SourceMap(result.map).findEntry(before.length - 1, before.at(-1).length);
  assert.equal(entry.originalLine, 1);
  assert.equal(entry.originalColumn, 3);
  assert.equal(result.code, compile(source).code);
});
