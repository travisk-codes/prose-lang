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
