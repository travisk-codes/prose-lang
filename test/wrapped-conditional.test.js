import test from "node:test";
import assert from "node:assert/strict";
import { SourceMap } from "node:module";
import { runInNewContext } from "node:vm";
import { compile, parse } from "../src/transpile.js";
import { format } from "../src/format.js";

const meaning = source => JSON.stringify(parse(source), (key, value) => key === "line" ? undefined : value);
const run = (source, globals = {}) => {
  const output = [];
  runInNewContext(compile(source).code, { ...globals, console: { log: value => output.push(value) } }, { timeout: 1000 });
  return structuredClone(output);
};
const labels = [
  'books is (object title is "Long", pages is 600), (object title is "Short", pages is 100)',
  'labels is books.map function takes book',
  '    return book.title + " (long)"',
  '        if book.pages > 500',
  '        else book.title',
  'print labels.join ", "'
].join('\n');

test("indented if and else continue a returned conditional inside a callback", () => {
  assert.deepEqual(run(labels), ['Long (long), Short']);
  const inline = labels.replace('\n        if ', ' if ').replace('\n        else ', ' else ');
  assert.equal(meaning(labels), meaning(inline));
});

test("wrapped conditional values also work in assignments, print, and object properties", () => {
  assert.deepEqual(run([
    'label is "yes"', '    if true', '    else "no"', 'print label',
    'print 3', '    if false', '    else 4',
    'record is object', '    label is "chosen"', '        if true', '        else "other"',
    'print record.label', 'prefix is if false then "one"', '    else "two"', 'print prefix'
  ].join('\n')), ['yes', 4, 'chosen', 'two']);
});

test("wrapped conditionals evaluate the condition first and only the selected branch", () => {
  const events = [];
  assert.deepEqual(run([
    'function choose takes ready',
    '    return globalThis.left run',
    '        if globalThis.condition ready',
    '        else globalThis.right run',
    'print choose true', 'print choose false'
  ].join('\n'), {
    condition(value) { events.push('condition'); return value; },
    left() { events.push('left'); return 'yes'; },
    right() { events.push('right'); return 'no'; }
  }), ['yes', 'no']);
  assert.deepEqual(events, ['condition', 'left', 'condition', 'right']);
});

test("lambda bodies and ordinary block else clauses stay separate", () => {
  assert.deepEqual(run([
    'function factory', '    return function takes value',
    '        if value', '            return "yes"', '        else', '            return "no"',
    'action is factory run', 'print action true', 'print action false',
    'callback is function takes ready',
    '    if ready', '        return "block yes"', '    else', '        return "block no"',
    'print callback true', 'print callback false',
    'type Flags is object', '    if as boolean', '    else as boolean',
    'flags is object', '    if is true', '    else is false', 'print flags.if', 'print flags.else'
  ].join('\n')), ['yes', 'no', 'block yes', 'block no', true, false]);
  assert.throws(() => compile('record is object\n    if true\n        name is "invalid"'), /Line 2:.*only property definitions/);
});

test("wrapped conditions mix with logical continuations and existing parentheses", () => {
  assert.deepEqual(run([
    'print "selected"', '    if false', '    or true', '    and true', '    else "other"',
    'print (', '    if true then "prefix"', '    else "other")',
    'print ("inner"', '    if true', '    else "other")', '    if false', '    else "outer"'
  ].join('\n')), ['selected', 'prefix', 'outer']);
  assert.deepEqual(run('if (true\n    or false)\n    print "block"'), ['block']);
});

test("missing else and unparenthesized nested trailing conditionals still report errors", () => {
  assert.throws(() => compile('print "yes"\n    if true'), /Expected 'else'/);
  assert.throws(() => compile('print "yes"\n    if true\n    else'), /Expected an expression/);
  assert.throws(() => compile('print "yes"\n    if true\nelse "no"'), /Expected 'else'/);
  assert.throws(() => compile('print "a"\n    if true\n    else "b"\n    if false\n    else "c"'), /Nested trailing if.*parentheses/);
  assert.deepEqual(run('function done\n    return "yes"\n    if true\n        return "unreachable"\nprint done run'), ['yes']);
});

test("format preserves wrapped conditional layout, tabs and CRLF, and safely reflows it", () => {
  const source = labels.slice(labels.indexOf('labels is'));
  for (const original of [source, source.replace(/\n/g, '\r\n')]) {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(format(original), original + eol);
    assert.equal(format(format(original)), original + eol);
  }
  const tabbed = source.replace(/ {4}/g, '\t');
  assert.equal(format(tabbed, { insertSpaces: false }), tabbed + '\n');
  const formatted = format(source, { width: 28 });
  assert.equal(meaning(formatted), meaning(source));
  assert.ok(formatted.split('\n').every(line => line.length <= 28));
  assert.equal(format(formatted, { width: 28 }), formatted);
});

test("wrapped call results honor known local and imported function argument counts", () => {
  assert.deepEqual(run([
    'function size takes text', '    return length text',
    'function choose takes ready', '    return size "yes" + 1', '        if ready', '        else 0',
    'print choose true', 'print choose false'
  ].join('\n')), [4, 0]);
  const source = [
    'use size from "./sizes.prose"', 'function choose takes ready',
    '    return size "yes" + 1', '        if ready', '        else 0'
  ].join('\n');
  assert.ok(compile(source, { readModule: () => 'export function size takes text\n    return length text' }).module);
});

test("source maps preserve physical calls in the condition and fallback lines", () => {
  const source = [
    'function choose', '    return 1',
    '        if JSON.parse "true"', '        else JSON.parse "2"'
  ].join('\n');
  const result = compile(source, { sourceMap: true, filename: 'wrapped.prose' });
  const map = new SourceMap(result.map);
  for (const [index, expectedLine, expectedColumn] of [
    [result.code.indexOf('__prose_dot_method(JSON'), 2, 11],
    [result.code.lastIndexOf('__prose_dot_method(JSON'), 3, 13]
  ]) {
    assert.ok(index >= 0);
    const before = result.code.slice(0, index).split('\n');
    const entry = map.findEntry(before.length - 1, before.at(-1).length);
    assert.equal(entry.originalLine, expectedLine);
    assert.equal(entry.originalColumn, expectedColumn);
  }
});
