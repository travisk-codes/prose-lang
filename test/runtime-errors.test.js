import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./run.js";

test("array and string writes reject gaps and bad positions", () => {
  assert.throws(() => run("items is (1, 2)\nitems.4 is 3"), /Line 2: Array writes must replace a position or append at length \+ 1/);
  assert.throws(() => run("items is (1, 2)\nitems.0 is 3"), /Line 2: Array writes must replace a position or append/);
  assert.throws(() => run("items is (1, 2)\nitems.1.5 is 3"), /Line 2: Array writes must replace a position or append/);
  assert.throws(() => run('word is "a"\nword.3 is "c"'), /Line 2: String writes must replace a position or append/);
});

test("runtime helpers report their source line for invalid values", () => {
  assert.throws(() => run('print "a" mod 2'), /Line 1: mod requires numbers/);
  assert.throws(() => run("print 1 mod 0"), /Line 1: mod requires finite numbers and a nonzero divisor/);
  assert.throws(() => run("value is 5\nvalue.name is \"x\""), /Line 2: Named property assignment requires an object/);
  assert.throws(() => run("print each of 5"), /Line 1: Expected a list, text, or other collection/);
  assert.throws(() => run("person is null\nprint person:name"), /Line 2: Can't read property 'name' of null/);
});
