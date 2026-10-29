import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { compile, transpile } from "../src/transpile.js";
import { run } from "./run.js";

// Runs a program whose output may come after it waits for promises.
async function runWaiting(source) {
  const output = [];
  runInNewContext(transpile(source), { console: { log: value => output.push(value) } }, { timeout: 1000 });
  await new Promise(resolve => setTimeout(resolve, 10));
  return output;
}

test("is a tests what kind of value something is", () => {
  assert.deepEqual(run([
    "function kind takes value",
    "    if value is a text return \"text\"",
    "    if value is a number return \"number\"",
    "    if value is a boolean return \"boolean\"",
    "    if value is a function return \"function\"",
    "    if value is a list return \"list\"",
    "    if value is an object return \"object\"",
    "    return \"other\"",
    "print kind \"hi\"", "print kind 5", "print kind true", "print kind (function takes x return x)",
    "print kind (1, 2)", "print kind (object a is 1)", "print kind null", "print kind unset"
  ].join("\n")), ["text", "number", "boolean", "function", "list", "object", "other", "other"]);
});

test("is not a negates a type test, and capitalized names test classes", () => {
  assert.deepEqual(run([
    "problem is new Error \"broken\"", "today is new Date 0",
    "print problem is an Error", "print today is an Error", "print today is a Date",
    "print problem is not an Error", "print \"x\" is not a number",
    "print (object a is 1) is not a list"
  ].join("\n")), [true, false, true, false, true, true]);
});

test("type tests rank with comparisons, below arithmetic and above and, or, and not", () => {
  assert.deepEqual(run([
    "value is 4",
    "print value + 1 is a number and value > 3",
    "print not value is a text",
    "print value is a text or value = 4",
    "ok is value is a number", "print ok",
    "a is 7", "print a"
  ].join("\n")), [true, true, true, true, 7]);
});

test("is a needs a kind of value or a class after it", () => {
  assert.throws(() => transpile("value is 1\nprint value is a thing"), /Expected a kind of value after 'a'/);
});

test("fail raises an error that try and on error catch", () => {
  assert.deepEqual(run([
    "function checked takes amount",
    "    if amount < 0 fail \"Amounts can't be negative.\"",
    "    return amount",
    "try", "    print checked 3", "    print checked -1", "    print \"not reached\"",
    "on error problem", "    print problem:message", "    print problem is an Error",
    "try", "    fail 404", "on error", "    print \"caught a number\"",
    "try", "    fail problem", "on error again", "    print again = problem"
  ].join("\n")), [3, "Amounts can't be negative.", true, "caught a number", true]);
});

test("try blocks share the function's variables and let loops skip and stop", () => {
  assert.deepEqual(run([
    "found is array",
    "for each item in (\"1\", \"x\", \"3\", \"stop\", \"5\")",
    "    try",
    "        if item = \"stop\" stop",
    "        if not (Number:isFinite (Number item)) fail \"not a number\"",
    "        found:push (Number item)",
    "    on error",
    "        skip",
    "print found",
    "try", "    JSON:parse \"{\"", "on error problem", "    reason is problem:name",
    "print reason"
  ].join("\n")), [[1, 3], "SyntaxError"]);
});

test("a try block needs an on error block", () => {
  assert.throws(() => transpile("try\n    print 1\nprint 2"), /needs an on error block/);
  assert.throws(() => transpile("fail"), /Expected a message after 'fail'/);
});

test("wait for makes the function around it asynchronous", async () => {
  // The three run at once, so only what each prints is fixed, not the order.
  assert.deepEqual((await runWaiting([
    "slow is function takes value", "    return wait for (Promise:resolve (value * 2))",
    "function report takes value", "    result is wait for slow value", "    print result",
    "report 21",
    "quick is function return wait for (Promise:resolve \"done\")",
    "(quick run):then function takes text return print_it text",
    "print_it is function takes text", "    print text",
    "function careful", "    try", "        wait for (Promise:reject (new Error \"offline\"))",
    "    on error problem", "        print problem:message",
    "careful run"
  ].join("\n"))).sort(), [42, "done", "offline"]);
  const code = transpile("function later takes value\n    return wait for value\nfunction now takes value\n    return (function return wait for value)");
  assert.match(code, /async function _prose_later/);
  assert.match(code, /^function _prose_now/m);
});

test("declarations give a waiting function's result as a promise", () => {
  const { declarations } = compile([
    "export function load takes key as text, giving number", "    return wait for (Promise:resolve 1)",
    "export function save takes key as text, giving Promise of nothing", "    wait for (Promise:resolve 1)",
    "export function now giving number", "    return 1"
  ].join("\n"));
  assert.match(declarations, /export function load\(key: string\): Promise<number>;/);
  assert.match(declarations, /export function save\(key: string\): Promise<void>;/);
  assert.match(declarations, /export function now\(\): number;/);
});

test("xor and shifts work on 32-bit integers, binding like multiplication", () => {
  assert.deepEqual(run([
    "print 6 xor 3", "print 1 shifted left by 4", "print -1 shifted right by 28",
    "print 1 + 2 xor 3", "print (1 + 2) xor 3", "print 3 shifted left by 1 + 1",
    "left is 8", "right is 2", "print left shifted right by right"
  ].join("\n")), [5, 16, 15, 2, 0, 7, 2]);
  assert.throws(() => transpile("print Math:max 1, 2 xor 3"), /'xor' right after a call's arguments is ambiguous/);
});

test("a computed property reads and writes the property a value names", () => {
  assert.deepEqual(run([
    "settings is object", "key is \"Coffee\"",
    "settings:(key:toLowerCase run) is 3",
    "print settings:(\"coffee\") + 1",
    "print maybe settings:(\"tea\")",
    "print maybe nothing_here:(\"tea\")",
    "settings:(\"__proto__\") is 5",
    "print Object:keys settings",
    "counts is object", "for each word in (\"a\", \"b\", \"a\")",
    "    counts:(word) is (counts:(word) otherwise 0) + 1",
    "print counts"
  ].join("\n").replace("nothing_here", "unset")), [4, undefined, undefined, ["coffee", "__proto__"], { a: 2, b: 1 }]);
});
