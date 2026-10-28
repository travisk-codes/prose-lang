import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transpile } from "../src/transpile.js";

function run(source) {
  const output = [];
  runInNewContext(transpile(source), { console: { log: value => output.push(value) } }, { timeout: 1000 });
  return structuredClone(output);
}

test("comma-separated values form arrays with one-based reads and length", () => {
  assert.deepEqual(run([
    'names is "Ada", "Grace", "Linus"', "print length names",
    "print names.1", "print names.2", "print names.3",
    "print names.0", "print names.4"
  ].join("\n")), [3, "Ada", "Grace", "Linus", undefined, undefined]);
});

test("grouping remains a scalar; a trailing comma makes a single-item array", () => {
  assert.deepEqual(run([
    'scalar is ("Ada")', 'one is ("Ada",)', "empty is array",
    "print scalar", "print one", "print length one", "print length empty",
    "print empty.1", "print (1 + 2) * 3"
  ].join("\n")), ["Ada", ["Ada"], 1, 0, undefined, 9]);
});

test("function arity determines comma boundaries and parentheses pass one array argument", () => {
  assert.deepEqual(run([
    "function combine takes first, second", '    return first + second',
    'print combine "Ada", "Grace"',
    "function join takes names", '    return names.1 + names.2',
    'print join ("Ada", "Grace")',
    "function double takes value", "    return value * 2",
    "results is double 2, double 3", "print results",
    "print double 2, 3", "print combine (double 2), (double 3)"
  ].join("\n")), ["AdaGrace", "AdaGrace", [4, 6], [4, 3], 10]);
});

test("arrays preserve element expressions, nesting, booleans, objects and Unicode strings", () => {
  assert.deepEqual(run([
    "person is object", '    name is "Ada"',
    'values is 2 + 3 * 4, (1, 2), person, true, null, "😀"',
    "print values.1", "print (values.2).2", "print values.3:name",
    "print values.4", "print values.5", "print length values.6"
  ].join("\n")), [14, 2, "Ada", true, null, 1]);
});

test("arrays can be returned and stored as object properties", () => {
  assert.deepEqual(run([
    "function pair takes value", "    return value, value + 1",
    "holder is object", "    items is pair 4", '    tags is "a", "b"',
    "print holder:items", "print holder:tags.2"
  ].join("\n")), [[4, 5], "b"]);
});

test("indexed assignment replaces or appends without gaps and allows any element type", () => {
  assert.deepEqual(run([
    "values is array", "values.1 is 2", 'values.2 is "Ada"',
    "values.1 is object", '    name is "Grace"',
    "print length values", "print values.1:name", "print values.2",
    "values.3 is 4, 5", "print values.3"
  ].join("\n")), [2, "Grace", "Ada", [4, 5]]);
  assert.throws(() => run("values is 1, 2\nvalues.4 is 3"), /Line 2:.*gaps/);
  assert.throws(() => run("values is 1, 2\nvalues.0 is 3"), /Line 2:/);
});

test("array mutation and Unicode string writes can be composed through property and index paths", () => {
  assert.deepEqual(run([
    "holder is object", '    names is "a😀", "Grace"',
    'holder:names.(1).2 is "b"', "print holder:names",
    "matrix is (1, 2), (3, 4)", "i is 1", "j is 2",
    "matrix.i.j is 99", "print matrix"
  ].join("\n")), [["ab", "Grace"], [[1, 99], [3, 4]]]);
});

test("for loops can visit array elements using length", () => {
  assert.deepEqual(run([
    "values is 2, 3, 5", "sum is 0", "for i is 1 to length values",
    "    sum is sum + values.i", "print sum"
  ].join("\n")), [10]);
});

test("malformed comma lists and missing function arguments retain line-numbered errors", () => {
  for (const [source, expected] of [
    ["items is 1,", /Line 1: Expected an expression/],
    ["items is 1,,2", /Line 1: Unexpected token/],
    ["items is (,)", /Line 1: Unexpected token/],
    ["function pair takes a, b\n    return a + b\nprint pair 1", /Line 3: Expected ','/],
    ["function pair takes a, b\n    return a + b\nprint pair (1, 2)", /Line 3: Expected ','/]
  ]) assert.throws(() => transpile(source), expected);
});

test("CLI runs the array example", () => {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const example = fileURLToPath(new URL("../examples/arrays.prose", import.meta.url));
  const result = spawnSync(process.execPath, [cli, example, "--run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["Ada", "Grace", "Linus", "Changed", "Changed", "Copied"]);
});

test("arrays are shared references, like objects", () => {
  assert.deepEqual(run([
    "row is 1, 2", "original is row, row", "same is original",
    "same.(1).1 is 99", "print (original.1).1", "print (same.1).1",
    "print (same.2).1", "print row.1",
    "person is object", '    name is "Ada"',
    "people is (person,)", "other is people", 'other.1:name is "Grace"',
    "print people.1:name", "print person:name"
  ].join("\n")), [99, 99, 99, 99, "Grace", "Grace"]);
});

test("arrays stored in object fields and other arrays stay shared with the original", () => {
  assert.deepEqual(run([
    "row is 1, 2", "holder is object", "    values is row",
    "holder:values.1 is 8", "print row.1", "holder:other is row",
    "holder:other.1 is 9", "print row.1",
    "matrix is array", "matrix.1 is row", "matrix.(1).1 is 10", "print row.1"
  ].join("\n")), [8, 9, 10]);
});

test("functions change the arrays they receive, including nested and repeated arguments", () => {
  assert.deepEqual(run([
    "function change takes rows, another",
    "    rows.(1).1 is 99", "    another.(1).1 is 88", "    return rows",
    "original is ((1, 2),)", "changed is change original, original",
    "print (original.1).1", "print (changed.1).1"
  ].join("\n")), [88, 88]);
});

test("comma elements evaluate left to right exactly once", () => {
  assert.deepEqual(run([
    "state is object", "    count is 0",
    "function next", "    state:count is state:count + 1", "    return state:count",
    "values is next run, next run, next run", "print values", "print state:count"
  ].join("\n")), [[1, 2, 3], 3]);
});

test("array elements hold references, so later changes show through them", () => {
  assert.deepEqual(run([
    "state is object", "    values is 1, 2",
    "function mutate", "    state:values.1 is 99", "    return 0",
    "snapshot is state:values, mutate run",
    "print (snapshot.1).1", "print state:values.1"
  ].join("\n")), [99, 99]);
});

test("slice and Array:from make separate copies", () => {
  assert.deepEqual(run([
    "values is 1, 2, 3", "copy is values:slice run", "also is Array:from with values",
    "copy.1 is 10", "also.2 is 20", "print values", "print copy", "print also"
  ].join("\n")), [[1, 2, 3], [10, 2, 3], [1, 20, 3]]);
});
