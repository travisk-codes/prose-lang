import test from "node:test";
import assert from "node:assert/strict";
import { compile, parse } from "../src/transpile.js";
import { format } from "../src/format.js";
import { run } from "./run.js";

test("named functions and function values consume the same declared count", () => {
  for (const definition of [
    'function add takes left, right\n    return left + right',
    'add is function takes left, right\n    return left + right',
    'add is function takes left, right return left + right'
  ]) assert.deepEqual(run(definition + '\nresult is add 1, 2, 3\nprint result'), [[3, 3]]);
});

test("function aliases, named references, captures, and recursion keep their counts", () => {
  assert.deepEqual(run([
    'function add takes left, right', '    return left + right',
    'alias is add', 'second_alias is alias', 'print second_alias 1, 2, 3',
    'factorial is function takes number', '    if number < 2 return 1',
    '    return number * factorial (number - 1)', 'print factorial 5',
    'holder is function', '    inner is function takes number return number + 1',
    '    return inner 2, 9', 'print holder run'
  ].join('\n')), [[3, 3], 120, [3, 9]]);
});

test("function-type annotations and aliases supply callback parameter counts", () => {
  assert.deepEqual(run([
    'type Binary is function taking number and number giving number',
    'function apply takes action as Binary', '    return action 1, 2, 3',
    'add is function takes left, right return left + right', 'print apply add',
    'function forwarded takes action as function taking number and number giving number',
    '    copy is action', '    return copy 2, 3, 4', 'print forwarded add'
  ].join('\n')), [[3, 3], [5, 4]]);
});

test("same-count assignments remain known and different counts require explicit boundaries", () => {
  const same = 'if true\n    action is function takes a, b return a + b\nelse\n    action is function takes x, y return x * y\nprint action 1, 2, 3';
  assert.deepEqual(run(same), [[3, 3]]);
  const mixed = same.replace('takes x, y return x * y', 'takes x return x * 10');
  assert.throws(() => compile(mixed), /parameter count is unknown.*Use with/);
  assert.deepEqual(run(mixed.replace('print action 1, 2, 3', 'print (action with 1, 2), 3')), [[3, 3]]);
  assert.deepEqual(run(mixed.replace('if true', 'if false').replace('print action 1, 2, 3', 'print (action 1), 2, 3')), [[10, 2, 3]]);
});

test("unknown single and zero argument calls work and commas never fall back to greedy parsing", () => {
  assert.deepEqual(run([
    'function apply takes action', '    return (action 1), 2, 3',
    'function once takes action', '    return action run',
    'double is function takes number return number * 2', 'print apply double',
    'seven is function return 7', 'print once seven',
    'print Math.max with 1, 2', 'print (Math.max with 1, 2), 3'
  ].join('\n')), [[2, 2, 3], 7, 2, [2, 3]]);
  for (const source of [
    'print Math.max 1, 2', 'print (Math.max 1, 2), 3',
    'function apply takes action\n    return action 1, 2',
    'function apply takes outer, inner\n    return outer inner 1, 2'
  ]) assert.throws(() => compile(source), error => error.code === 'PROSE_CALL_BOUNDARY' && /Use with/.test(error.message));
});

test("unknown calls have stable explicit boundaries before and after adding a signature", () => {
  const prefix = 'add is function takes a, b return a + b\n';
  const source = 'function apply takes action\n    return (action with 1, 2), 3\nprint apply add';
  assert.deepEqual(run(prefix + source), [[3, 3]]);
  assert.deepEqual(run(prefix + source.replace('takes action', 'takes action as function taking number and number giving number')), [[3, 3]]);
  assert.throws(() => compile(prefix + source.replace('takes action', 'takes action as function taking number giving number')), /takes 1 argument/);
});

test("parameters and local bindings shadow outer function-value signatures", () => {
  const prefix = 'action is function takes a, b return a + b\n';
  assert.throws(() => compile(prefix + 'function apply takes action\n    return action 1, 2'), /parameter count is unknown/);
  assert.throws(() => compile(prefix + 'wrapper is function\n    action is JSON.parse "{}"\n    return action 1, 2'), /parameter count is unknown/);
  assert.deepEqual(run(prefix + 'wrapper is function\n    return action 1, 2, 3\nprint wrapper run'), [[3, 3]]);
});

test("optional with calls, compound arguments, zero-argument values, and negative values stay consistent", () => {
  const source = 'add is function takes a, b\n    if b = unset b is 0\n    return a + b\nprint add with 1\nprint add -1, 2\nprint add 2, (3 + 4)\nzero is function return 7\nprint zero run, 8';
  assert.deepEqual(run(source), [1, 1, 9, [7, 8]]);
  assert.throws(() => compile(source + '\nprint add 1, 2 + 3'), /ambiguous/);
  assert.throws(() => compile(source + '\nprint (add) with 1, 2, 3'), /takes 2 arguments/);
});

test("exported function values and aliases carry counts into importing Prose files", () => {
  const module = 'add is function takes a, b return a + b\nexport plus is add';
  const source = 'use plus from "./math.prose"\nprint plus 1, 2, 3';
  const code = compile(source, { readModule: () => module });
  assert.match(code.code, /__prose_call\(_prose_plus, \[1, 2\], 2\), 3/);
  const direct = compile(source, { readModule: () => 'export plus is function takes a, b return a + b' });
  assert.equal(code.code, direct.code);
});

test("the formatter preserves inferred and explicit call boundaries", () => {
  const source = 'add is function takes a, b return a + b\nvalues is add 1, 2, 3\nprint (JSON.stringify with values, unset, 2), "done"';
  const formatted = format(source, { width: 40 });
  const meaning = text => JSON.stringify(parse(text), (key, value) => key === 'line' ? undefined : value);
  assert.equal(meaning(formatted), meaning(source));
  assert.equal(format(formatted, { width: 40 }), formatted);
});

test("ambiguity diagnostics identify the actual argument start on wrapped Unicode source", () => {
  const source = 'print "😀", Math.max 1, 2';
  assert.throws(() => compile(source), error => {
    assert.equal(error.code, 'PROSE_CALL_BOUNDARY');
    assert.deepEqual(error.callBoundary, { line: 1, column: source.indexOf('1'), text: 'with ' });
    return true;
  });
});

test("inference accounts for loop writes, conditional values, and absent values", () => {
  const source = [
    'action is unset', 'for i is 1 to 1',
    '    action is function takes a, b return a + b',
    'print action 1, 2, 3',
    'choice is action if true else action', 'print choice 2, 3, 4',
    'other is function takes a return a * 2',
    'different is action if true else other', 'print (different with 1, 2), 3'
  ].join('\n');
  assert.deepEqual(run(source), [[3, 3], [5, 4], [3, 3]]);
  assert.throws(() => compile(source.replace('(different with 1, 2), 3', 'different 1, 2, 3')), /parameter count is unknown/);
  assert.throws(() => compile(source + '\nfor action is 1 to 2\n    print action'), /parameter count is unknown/);
});

test("discovery withdraws provisional signatures when call boundaries change an assignment", () => {
  const source = 'identity is function takes value return value\nvalue is identity 1, function takes a, b return a + b\nprint value 1, 2';
  assert.throws(() => compile(source), /parameter count is unknown/);
});

test("unknown constructors need with for several arguments and one argument stays call-first", () => {
  assert.throws(() => compile('date is new Date 2026, 0, 1'), /parameter count is unknown/);
  assert.deepEqual(run('date is new Date with 2026, 0, 1\nprint date.get_full_year run\nprint Math.abs 2 + 3'), [2026, 5]);
  const output = compile('export function apply takes action as function taking number and number giving number\n    return action 1, 2, 3', { check: true });
  assert.match(output.code, /_prose_action\(1, 2\), 3/);
});

test("known collection methods consume their fixed signatures and keep their receiver", () => {
  assert.deepEqual(run([
    'function word_counts takes some_text as text giving Map',
    '    words is some_text.split " "', '    counts is new Map',
    '    for each word in words', '        if counts.has word',
    '            counts.set word, (counts.get word + 1)',
    '        else', '            counts.set word, 1', '    return counts',
    'counts is word_counts "hello world hello"',
    'print counts.get "hello", counts.get "world"',
    'known is new Map', 'result is known.set "a", 3, 9',
    'print result.1 = known, result.2, known.get "a"',
    'second is known:("set") "b", 4, 10', 'print second.1 = known, second.2, known.get "b"',
    'print known.delete "a", known.has "a"', 'known.clear run', 'print known.size',
    'seen is new Set', 'print seen.add "a", 8', 'print seen.has "a", 9',
    'key is object', 'weak is new WeakMap', 'weak.set key, 5', 'print weak.get key, 6',
    'weak_seen is new WeakSet', 'weak_seen.add key', 'print weak_seen.has key, 7'
  ].join('\n')), [
    [2, 1], [true, 9, 3], [true, 10, 4], [true, false], 0,
    [new Set(['a']), 8], [true, 9], [5, 6], [true, 7]
  ]);
});

test("collection aliases, same-kind branches, captures, and setter results retain signatures", () => {
  assert.deepEqual(run([
    'counts is new Map', 'alias is counts', 'alias.set "a", 1',
    'choice is counts if true else new Map', 'choice.set "b", 2',
    'copy is alias.set "c", 3', 'copy.set "d", 4',
    'function fill', '    counts.set "e", 5', 'fill run',
    'later is unset', 'for i is 1 to 1', '    later is new Map', 'later.set "f", 6',
    'print counts.get "e", copy.get "d", later.get "f"',
    'print (new Map).set "g", 7, 8'
  ].join('\n')), [[5, 4, 6], [new Map([['g', 7]]), 8]]);
});

test("collection type annotations and aliases provide method signatures", () => {
  for (const annotation of ['map from text to number', 'Map from text to number', 'Map', 'maybe Map', '(Map)', 'Map or null']) {
    assert.deepEqual(run([
      `type Counts is ${annotation}`, 'function fill takes counts as Counts',
      '    copy is counts', '    copy.set "a", 3', '    return copy.get "a", 4',
      'print fill new Map', `local as ${annotation} is new Map`,
      'local.set "b", 5', 'print local.get "b", 6'
    ].join('\n')), [[3, 4], [5, 6]]);
  }
  assert.deepEqual(run('function fill takes seen as set of text\n    seen.add "a"\n    return seen.has "a", 2\nprint fill new Set'), [[true, 2]]);
});

test("declared collection return types flow through function values and aliases", () => {
  assert.deepEqual(run([
    'function create giving map from text to number', '    return new Map',
    'make is create', 'counts is make run', 'counts.set "a", 1',
    'factory is function giving Map return new Map', 'other is factory run', 'other.set "b", 2',
    'type Factory is function giving Map', 'function fill takes build as Factory',
    '    result is build run', '    result.set "c", 3', '    return result.get "c", 4',
    'print counts.get "a", other.get "b"', 'print fill factory'
  ].join('\n')), [[1, 2], [3, 4]]);
});

test("unknown receivers, mixed assignments, and shadowed constructors keep explicit boundaries", () => {
  const unknown = [
    'function fill takes counts\n    counts.set "a", 1',
    'counts is new Map\nfunction fill takes counts\n    counts.set "a", 1',
    'counts is new Map\nfunction fill\n    counts is JSON.parse "{}"\n    counts.set "a", 1',
    'counts is new Map\ncounts is object\ncounts.set "a", 1',
    'counts is new Map if true else new Set\ncounts.set "a", 1',
    'function fill takes Map\n    counts is new Map\n    counts.set "a", 1',
    'use Map from "./custom.js"\ncounts is new Map\ncounts.set "a", 1',
    'function Map\n    return object\ncounts is new Map\ncounts.set "a", 1',
    'type Map is object\n    set as unknown\nfunction fill takes counts as Map\n    counts.set "a", 1',
    'counts is new Map\nresult is counts.get "nested"\nresult.set "a", 1',
    'identity is function takes value return value\ncounts is identity 1, new Map\ncounts.set "a", 1'
  ];
  for (const source of unknown) assert.throws(() => compile(source), error => error.code === 'PROSE_CALL_BOUNDARY', source);
  assert.deepEqual(run('function fill takes counts\n    counts.set with "a", 1\n    return counts.get "a"\nprint fill new Map'), [1]);
});

test("method writes through aliases and prototypes withdraw collection signatures", () => {
  for (const mutation of [
    'counts.set is function takes value return value',
    'alias is counts\nalias.set is function takes value return value',
    'alias is counts\nalias is object\nalias.set is function takes value return value',
    'alias is counts if true else object\nalias.set is function takes value return value',
    'key is "set"\ncounts.(key) is function takes value return value',
    'Map.prototype.set is function takes value return value',
    'Map.prototype is object'
  ]) assert.throws(() => compile(`counts is new Map\n${mutation}\ncounts.set "a", 1`), error => error.code === 'PROSE_CALL_BOUNDARY', mutation);
  assert.deepEqual(run('counts is new Map\ncounts.set is function takes a, b return a + b\nprint counts.set with 1, 2'), [3]);
  assert.deepEqual(run('counts is new Map\ncounts.note is "hello"\ncounts.set "a", 1\nprint counts.get "a", 2'), [[1, 2]]);
});

test("optional and variable collection/list signatures preserve existing call boundaries", () => {
  const prefix = 'items is 1, 2, 3\ncounts is new Map\ncallback is function takes value return value\n';
  assert.deepEqual(run(prefix + 'print items.map callback\ncounts.for_each callback'), [[1, 2, 3]]);
  for (const expression of ['items.map callback, unset', 'items.slice 0, 2', 'counts.for_each callback, unset', 'Math.max 1, 2']) {
    assert.throws(() => compile(prefix + 'print ' + expression), error => error.code === 'PROSE_CALL_BOUNDARY');
  }
  assert.deepEqual(run(prefix + 'print items.map with callback, unset\nprint items.slice with 0, 2'), [[1, 2, 3], [1, 2]]);
  assert.throws(() => compile('counts is new Map\ncounts.set "a", 1 + 2'), /ambiguous/);
  assert.throws(() => compile('counts is new Map\ncounts.set run'), /takes 2 arguments/);
  assert.throws(() => compile('counts is new Map\ncounts.set with "a", 1, 2'), /takes 2 arguments/);
});

test("collection method calls round-trip through formatting and checked output", () => {
  const source = 'counts as map from text to number is new Map\ncounts.set "hello", 2\ncounts.set "hello", (counts.get "hello" + 1)\nprint counts.get "hello", 9';
  const formatted = format(source, { width: 40 });
  const meaning = text => JSON.stringify(parse(text), (key, value) => key === 'line' ? undefined : value);
  assert.equal(meaning(formatted), meaning(source));
  assert.equal(format(formatted, { width: 40 }), formatted);
  assert.deepEqual(run(formatted), [[3, 9]]);
  assert.match(compile(source, { check: true }).code, /_prose_counts\.set\("hello", 2\)/);
});

test("shallow export discovery tolerates collection arguments that call transitive imports", () => {
  const module = [
    'use make_key from "./keys.prose"', 'export label is "counts"',
    'export add is function takes a, b return a + b',
    'export function lookup takes counts as map from text to number, item as text',
    '    return counts.get make_key item',
    'export function contains takes keys as set of text, item as text',
    '    return if keys.has make_key item then 1 else 0'
  ].join('\n');
  let reads = 0;
  const code = compile('use lookup, contains, label, add from "./counts.prose"\nprint add 1, 2, 3', {
    readModule: specifier => { assert.equal(specifier, './counts.prose'); reads++; return module; }
  }).code;
  assert.equal(reads, 1);
  assert.match(code, /__prose_call\(_prose_add, \[1, 2\], 2\), 3/);
  // Compiling the module itself uses its actual imported signature normally.
  assert.doesNotThrow(() => compile(module, { readModule: () => 'export function make_key takes item\n    return item' }));
});
