import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compile, parse, transpile } from "../src/transpile.js";
import { format } from "../src/format.js";
import { run } from "./run.js";

const functions = [
  "function add takes left, right", "    return left + right",
  "function double takes value", "    return value * 2"
];
const program = (...lines) => [...functions, ...lines].join("\n");

test("a call takes every comma after it, whatever it calls", () => {
  assert.deepEqual(run(program(
    "print add 1, 2",
    "add_value is function takes left, right return left + right",
    "print add_value 3, 4",
    "alias is add_value",
    "print alias 5, 6",
    "tools is object add is function takes left, right return left + right",
    "print tools.add 7, 8",
    "print tools:add 9, 10",
    "print Math.max 4, 9, 2",
    "date is new Date 2026, 0, 2",
    "print date.get_date run"
  )), [3, 7, 11, 15, 19, 9, 2]);
});

test("parentheses end a call early, so the next comma belongs to the list", () => {
  assert.deepEqual(run(program(
    "print (add 1, 2), 3",
    "print (double 2), (double 3)",
    "results is (add 1, 2), (add 3, 4)",
    "print results",
    "first, second are (double 1), 5",
    "print first + second",
    "print ((double 1),)"
  )), [[3, 3], [4, 6], [3, 7], 7, [2]]);
});

test("a one-item list's trailing comma isn't an argument", () => {
  assert.deepEqual(run(program("print (double 2,)", "print (add 1, 2,)")), [[4], [3]]);
});

test("the standard functions take one value, so they can share a list", () => {
  assert.deepEqual(run('print (length "ab"), length "abc"\nprint length "ab", length "abc"'), [[2, 3], [2, 3]]);
});

test("a call inside another call's arguments needs parentheses to take a comma", () => {
  for (const source of [
    program("print add double 1, 2"),
    program("print add 1, add 2, 3"),
    "print Math.max with Math.min with 1, 2",
    "print Math.max 0, Math.min 1, 2"
  ]) assert.throws(() => transpile(source), /needs parentheses: \(f a, b\), or \(f a\), b/, source);
  assert.deepEqual(run(program(
    "print add (double 1), 2",
    "print add 1, (add 2, 3)",
    "print add 1, double 2",
    "print double double 2",
    "print Math.max 0, (Math.min 1, 2)"
  )), [4, 6, 5, 8, 1]);
});

test("a call with one argument binds before arithmetic; after several, arithmetic is an error", () => {
  assert.deepEqual(run(program(
    "print double 2 + 1",
    "print (add 1, 2) + 1",
    "print add 1, (2 + 1)",
    "print Math.abs -1 + 1".replace("Math.abs -1", "Math.abs with -1").replace("with -1 + 1", "with (-1 + 1)")
  )), [5, 4, 4, 0]);
  for (const source of [program("print add 1, 2 + 1"), "print Math.max 1, 2 + 1", "print Math.max with 1 + 1"]) {
    assert.throws(() => transpile(source), /right after a call's arguments is ambiguous/, source);
  }
});

test("known functions check how many arguments they get, without changing what a line means", () => {
  assert.throws(() => transpile(program("print double 1, 2")), /Line 5: 'double' takes 1 argument\./);
  assert.throws(() => transpile(program("print add 1, 2, 3")), /Line 5: 'add' takes 2 arguments\./);
  assert.throws(() => transpile(program("print add 1")), /'add' takes 2 arguments, but this call gives 1\. Write with to leave the rest unset\./);
  assert.throws(() => transpile(program("print add run")), /'add' takes 2 arguments; run supplies none\./);
  assert.throws(() => transpile("function now\n    return 1\nprint now 5"), /'now' takes no arguments\. Write run to call it\./);
  assert.deepEqual(run(program("print add with 1", "function now", "    return 1", "print now run")), [NaN, 1]);
});

test("with is needed before a negative first argument, and spaces tell subtraction apart", () => {
  assert.throws(() => transpile("count is 5\nprint count -1"), /'-' here could start a negative argument or subtract/);
  assert.deepEqual(run(program(
    "items is 1, 2, 3",
    "print items.at with -1",
    "print double with -2",
    "print double -2",
    "count is 5",
    "print count - 1",
    "print count-1"
  )), [3, -4, -4, 4, 4]);
});

test("in a one-line object, a call runs to the next entry", () => {
  assert.deepEqual(run(program(
    "other is object extra is 1",
    "value is object a is add 1, 2, b is double 3, c is 4",
    "print value.a + value.b + value.c",
    "copied is object a is double 1, like other",
    "print copied.a + copied.extra",
    "label is 2",
    "kept is object a is (double 1), label",
    "print kept.a + kept.label",
    "print (object a is add 1, 2).a"
  )), [13, 3, 4, 3]);
  assert.throws(() => transpile(program("label is 2\nprint object a is double 1, label")), /'double' takes 1 argument/);
});

test("a function's result is its own expression, even as an argument", () => {
  assert.deepEqual(run(program(
    "items is 1, 2",
    "print items:map function takes item return add item, 1",
    "print items:map function takes item return Math.max item, 2",
    "print items:reduce function takes sum, item return sum + item, 10",
    "print items:reduce function takes sum, item return sum + (double item), 0"
  )), [[2, 3], [2, 2], 13, 6]);
  assert.throws(() => transpile(program("items is 1, 2\nprint items:reduce function takes sum, item return double item, 0")), /'double' takes 1 argument/);
});

test("each of spreads into calls that don't have a fixed count", () => {
  assert.deepEqual(run("numbers is 4, 9, 2\nprint Math.max each of numbers\nprint Math.max 1, each of numbers"), [9, 9]);
  assert.throws(() => transpile(program("numbers is 1, 2\nprint add each of numbers")), /'add' takes a fixed number of arguments/);
});

test("the shape of a line doesn't depend on what it imports", () => {
  const source = 'use choose from "./tools.prose"\nprint choose 1, 2';
  const shapeOf = signature => {
    const readModule = () => `export function choose takes ${signature}\n    return 1`;
    return parse(source, { readModule }).at(-1).value.args.length;
  };
  assert.equal(shapeOf("left, right"), 2);
  // An edit to the other file can make this line an error, but never a different program.
  assert.throws(() => shapeOf("only"), /'choose' takes 1 argument/);
});

test("only the imports a file names are read", () => {
  const reads = [];
  const files = {
    "./tools.prose": 'use add from "./deep.prose"\nexport math is object add\nexport function double takes value\n    return value * 2',
    "./deep.prose": 'export function add takes left, right\n    return left + right'
  };
  const readModule = path => { reads.push(path); return files[path]; };
  const { code } = compile('use math, double from "./tools.prose"\nprint math.add 1, 2\nprint double 3', { readModule });
  assert.deepEqual(reads, ["./tools.prose"]);
  assert.match(code, /\[1, 2\]/);
});

test("imports report what's missing without running anything", () => {
  const readModule = () => 'export function double takes value\n    fail "Never runs"';
  assert.throws(() => compile('use missing from "./tools.prose"', { readModule }), /"\.\/tools\.prose" doesn't export 'missing'/);
  assert.throws(() => compile('use double from "./tools.prose"'), /readModule/);
  assert.throws(() => compile('use double from "./tools.prose"', { readModule: () => { throw new Error("gone"); } }), /Can't read "\.\/tools\.prose": gone/);
  assert.match(compile('use double from "./tools.prose"\nprint double 2', { readModule }).code, /_prose_double\(2\)/);
});

test("the formatter keeps calls, parentheses, and with exactly as written", () => {
  const source = program(
    "print (add 1, 2), 3",
    "print add with 1, 2",
    "print double with -1",
    "value is object a is add 1, 2, b is (double 3), c is 4"
  ) + "\n";
  assert.equal(format(source), source);
});

test("declarations describe exported values built from functions", () => {
  const declarations = source => compile(source, { readModule: () => "export calculator is object\n    add is function takes left, right return left" }).declarations;
  assert.match(declarations("export double is function takes value as number giving number return value * 2"),
    /export let double: \(value: number\) => number;/);
  assert.match(declarations("export tools is object\n    add is function takes left as number, right as number giving number return left + right\n    label is 1"),
    /export let tools: \{ "add": \(left: number, right: number\) => number; "label": any; \};/);
  assert.match(declarations("function double takes value as number giving number\n    return value * 2\nexport alias is double"),
    /export let alias: \(value: number\) => number;/);
  assert.match(declarations('use calculator from "./calculator.prose"\nexport math is calculator'),
    /export let math: typeof import\("\.\/calculator\.prose"\)\.calculator;/);
  assert.match(declarations('use calculator from "./calculator.prose"\nexport tools is object calculator'),
    /export let tools: \{ "calculator": typeof import\("\.\/calculator\.prose"\)\.calculator; \};/);
  assert.match(declarations('use calculator from "./calculator.prose"\nexport add is calculator.add'),
    /export let add: \(typeof import\("\.\/calculator\.prose"\)\.calculator\)\["add"\];/);
  assert.match(declarations("export settings is object size is 1"), /export let settings: any;/);
  assert.match(declarations("export count is 1"), /export let count: number;/);
});

test("CLI runs a program that calls through an imported object", () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-calls-"));
  try {
    const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
    writeFileSync(join(folder, "calculator.prose"), "export calculator is object\n    add is function takes left, right return left + right");
    writeFileSync(join(folder, "tools.prose"), 'use calculator from "./calculator.prose"\nexport math is calculator');
    writeFileSync(join(folder, "main.prose"), 'use math from "./tools.prose"\nprint math.add 2, 3\nprint (math.add 2, 3), 9');
    const result = spawnSync(process.execPath, [cli, join(folder, "main.prose"), "--run"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["5", "[ 5, 9 ]"]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
