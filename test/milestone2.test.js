import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { transpile } from "../src/transpile.js";

function run(source) {
  const output = [];
  runInNewContext(transpile(source), { console: { log: (...values) => output.push(values.length === 1 ? values[0] : values) } }, { timeout: 1000 });
  return structuredClone(output);
}

test("inline objects take name is value entries, bare names, and like copies", () => {
  assert.deepEqual(run([
    "text is \"hi\"", "labels is (\"a\",)",
    "result is object text, labels", "print result",
    'none is object kind is "none"', "print none",
    "datum is object time is 5, tags is (1,)", "tags is 2, 3",
    "copy is object like datum, tags", "print copy", "print datum:tags",
    'tag is object name is "mood", value is 7', 'renamed is object like tag, name is "Mood"', "print renamed",
    "merged is object like (object a is 1), like (object b is 2), c is 3", "print merged",
    "empty is object", "print empty"
  ].join("\n")), [
    { text: "hi", labels: ["a"] }, { kind: "none" }, { time: 5, tags: [2, 3] }, [1],
    { name: "Mood", value: 7 }, { a: 1, b: 2, c: 3 }, {}
  ]);
});

test("inline objects work as arguments, returns, list elements, and function results", () => {
  assert.deepEqual(run([
    "runs is array", "runs:push object start is 1, end is 2, length is 2", "print runs",
    "function bounds takes low, high", "    return object low, high, span is high - low", "print bounds 2, 9",
    "hours is Array:from (object length is 3), function takes ignored, hour return hour * 2", "print hours",
    "pairs is (object n is 1), (object n is 2)", "print pairs",
    "make is function takes n return object n, double is n * 2", "print make 4",
    "handler is object", '    label is "save"', "print handler"
  ].join("\n")), [
    [{ start: 1, end: 2, length: 2 }], { low: 2, high: 9, span: 7 }, [0, 2, 4], [{ n: 1 }, { n: 2 }],
    { n: 4, double: 8 }, { label: "save" }
  ]);
});

test("indented object bodies accept like lines, and inline objects may hold an indented function", () => {
  assert.deepEqual(run([
    "base is object a is 1, b is 2",
    "extended is object", "    like base", "    b is 20", "    c is 3",
    "print extended",
    "button is object label is \"Save\", press is function takes times",
    "    return \"pressed \" + times",
    "print button:press 2"
  ].join("\n")), [{ a: 1, b: 20, c: 3 }, "pressed 2"]);
});

test("inline objects follow the comma rules and reject other entries", () => {
  for (const [source, expected] of [
    ["print object a is 1, 2", /Line 1: Expected an object entry/],
    ["print object a is Math:max 1, 2", /Line 1:.*needs parentheses/],
    ["x is object a is 1\n    b is 2", /Line 2: Unexpected indentation/],
    ["value is 1\nprint object like", /Line 2: Expected an expression/]
  ]) assert.throws(() => transpile(source), expected, source);
});

test("each of spreads a collection into lists, call arguments, and print", () => {
  assert.deepEqual(run([
    "counts is 3, 9, 4", "print Math:max each of counts",
    "rest is 2, 3", "all_items is 1, each of rest, 4", "print all_items",
    "letters is (each of \"a😀\",)", "print letters",
    "seen is new Set (\"x\", \"y\")", "print (each of seen, \"z\")",
    "print each of counts",
    "print Math:min with each of counts, 1"
  ].join("\n")), [9, [1, 2, 3, 4], ["a", "😀"], ["x", "y", "z"], [3, 9, 4], 1]);
  assert.throws(() => run("value is 5\nprint (each of value,)"), /Line 2: 'for each' requires an array/);
  assert.throws(() => transpile("items is 1, 2\nx is each of items"), /Line 2: 'each of' can only spread/);
  assert.throws(() => transpile("function twice takes n\n    return n * 2\nitems is (1,)\nprint twice each of items"),
    /Line 4: 'twice' takes a fixed number of arguments/);
});

test("are assigns several names from a list by position, including swaps and strings", () => {
  assert.deepEqual(run([
    "r, g, b are (1, 3, 5):map function takes n return n * 10", "print r + g + b",
    "a, b are 1, 2", "a, b are b, a", "print (a, b)",
    "first, second are \"😀x\"", "print second",
    "only are (7, 8)", "print only",
    "key, value are (new Map ((\"k\", \"v\"),)):entries run:next run:value", "print key + value",
    "function split takes pair", "    left, right are pair", "    return right", "print split (1, 2)", "print left otherwise \"outer left is untouched\""
  ].join("\n").replace("print left otherwise \"outer left is untouched\"", "")), [90, [2, 1], "x", 7, "kv", 2]);
  assert.throws(() => transpile("a, a are 1, 2"), /Line 1: Duplicate variable name/);
  assert.throws(() => transpile("a, b are"), /Line 1: Expected a list after 'are'/);
  assert.throws(() => run("a, b are 5"), /Line 1: 'for each' requires an array/);
});

test("skip continues and stop breaks the innermost loop", () => {
  assert.deepEqual(run([
    "kept is array",
    "for each n in 1, 2, 3, 4, 5, 6",
    "    if n = 2 skip",
    "    if n > 4 stop",
    "    kept:push n",
    "print kept",
    "pairs is array",
    "for i is 1 to 3",
    "    for j is 1 to 3",
    "        if j = i skip",
    "        if j > 2 then stop",
    "        pairs:push (i * 10 + j)",
    "print pairs",
    "count is 0",
    "while true",
    "    count is count + 1",
    "    if count < 3 skip",
    "    stop",
    "print count"
  ].join("\n")), [[1, 3, 4], [12, 21, 31, 32], 3]);
});

test("skip and stop must be inside a loop of the same function", () => {
  for (const [source, expected] of [
    ["skip", /Line 1: 'skip' only works inside a loop/],
    ["if true stop", /Line 1: 'stop' only works inside a loop/],
    ["for each n in 1, 2\n    action is function\n        stop", /Line 3: 'stop' only works inside a loop/],
    ["function f\n    stop\nfor i is 1 to 2\n    f run", /Line 2: 'stop' only works inside a loop/],
    ["stop is 5", /Line 1: 'stop' is a word for loops, so it can't be used as a name/]
  ]) assert.throws(() => transpile(source), expected, source);
});

test("patterns are regular expressions with raw text, flag words, and Unicode always on", () => {
  assert.deepEqual(run([
    'print ("2026-10-28":match pattern "^(\\d{4})-(\\d{2})").2',
    'print "a  b   c":replace (pattern "\\s+" everywhere), " "',
    'print "Hello":match pattern "hello" ignoring case = null',
    'print ("one\\ntwo":match pattern "^two$" by line) != null',
    'print "say \\"hi\\"":replace (pattern "\\"" everywhere), "\'"',
    'print "😀":match pattern "^.$" != null',
    'print "#mood and #sleep":match pattern "#(\\p{L}+)" everywhere',
    'print pattern "x" everywhere ignoring case by line:flags',
    "pattern_text is \"plain variable\"", "print pattern_text"
  ].join("\n")), ["2026", "a b c", false, true, "say 'hi'", true, ["#mood", "#sleep"], "gimu", "plain variable"]);
  assert.throws(() => transpile('print pattern "(unclosed"'), /Line 1: This pattern isn't a valid regular expression/);
  assert.throws(() => transpile('print pattern "\\-"'), /Line 1: This pattern isn't a valid regular expression/);
});

test("assignment is recognized by its shape, so calls containing is are not assignments", () => {
  assert.deepEqual(run([
    "log is array", "log:push object level is \"info\"", "print log",
    "settings is object", "settings:is is 1", "print settings:is",
    "word is \"cat\"", "i is 1", "word.(i + 1) is \"u\"", "print word"
  ].join("\n")), [[{ level: "info" }], 1, "cut"]);
});
