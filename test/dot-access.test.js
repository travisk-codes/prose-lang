import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { compile, transpile } from "../src/transpile.js";

function run(source, globals = {}) {
  const output = [];
  runInNewContext(transpile(source), { ...globals, console: { log: (...values) => output.push(...values) } }, { timeout: 1000 });
  return structuredClone(output);
}

test("dots read and write named properties, including chains, keywords, and camelCase", () => {
  assert.deepEqual(run([
    'person is object name is "Ada", address is object city is "London"',
    'person.address.city is "Paris"', 'person.first_name is "Ada"',
    'person.is is true', 'print person.name', 'print person.address.city',
    'print person.first_name', 'print person.is', 'print person.missing'
  ].join("\n")), ["Ada", "Paris", "Ada", true, undefined]);
});

test("numeric variables select one-based positions inside and outside loops", () => {
  assert.deepEqual(run([
    'people is "Ada", "Grace", "Linus"', 'i is 2', 'print people.i',
    'for i is 1 to length people', '    print people.i',
    'i is 3', 'people.i is "Margaret"', 'i is 4', 'people.i is "Katherine"',
    'print people.3', 'print people.4', 'print people.length'
  ].join("\n")), ["Grace", "Ada", "Grace", "Linus", "Margaret", "Katherine", 4]);
});

test("unbound and nonnumeric variables leave the property name literal", () => {
  assert.deepEqual(run([
    'person is object name is "Ada", age is 36', 'name is "age"',
    'print person.name', 'function rename takes person, name',
    '    person.name is name', 'rename person, "Grace"', 'print person.name',
    'print person.age', 'i is "another property"', 'person.i is "literal i"', 'print person.i'
  ].join("\n")), ["Ada", "Grace", 36, "literal i"]);
});

test("parameters, closures, and shadowed bindings use their current numeric values", () => {
  assert.deepEqual(run([
    'function pick takes items, index', '    return items.index',
    'items is "first", "second"', 'print pick items, 2', 'i is 2',
    'reader is function return items.i', 'print reader run',
    'reader is function takes i return items.i', 'print reader 1',
    'i is "named"', 'items.i is "property"', 'print items.i', 'print items.2'
  ].join("\n")), ["second", "second", "first", "property", "second"]);
});

test("nested dot writes preserve shared arrays and Unicode text positions", () => {
  assert.deepEqual(run([
    'holder is object names is ("a😀z", "Grace")', 'alias is holder.names',
    'i is 1', 'j is 2', 'holder.names.i.j is "b"', 'print alias.i',
    'j is 4', 'holder.names.i.j is "!"', 'print holder.names.i',
    'word', 'word.i is "😀"', 'print word', 'print length word'
  ].join("\n")), ["abz", "abz!", "😀", 1]);
});

test("dot methods preserve their receiver and numeric positions can hold functions", () => {
  const counter = { value: 4, add(amount) { this.value += amount; return this.value; } };
  const handlers = [function (amount) { return this.length + amount; }];
  assert.deepEqual(run([
    'items is 1, 2', 'items.push with 3', 'print items.length',
    'print items.pop run', 'print "hello".to_upper_case run',
    'print globalThis.counter.add with 2', 'i is 1', 'print globalThis.handlers.i with 3'
  ].join("\n"), { counter, handlers }), [3, 3, "HELLO", 6, 4]);
  assert.equal(counter.value, 6);
});

test("maybe short-circuits dotted properties, indexes, keys, and call arguments", () => {
  assert.deepEqual(run([
    'state is object calls is 0', 'function bump takes state',
    '    state.calls is state.calls + 1', '    return 1',
    'missing is null', 'i is 1', 'print maybe missing.people.i.name',
    'print maybe missing.(bump state)', 'callbacks is array',
    'print maybe callbacks.i with (bump state)', 'print state.calls'
  ].join("\n")), [undefined, undefined, undefined, 0]);
});

test("dotted assignments evaluate getters and keys once, before the right-hand side", () => {
  const events = [];
  let text = "a😀z";
  const state = {
    get text() { events.push("get"); return text; },
    set text(value) { events.push("set"); text = value; }
  };
  run('i is 2\nglobalThis.state.text.i is globalThis.next run', {
    state, next() { events.push("rhs"); return "b"; }
  });
  assert.equal(text, "abz");
  assert.deepEqual(events, ["get", "rhs", "set"]);
  events.length = 0;
  run('globalThis.state.text.(globalThis.key run) is globalThis.next run', {
    state, key() { events.push("key"); return 1; }, next() { events.push("rhs"); return "x"; }
  });
  assert.deepEqual(events, ["get", "key", "rhs", "set"]);
  assert.equal(text, "xbz");
});

test("computed dot keys support dictionaries and an explicit literal-name escape", () => {
  assert.deepEqual(run([
    'counts is object', 'word is "hello"', 'counts.(word) is 2',
    'print counts.(word)', 'i is 1', 'counts.("i") is "literal"',
    'print counts.("i")', 'counts.(1) is "number key"', 'print counts.i', 'print counts.(i)'
  ].join("\n")), [2, "literal", "literal", "number key"]);
});

test("new, class tests, and type namespaces accept dots", () => {
  class Example { constructor(value) { this.value = value; } }
  assert.deepEqual(run([
    'Classes is globalThis.classes', 'item is new Classes.Example with 7', 'print item.value',
    'print item is a Classes.Example'
  ].join("\n"), { classes: { Example } }), [7, true]);
  const { declarations } = compile('export function formatter takes options as Intl.DateTimeFormatOptions, giving Intl.DateTimeFormat\n    return new Intl.DateTimeFormat with "en", options');
  assert.match(declarations, /options: Intl\.DateTimeFormatOptions/);
  assert.match(declarations, /\): Intl\.DateTimeFormat;/);
});

test("invalid numeric writes and null access retain their source lines", () => {
  assert.throws(() => run('items is 1, 2\ni is 4\nitems.i is 9'), /Line 3:.*gaps/);
  assert.throws(() => run('word is "a"\ni is 0\nword.i is "b"'), /Line 3:.*gaps/);
  assert.throws(() => run('word is "a"\ni is 1\nword.i is "two"'), /Line 3:.*one Unicode code point/);
  assert.throws(() => run('person is null\nprint person.name'), /Line 2:.*property 'name' of null/);
});

test("imported objects and arrays can mutate while imported text cannot be rebound", () => {
  const execute = (source, values) => runInNewContext(
    transpile(source).split("\n").filter(line => !line.startsWith("import ")).join("\n"), values
  );
  const items = [1, 2];
  execute('use items from "./values.js"\ni is 1\nitems.i is 8', { _prose_items: items });
  assert.deepEqual(items, [8, 2]);
  assert.throws(() => execute('use word from "./values.js"\ni is 1\nword.i is "x"', { _prose_word: "abc" }), /Line 3:.*imported/);
});

test("legacy colon properties keep their literal meaning during migration", () => {
  assert.deepEqual(run([
    'person is object age is 36', 'age is 1', 'print person:age',
    'person.age is 99', 'print person.age', 'print person:age',
    'person.(age) is "numeric key"', 'print person.(1)'
  ].join("\n")), [36, 99, 99, "numeric key"]);
});

test("the same numeric variable indexes lists and text but names a literal object field", () => {
  assert.deepEqual(run([
    'function pick takes value, i', '    return value.i',
    'people is "Ada", "Grace"', 'record is object i is "named"',
    'record.(2) is "numeric"', 'print pick people, 2', 'print pick "a😀z", 2',
    'print pick record, 2', 'i is 2', 'print record.(i)'
  ].join("\n")), ["Grace", "😀", "named", "numeric"]);
});

test("outer numeric variables do not hijack object reads, writes, methods, or maybe access", () => {
  assert.deepEqual(run([
    'pages is 324', 'describe is 1',
    'book is object pages is 880, describe is function return "book"',
    'reader is function takes book return book.pages', 'print reader book',
    'book.pages is 900', 'print book.pages', 'print maybe book.pages',
    'print book.describe run', 'print maybe book.describe run',
    'i is 2', 'items is (object i is "first"), (object i is "second")',
    'print items.i.i', 'items.i.i is "updated"', 'print items.2.i'
  ].join("\n")), [880, 900, 900, "book", "book", "second", "updated"]);
});

test("literal object access does not evaluate a same-named imported index candidate", () => {
  const output = [];
  const context = { console: { log: value => output.push(value) } };
  Object.defineProperty(context, "_prose_pages", { get() { throw new Error("Index candidate was read"); } });
  const code = transpile('use pages from "./values.js"\nbook is object pages is 880\nprint book.pages')
    .split("\n").filter(line => !line.startsWith("import ")).join("\n");
  runInNewContext(code, context);
  assert.deepEqual(output, [880]);
});
