import test from "node:test";
import assert from "node:assert/strict";
import { compile, parse } from "../src/transpile.js";
import { format } from "../src/format.js";
import { run } from "./run.js";

const calculator = 'calculator is object\n    add is function takes left, right return left + right';
const boundary = source => assert.throws(() => compile(source), error => error.code === 'PROSE_CALL_BOUNDARY', source);

test("object methods use their declared counts with dots, colons, and literal computed keys", () => {
  assert.deepEqual(run(calculator + [
    '', 'print calculator.add 2, 3, 9', 'print calculator:add 3, 4, 8',
    'print calculator.("add") 4, 5, 7', 'print calculator:("add") 5, 6, 6',
    'print calculator.add with 2, 3',
    'calculator.zero is function return 0', 'print calculator.zero run, 1',
    'print (object add is function takes a, b return a + b).add 1, 2, 3'
  ].join('\n')), [[5, 9], [7, 8], [9, 7], [11, 6], 5, [0, 1], [3, 3]]);
  assert.throws(() => compile(calculator + '\ncalculator.add run'), /takes 2 arguments/);
  assert.throws(() => compile(calculator + '\ncalculator.add with 1, 2, 3'), /takes 2 arguments/);
  assert.throws(() => compile(calculator + '\ncalculator.add 1, 2 + 3'), /ambiguous/);
});

test("method definitions can refer to named functions, function aliases, and typed callbacks", () => {
  assert.deepEqual(run([
    'function add takes left, right', '    return left + right',
    'alias is add', 'tools is object add is add, total is alias',
    'print tools.add 1, 2, 3', 'print tools.total 2, 3, 4',
    'action is tools.add', 'print action 3, 4, 5',
    'function wrap takes callback as function taking number and number giving number',
    '    holder is object callback', '    return holder.callback 4, 5, 6',
    'print wrap alias'
  ].join('\n')), [[3, 3], [5, 4], [7, 5], [9, 6]]);
  assert.deepEqual(run([
    'function apply takes method as function taking number and number giving number',
    '    tool is object amount is 10, add is method', '    return tool.add 1, 2, 3',
    'print apply fetch'
  ].join('\n'), { fetch: function(a, b) { return this.amount + a + b; } }), [[13, 3]]);
});

test("object aliases, captures, nested properties, and matching branches preserve counts", () => {
  assert.deepEqual(run(calculator + [
    '', 'alias is calculator', 'print alias.add 1, 2, 3',
    'choice is calculator if true else (object add is function takes a, b return a * b)',
    'print choice.add 2, 3, 4',
    'holder is object calculator', 'print holder.calculator.add 3, 4, 5',
    'function captured', '    return calculator.add 4, 5, 6', 'print captured run',
    'later is unset', 'for i is 1 to 1', '    later is calculator', 'print later.add 5, 6, 7'
  ].join('\n')), [[3, 3], [5, 4], [7, 5], [9, 6], [11, 7]]);
});

test("property assignments through aliases agree on one parameter count", () => {
  assert.deepEqual(run(calculator + [
    '', 'alias is calculator', 'alias.add is function takes a, b return a * b',
    'print calculator.add 2, 3, 4',
    'added is object', 'added.sum is function takes a, b return a + b',
    'print added.sum 3, 4, 5',
    'holder is object', 'holder.child is calculator',
    'holder.child.add is function takes a, b return a - b',
    'print alias.add 9, 2, 3'
  ].join('\n')), [[6, 4], [7, 5], [7, 3]]);
});

test("unknown writes, changed parameter counts, and dynamic properties require boundaries", () => {
  for (const change of [
    'calculator.add is function takes a return a',
    'alias is calculator\nalias.add is function takes a return a',
    'alias is calculator if true else object\nalias.add is function takes a return a',
    'calculator.add is JSON.parse "{}"',
    'key is "add"\ncalculator.(key) is function takes a, b return a + b',
    'holder is object calculator\nholder.calculator.add is function takes a return a',
    'function replace\n    alias is calculator\n    alias.add is function takes a return a'
  ]) boundary(calculator + '\n' + change + '\nprint calculator.add 1, 2');
  boundary(calculator + '\nkey is "add"\nprint calculator.(key) 1, 2');
  assert.deepEqual(run(calculator + '\nalias is calculator\nalias.add is function takes a return a * 10\nprint calculator.add with 2, 3'), [20]);
  assert.deepEqual(run(calculator + '\ncalculator.note is "hello"\nprint calculator.add 1, 2, 3'), [[3, 3]]);
  assert.deepEqual(run(calculator + '\nfunction separate\n    calculator is object\n    calculator.add is function takes a return a\nprint calculator.add 1, 2, 3'), [[3, 3]]);
});

test("mixed receivers and lexical shadowing do not borrow another object's signature", () => {
  for (const source of [
    calculator + '\ncalculator is object\nprint calculator.add 1, 2',
    calculator + '\nchoice is calculator if true else object\nprint choice.add 1, 2',
    calculator + '\nfunction apply takes calculator\n    return calculator.add 1, 2',
    calculator + '\nfunction apply\n    calculator is JSON.parse "{}"\n    return calculator.add 1, 2',
    calculator + '\nfor each calculator in array\n    print calculator.add 1, 2',
    'left is right\nright is left\nprint left.add 1, 2',
    'left is right.child\nright is object child is left\nprint left.add 1, 2'
  ]) boundary(source);
});

test("object spreads follow override order and copied nested objects retain alias writes", () => {
  assert.deepEqual(run(calculator + [
    '', 'copy is object like calculator', 'print copy.add 1, 2, 3',
    'override is object like calculator, add is function takes value return value * 10',
    'print override.add 2, 3',
    'matching is object add is function takes value return value, like calculator',
    'print matching.add 3, 4, 5',
    'extra is object label is "Math"', 'merged is object like calculator, like extra',
    'print merged.add 4, 5, 6',
    'holder is object calculator', 'nested_copy is object like holder',
    'nested_copy.calculator.add is function takes a, b return a * b',
    'print holder.calculator.add 2, 3, 4'
  ].join('\n')), [[3, 3], [20, 3], [7, 5], [9, 6], [6, 4]]);
  boundary(calculator + '\nunknown is JSON.parse "{}"\ncopy is object like calculator, like unknown\nprint copy.add 1, 2');
  assert.deepEqual(run(calculator + '\nunknown is JSON.parse "{}"\ncopy is object like unknown, like calculator\nprint copy.add 1, 2, 3'), [[3, 3]]);
  boundary(calculator + '\nholder is object calculator\ncopy is object like holder\ncopy.calculator.add is function takes a return a\nprint calculator.add 1, 2');
});

test("object method names use the same camel conversion and exact key rules as runtime", () => {
  const source = 'tools is object\n    add_numbers is function takes a, b return a + b';
  assert.deepEqual(run(source + '\nprint tools.add_numbers 1, 2, 3\nprint tools.("addNumbers") 2, 3, 4'), [[3, 3], [5, 4]]);
  boundary(source + '\nprint tools.("add_numbers") 1, 2');
  boundary(source + '\ntools.("addNumbers") is function takes a return a\nprint tools.add_numbers 1, 2');
});

test("object type fields and declared function results provide method signatures", () => {
  const prefix = [
    'type Binary is function taking number and number giving number',
    'type Calculator is object', '    add as Binary', 'type Alias is Calculator',
    calculator, 'function apply takes tool as Alias', '    return tool.add 1, 2, 3',
    'function create giving Calculator', '    return calculator',
    'print apply calculator', 'made is create run', 'print made.add 2, 3, 4'
  ].join('\n');
  assert.deepEqual(run(prefix), [[3, 3], [5, 4]]);
  boundary('type Calculator is object\n    add as function taking number and number giving number\nfunction apply takes tool as Calculator\n    for each tool in array\n        print tool.add 1, 2');
});

test("object method counts survive formatting, imports, and inferred-call reparsing", () => {
  const source = calculator + '\nprint calculator.add 1, 2, 3\ncopy is object like calculator\nprint copy.add 2, (3 + 4), 5';
  const formatted = format(source, { width: 40 });
  const meaning = text => JSON.stringify(parse(text), (key, value) => key === 'line' ? undefined : value);
  assert.equal(meaning(formatted), meaning(source));
  assert.equal(format(formatted, { width: 40 }), formatted);
  assert.deepEqual(run(formatted), [[3, 3], [9, 5]]);
  assert.match(compile('use add from "./tools.prose"\nprint add 1, 2, 3', {
    readModule: () => calculator + '\nexport add is calculator.add'
  }).code, /__prose_call\(_prose_add, \[1, 2\], 2\), 3/);
  boundary('identity is function takes value return value\ncalculator is identity 1, (object add is function takes a, b return a + b)\nprint calculator.add 1, 2');
});
