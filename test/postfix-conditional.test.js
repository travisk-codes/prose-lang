import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transpile } from "../src/transpile.js";
import { run } from "./run.js";

test("trailing conditionals work in returns, assignments, print, and lists", () => {
  assert.deepEqual(run([
    'function status takes book', '    return "read" if book.done else "to read"',
    'book is object done is true', 'print status book', 'book.done is false', 'print status book',
    'label is "yes" if false else "no"', 'print label', 'print 7 if true else 8',
    'values is 1 if true else 2, 3 if false else 4', 'print values'
  ].join("\n")), ["read", "to read", "no", 7, [1, 4]]);
});

test("a trailing conditional chooses a whole call result and only evaluates the chosen branch", () => {
  const events = [];
  assert.deepEqual(run([
    'function describe takes book', '    return globalThis.describe book',
    'function choose takes book',
    '    return describe book if globalThis.ready book else globalThis.fallback run',
    'book is object done is false', 'print choose book', 'book.done is true', 'print choose book'
  ].join("\n"), {
    describe() { events.push("describe"); return "read"; },
    ready(book) { events.push("condition"); return book.done; },
    fallback() { events.push("fallback"); return "to read"; }
  }), ["to read", "read"]);
  assert.deepEqual(events, ["condition", "fallback", "condition", "describe"]);
});

test("calls through variables, methods, constructors, and run bind before a trailing conditional", () => {
  assert.deepEqual(run([
    'format is function takes value return "book " + value',
    'print format "Ada" if true else "other"',
    'print Math.max 2, 7 if false else 11',
    'print Math.max with 2, 7 if true else 11',
    'greet is function return "hello"', 'print greet run if true else "bye"',
    'collection is new Set if true else null', 'print collection.size'
  ].join("\n")), ["book Ada", 11, 7, "hello", 0]);
});

test("arithmetic and logic bind more tightly than trailing if", () => {
  assert.deepEqual(run([
    'print 1 + 2 * 3 if false or true else 9 + 1',
    'print false if false else true and false',
    'print 0 otherwise 2 if true else 3', 'print 1 if false else 0 otherwise 2',
    'function double takes n', '    return n * 2',
    'print double 3 + 1 if true else 0'
  ].join("\n")), [7, false, 0, 0, 7]);
});

test("existing prefix conditionals remain valid call arguments", () => {
  assert.deepEqual(run([
    'format is function takes value return "value " + value',
    'print format if true then 3 else 4',
    'print Math.abs if true then -3 else 4',
    'print if true then "yes" else "no"',
    'print if false then 1 else if true then 2 else 3'
  ].join("\n")), ["value 3", 3, "yes", 2]);
});

test("nested trailing conditionals require explicit parentheses", () => {
  assert.deepEqual(run([
    'print ("A" if true else "B") if false else "C"',
    'print "A" if false else ("B" if true else "C")',
    'function double takes n', '    return n * 2',
    'print double (3 if true else 4)'
  ].join("\n")), ["C", "B", 6]);
  assert.throws(() => transpile('print "A" if true else "B" if false else "C"'), /Line 1: Nested trailing if.*parentheses/);
});

test("trailing conditionals can wrap after if and else without consuming block else bodies", () => {
  assert.deepEqual(run([
    'value is "yes" if', '    true else', '    "no"', 'print value',
    'if false', '    print "skip"', 'else', '    print "block"',
    'book is object then is true, else is false',
    'format is function takes value return "value " + value',
    'print format 3 if book.then else "other"'
  ].join("\n")), ["yes", "block", "value 3"]);
});

test("missing else clauses and values report the source line", () => {
  assert.throws(() => transpile('print "read" if true'), /Line 1: Expected 'else'/);
  assert.throws(() => transpile('print "read" if true else'), /Line 1: Expected an expression/);
});

test("reading_list prints the correct average with a numeric pages variable", () => {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const example = fileURLToPath(new URL("../examples/reading_list.prose", import.meta.url));
  const result = spawnSync(process.execPath, [cli, example, "--run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    "Finished: Middlemarch, Beloved", "Middlemarch (long), Piranesi, Beloved", "read: 2", "to read: 1",
    "Average pages: 492", "DONE", "Abandoned: 0"
  ]);
});
