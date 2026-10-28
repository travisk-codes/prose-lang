import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile, transpile } from "../src/transpile.js";

function run(source) {
  const output = [];
  runInNewContext(transpile(source), { console: { log: value => output.push(value) } }, { timeout: 1000 });
  return structuredClone(output);
}

test("unset is a value, and otherwise replaces only unset and null", () => {
  assert.deepEqual(run([
    "nothing is unset", "print nothing = unset", "print nothing otherwise 1",
    "print null otherwise 2", "print 0 otherwise 3", 'print "" otherwise 4',
    "print false or 5", "print unset otherwise null otherwise 6"
  ].join("\n")), [true, 1, 2, 0, "", 5, 6]);
});

test("inline if expressions choose a value and extend to the end of the expression", () => {
  assert.deepEqual(run([
    "count is 1", 'print count + " " + (if count = 1 then "entry" else "entries")',
    'label is if count > 1 then "many" else if count = 1 then "one" else "none"', "print label",
    "print if false then 1 else 2 + 3"
  ].join("\n")), ["1 entry", "one", 5]);
});

test("for each visits arrays, Unicode strings, and map entries, and its variables persist", () => {
  assert.deepEqual(run([
    "total is 0", "for each value in 2, 3, 5", "    total is total + value", "print total", "print value",
    "letters is array", 'for each letter in "a😀"', "    letters:push with letter", "print letters",
    "scores is new Map", 'scores:set with "Ada", 3', 'scores:set with "Grace", 4',
    "for each name, score in scores", '    print name + ": " + score'
  ].join("\n")), [10, 5, ["a", "😀"], "Ada: 3", "Grace: 4"]);
  assert.throws(() => run("for each value in 5\n    print value"), /Line 1: 'for each' requires an array/);
  assert.throws(() => transpile("for each a, a in pairs\n    print a"), /Line 1: Duplicate loop variable name/);
});

test("methods use with for arguments and run for none, on strings, arrays, and objects", () => {
  assert.deepEqual(run([
    'name is "Ada Lovelace"', "print name:toUpperCase run", 'print name:startsWith with "Ada"',
    'print name:slice with 0, 3', "print name:length",
    'words is "a", "b", "c"', 'print words:join with "-"', "print (words:slice with 1):join run",
    "print (words:indexOf with \"b\") + 1", "print words:includes with \"z\""
  ].join("\n")), ["ADA LOVELACE", true, "Ada", 12, "a-b-c", "b,c", 2, false]);
});

test("JavaScript globals and new are available when no Prose variable has the name", () => {
  assert.deepEqual(run([
    "print Math:max with 3, 9, 4", "print Math:round with (10 / 4)",
    "print JSON:stringify with (1, 2)", 'print Number:isFinite with 5',
    'seen is new Set with ("a", "b", "a")', "print seen:size", "print Array:from with seen",
    "empty is new Map", "print empty:size"
  ].join("\n")), [9, 3, "[1,2]", true, 2, ["a", "b"], 0]);
  assert.deepEqual(run([
    "function local_math", "    Math is 2", "    return Math",
    "print local_math run", "print Math:abs with -3"
  ].join("\n")), [2, 3]);
  assert.deepEqual(run("Math is 5\nprint Math"), [5]);
});

test("unknown names are compile errors with the line that reads them", () => {
  for (const [source, expected] of [
    ["x is 1\nprint x + typo", /Line 2: Unknown name 'typo'/],
    ["function f\n    return total\nprint f run", /Line 2: Unknown name 'total'/],
    ["items is array\nitems:push with mising", /Line 2: Unknown name 'mising'/],
    ["missing.1 is \"a\"", /Line 1: Unknown name 'missing'/],
    ["Math.1 is 2", /Line 1: 'Math' belongs to JavaScript/],
    ["seen is new Sett", /Line 1: Unknown name 'Sett'/]
  ]) assert.throws(() => transpile(source), expected);
});

test("Prose functions accept with, which may leave trailing arguments unset", () => {
  assert.deepEqual(run([
    "function pluralize takes count, singular, plural",
    '    if plural = unset plural is singular + "s"',
    '    return count + " " + (if count = 1 then singular else plural)',
    'print pluralize with 1, "tag"', 'print pluralize with 2, "tag"',
    'print pluralize with 3, "entry", "entries"', 'print pluralize 3, "box", "boxes"'
  ].join("\n")), ["1 tag", "2 tags", "3 entries", "3 boxes"]);
  assert.throws(() => transpile("function f takes x\n    return x\nprint f with 1, 2"), /Line 3: 'f' takes 1 argument/);
  assert.throws(() => transpile("print length with \"a\", \"b\""), /Line 1: 'length' takes 1 argument/);
});

test("inline functions are values that can be passed, stored, and called", () => {
  assert.deepEqual(run([
    "values is 3, 1, 2",
    "doubled is values:map with function takes value return value * 2", "print doubled",
    "values:sort with function takes left, right return left - right", "print values",
    "big is values:filter with function takes value return value > 1", "print big",
    "total is values:reduce with function takes sum, value return sum + value, 10", "print total",
    "shout is function takes text return text:toUpperCase run", 'print shout with "hi"',
    "seven is function return 7", "print seven run"
  ].join("\n")), [[6, 2, 4], [1, 2, 3], [2, 3], 16, "HI", 7]);
});

test("functions with indented bodies can sit anywhere on their line, and read outer variables", () => {
  assert.deepEqual(run([
    "prefix is \"#\"",
    "labels is (\"a\", \"b\"):map with function takes value, position",
    "    label is prefix + value",
    "    if position = 0 return label + \"!\"",
    "    return label",
    "print labels",
    "calls is array",
    "function later takes callback, delay",
    "    calls:push with delay",
    "    return callback run",
    "print later with function, 5",
    "    return \"ran\"",
    "print calls"
  ].join("\n")), [["#a!", "#b"], "ran", [5]]);
});

test("assignments inside a function value create its own locals", () => {
  assert.deepEqual(run([
    "count is 1",
    "bump is function",
    "    count is 100",
    "    return count",
    "print bump run", "print count",
    "seen is array",
    "remember is function takes value return seen:push with value",
    "remember with 4", "print seen"
  ].join("\n")), [100, 1, [4]]);
});

test("indented function bodies are rejected where another body is expected", () => {
  for (const [source, expected] of [
    ["items is array\nif items:some with function takes x\n    return x", /Line 2:.*can't be part of an if/],
    ["items is array\nif true items:map with function takes x\n    return x", /Line 2:.*line of its own/],
    ["a is function, function\n    return 1", /Line 1: Only one indented body/],
    ["f is function takes x, x return x", /Line 1: Duplicate parameter name/],
    ["function g\n    return 1\nf is function takes g return g", /Line 3:.*conflicts with a function name/]
  ]) assert.throws(() => transpile(source), expected);
});

test("calls and methods on the wrong values report the line", () => {
  for (const [source, expected] of [
    ["value is 5\nvalue with 1", /Line 2: Only functions can be called/],
    ['name is "Ada"\nname:shout run', /Line 2: 'shout' is not a function/],
    ["thing is unset\nthing:go run", /Line 2: Can't read property 'go' of unset/],
    ["maker is 5\nmade is new maker", /Line 2: 'new' requires a class or constructor/]
  ]) assert.throws(() => run(source), expected);
});

test("property assignment uses JavaScript setters, except for __proto__", () => {
  assert.deepEqual(run([
    "log is array", "target is object",
    "accessor is object",
    "    set is function takes value return log:push with value",
    '    get is function return "from getter"',
    'Object:defineProperty with target, "name", accessor',
    'target:name is "Ada"', "print log", "print target:name",
    'plain is object', 'plain:__proto__ is "data"', "print plain:__proto__",
    "print Object:getPrototypeOf with plain = Object:prototype"
  ].join("\n")), [["Ada"], "from getter", "data", true]);
});

test("strings, numbers, and functions have readable properties; writes still require objects", () => {
  assert.deepEqual(run([
    'print "abc":length', "print (12.345):toFixed with 1", "print Math:max:name"
  ].join("\n")), [3, "12.3", "max"]);
  assert.throws(() => run('word is "abc"\nword:size is 2'), /Line 2: Named property assignment requires an object/);
});

test("modules import and export, and compile reports when the output is a module", async () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-modules-"));
  try {
    writeFileSync(join(folder, "helpers.mjs"), 'export const double = value => value * 2;\nexport const unit = "px";\n');
    const source = [
      "use double, unit from \"./helpers.mjs\"",
      "export function size takes value", "    return (double with value) + unit",
      "export limit is size 10",
      "export function sizes takes values",
      "    return values:map with function takes value return size value"
    ].join("\n");
    const { code, module } = compile(source);
    assert.equal(module, true);
    assert.match(code, /import \{ double as _prose_double, unit as _prose_unit \} from "\.\/helpers\.mjs";/);
    assert.match(code, /export \{ _prose_size as size, _prose_limit as limit, _prose_sizes as sizes \};/);
    writeFileSync(join(folder, "sizes.mjs"), code);
    const loaded = await import(pathToFileURL(join(folder, "sizes.mjs")).href);
    assert.equal(loaded.size(4), "8px");
    assert.equal(loaded.limit, "20px");
    assert.deepEqual(loaded.sizes([1, 2]), ["2px", "4px"]);
    assert.equal(compile("print 1").module, false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the runtime option imports the helpers instead of embedding them", async () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-runtime-"));
  try {
    const runtime = new URL("../src/runtime.js", import.meta.url).href;
    const code = transpile('export function initial takes word\n    return word.1', { runtime });
    assert.doesNotMatch(code, /function __prose_get/);
    assert.match(code, /import \{ __prose_chars, .*__prose_each \} from "file:/);
    writeFileSync(join(folder, "initial.mjs"), code);
    const loaded = await import(pathToFileURL(join(folder, "initial.mjs")).href);
    assert.equal(loaded.initial("😀a"), "😀");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("arithmetic right after with arguments is a compile error that suggests both readings", () => {
  for (const source of [
    "counts is new Map\ncounts:set with 1, 2 + 1",
    "counts is new Map\nx is (counts:get with 1) otherwise 0\ny is counts:get with x - 1",
    "print Math:round with 10 / 4",
    "print Math:max with 1, 2 * 3",
    "items is array\nprint items:indexOf with 3 mod 2",
    "function f takes a, b\n    return a\nprint f with 1, 2 + 3",
    "print new Date with 0 + 1"
  ]) assert.throws(() => transpile(source), /ambiguous\. Put the last argument in parentheses/, source);
  assert.deepEqual(run([
    "counts is new Map", "counts:set with \"a\", (2 + 1)", "print (counts:get with \"a\") + 1",
    "print Math:round with (10 / 4)", "print (Math:round with 10) / 4",
    "print counts:get with \"a\" = 3", "print counts:get with \"z\" otherwise 0",
    "print counts:has with \"a\" and true"
  ].join("\n")), [4, 3, 2.5, true, 0, true]);
});

test("a call with several with arguments inside another call's arguments needs parentheses", () => {
  for (const source of [
    "print Math:max with Math:min with 1, 2",
    "print Math:max with 0, Math:min with 1, 2",
    "function f takes a, b\n    return a\nprint f 1, Math:min with 2, 3",
    "items is (1, 2)\nprint items:map with function takes x return Math:max with x, 1"
  ]) assert.throws(() => transpile(source), /needs parentheses: \(f with a, b\)/, source);
  assert.deepEqual(run([
    "print Math:max with (Math:min with 1, 2), 5", "print Math:max with 0, (Math:min with 1, 2)",
    "print Math:abs with Math:min with -4", "print (Math:min with 3, 4)",
    "items is (1, 2)", "print items:map with function takes x return (Math:max with x, 2)"
  ].join("\n")), [5, 1, 4, 3, [2, 2]]);
});

test("maybe gives unset when any step of its chain is unset or null", () => {
  assert.deepEqual(run([
    "person is object", '    name is "Ada"', "    address is null",
    "print maybe person:address:city", 'print maybe person:address:city otherwise "no city"',
    "print maybe person:name:toUpperCase run", "print maybe person:nickname:toUpperCase run",
    "nothing is unset", "print maybe nothing.1", "print maybe person:name.1",
    "callback is unset", "maybe callback run", "print maybe callback run",
    "callback is function return \"called\"", "print maybe callback run",
    "count is 0", "function bump", "    count is count + 1", "    return count",
    "maybe nothing:go with (bump run)", "print count",
    "print (maybe person:address:city) = unset"
  ].join("\n")), [undefined, "no city", "ADA", undefined, undefined, "A", undefined, "called", 0, true]);
});

test("maybe keeps real errors: a value that exists but can't be called, and reads outside its chain", () => {
  assert.throws(() => run('name is "Ada"\nmaybe name:length run'), /Line 2: Only functions can be called|'length' is not a function/);
  assert.throws(() => run("person is null\nprint (maybe person:name) + person:age"), /Line 2: Can't read property 'age' of null/);
});

function moduleFiles(files) {
  return { readModule: specifier => {
    if (!Object.hasOwn(files, specifier)) throw new Error("no such file");
    return files[specifier];
  } };
}

test("functions imported from Prose files are called like local ones, with their own argument counts", () => {
  const files = {
    "./math.prose": [
      "export function twice takes value", "    return value * 2",
      "export function add takes left, right", "    return left + right",
      "export unit is \"px\"", "function hidden", "    return 1"
    ].join("\n")
  };
  const { code } = compile([
    'use twice, add, unit from "./math.prose"',
    "print twice 3 + 1", "print add 1, twice 2", "print add with 1", "print unit"
  ].join("\n"), moduleFiles(files));
  assert.match(code, /import \{ twice as _prose_twice, add as _prose_add, unit as _prose_unit \} from "\.\/math\.prose";/);
  assert.match(code, /console\.log\(\(_prose_twice\(3\) \+ 1\)\);/);
  assert.match(code, /console\.log\(_prose_add\(1, _prose_twice\(2\)\)\);/);
  assert.match(code, /console\.log\(_prose_add\(1\)\);/);
  assert.match(code, /console\.log\(_prose_unit\);/);
});

test("Prose imports report missing exports, conflicts, and unreadable files", () => {
  const files = { "./math.prose": "export function twice takes value\n    return value * 2\nfunction hidden\n    return 1" };
  for (const [source, expected] of [
    ['use hidden from "./math.prose"', /Line 1: "\.\/math\.prose" doesn't export 'hidden'/],
    ['use twice from "./missing.prose"', /Line 1: Can't read "\.\/missing\.prose": no such file/],
    ['function twice\n    return 1\nuse twice from "./math.prose"', /Line 3: Duplicate function 'twice'/],
    ['use twice from "./math.prose"\ntwice is 2', /Line 2:.*conflicts with a function name/],
    ['use twice from "./math.prose"\nfunction f takes twice\n    return 1', /Line 2:.*conflicts with a function name/]
  ]) assert.throws(() => compile(source, moduleFiles(files)), expected);
  assert.throws(() => compile('use twice from "./math.prose"'), /Line 1: To import "\.\/math\.prose", compile with a readModule option/);
  assert.throws(() => compile('use twice from "./bad.prose"', moduleFiles({ "./bad.prose": 'export function twice takes "x"' })),
    /Line 1: In "\.\/bad\.prose", Line 1: Expected a variable name/);
});

test("the CLI runs programs whose Prose files import each other, and prints their compiled JavaScript", () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-cli-"));
  try {
    writeFileSync(join(folder, "shapes.prose"), [
      'use describe from "./words.prose"',
      "export function area takes width, height", "    return width * height",
      "export function label takes width, height", "    return describe (area width, height)"
    ].join("\n"));
    writeFileSync(join(folder, "words.prose"), 'export function describe takes amount\n    return "area " + amount');
    writeFileSync(join(folder, "main.prose"), 'use area, label from "./shapes.prose"\nprint area 3, 4\nprint label 2, 5');
    const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
    const result = spawnSync(process.execPath, [cli, join(folder, "main.prose"), "--run"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["12", "area 10"]);
    const compiled = spawnSync(process.execPath, [cli, join(folder, "main.prose")], { encoding: "utf8" });
    assert.match(compiled.stdout, /console\.log\(_prose_area\(3, 4\)\);/);
    writeFileSync(join(folder, "broken.prose"), 'use area from "./shapes.prose"\nprint area with 1, 2, 3');
    const broken = spawnSync(process.execPath, [cli, join(folder, "broken.prose"), "--run"], { encoding: "utf8" });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /Line 2: 'area' takes 2 arguments/);
    writeFileSync(join(folder, "crash.prose"), "value is 5\nvalue run");
    const crash = spawnSync(process.execPath, [cli, join(folder, "crash.prose"), "--run"], { encoding: "utf8" });
    assert.equal(crash.status, 1);
    assert.equal(crash.stderr.trim(), "Line 2: Only functions can be called.");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

function runExample(name) {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const example = fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
  const result = spawnSync(process.execPath, [cli, example, "--run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/);
}

test("CLI runs the two-file habits example", () => {
  assert.deepEqual(runExample("habits.prose"), [
    "- Stretch: 3 days in a row (steady)", "  notes: stiff; loose",
    "- Read: 5 days in a row (on fire)", "  notes: two chapters",
    "- Walk: 1 day in a row (starting)", "* Read: 3 days in a row (steady)",
    "Swim days: none yet", "Day 3 is check-in number 3"
  ]);
});

test("CLI runs the tour of every feature", () => {
  assert.deepEqual(runExample("tour.prose"), [
    "42", 'She said "hi"!', "true", "12", "-10", "2", "2", "-1", "25", "true", "or fallback",
    "otherwise fallback", "0", "small", "medium", "large", "inline if statement", "inline else if",
    "big ratio", "10", "3", "2", "1", "a", "😀", "first 1", "second 2", "120", "7", "7", "announcing",
    "Hello, Ada!", "Hello, Grace?", "Hello", "today.txt", "5", "😀", "65", "a", "H😀llo!", "ok",
    "London", "Eda of Paris", "later", "true", "7", "4", "3", "2", "3", "[ 30, 1, 2, 4 ]", "300",
    "[ 1, 2, 4, 30 ]", "[ 2, 4, 30 ]", "#1=1, #2=2, #3=4, #4=30", "81", "7", "81", "ran after 5",
    "9", "3.0", "PROSE", '{"x":3,"y":4}', "2", "value!", "6", "undefined", "no city", "GRACE", "0",
    "no tags", "no callback", "Tour stops: 14, tour 1"
  ]);
});

test("CLI runs the reading list example", () => {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const example = fileURLToPath(new URL("../examples/reading_list.prose", import.meta.url));
  const result = spawnSync(process.execPath, [cli, example, "--run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    "Finished: Middlemarch, Beloved", "Middlemarch (long), Piranesi, Beloved",
    "read: 2", "to read: 1", "Average pages: 492", "DONE", "Abandoned: 0"
  ]);
});

test("module statements report misuse with source lines", () => {
  for (const [source, expected] of [
    ["function f\n    use a from \"x\"\n    return 1", /Line 2: 'use' is only allowed at the top level/],
    ["function f\n    export x is 1\n    return 1", /Line 2: Only top-level functions and variables can be exported/],
    ["export print 1", /Line 1: Only functions and variables can be exported/],
    ["use a from x", /Line 1: Expected a quoted module path/],
    ["use a \"x\"", /Line 1: Expected 'from'/],
    ["use a from \"x\"\na is 1", /Line 2: 'a' is imported/],
    ["use a from \"x\"\nuse a from \"y\"", /Line 2: 'a' is already imported/],
    ["use a from \"x\"\na.1 is \"b\"", /Line 2: 'a' is imported, so its positions/],
    ["use length from \"x\"", /Line 1:.*conflicts with a function name/],
    ["export x is 1\nexport x is 2", /Line 2: 'x' is already exported/]
  ]) assert.throws(() => transpile(source), expected);
});
