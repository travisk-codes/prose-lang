import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { camel, compile, transpile } from "../src/transpile.js";

function run(source, globals = {}) {
  const output = [];
  runInNewContext(transpile(source), { ...globals, console: { log: value => output.push(value) } }, { timeout: 1000 });
  return structuredClone(output);
}

test("snake_case names are camelCase to JavaScript, acronyms included", () => {
  assert.equal(camel("same_tag_name"), "sameTagName");
  assert.equal(camel("to_locale_lower_case"), "toLocaleLowerCase");
  assert.equal(camel("random_uuid"), "randomUUID");
  assert.equal(camel("to_iso_string"), "toISOString");
  assert.equal(camel("encode_uri_component"), "encodeURIComponent");
  assert.equal(camel("user_id"), "userId");
  assert.equal(camel("sync_server_url"), "syncServerUrl");
  for (const name of ["total", "Math", "MAX_SAFE_INTEGER", "__proto__", "_private", "toUpperCase", "a__b"]) {
    assert.equal(camel(name), name);
  }
});

test("properties, methods, object entries, and globals use the camelCase names", () => {
  assert.deepEqual(run([
    "day is object is_today is true, start_minute is 5", "print day",
    "print day:is_today", "day:end_minute is 9", "print day:end_minute",
    "print \"Hi There\":to_lower_case run", "print \"a-b\":split \"-\"",
    "print Number:is_integer 4", "print Number:MAX_SAFE_INTEGER > 0",
    "print maybe day:missing_value:deeper",
    "record is JSON:parse \"{\\\"user_id\\\": 7}\"", "print record:(\"user_id\")",
    "print record:user_id",
    "print parse_int \"42\""
  ].join("\n")), [
    { isToday: true, startMinute: 5, endMinute: 9 }, true, 9, "hi there", ["a", "b"], true, true, undefined,
    7, undefined, 42
  ]);
});

test("exports, imports, and declarations use camelCase names", () => {
  const { code, declarations } = compile([
    "use format_tag from \"./tags\"",
    "use type DatumTag from \"./types\"",
    "\"How long ago, in words.\"",
    "export function time_since takes start_time as number, now_time as maybe number, giving text",
    "    return format_tag start_time",
    "export default_limit as number is 10",
    "export type Time_span is object",
    "    start_minute as number",
    "    is_today as maybe boolean"
  ].join("\n"));
  assert.match(code, /import \{ formatTag as _prose_format_tag \} from "\.\/tags";/);
  assert.match(code, /export \{ _prose_time_since as timeSince, _prose_default_limit as defaultLimit \};/);
  assert.match(declarations, /\/\*\* How long ago, in words\. \*\/\nexport function timeSince\(startTime: number, nowTime\?: number\): string;/);
  assert.match(declarations, /export let defaultLimit: number;/);
  assert.match(declarations, / {2}startMinute: number;\n {2}isToday\?: boolean;/);
  assert.throws(() => transpile("export same_name is 1\nexport sameName is 2"), /'sameName' is already exported/);
});

test("a line ending in a comma or an operator continues on more indented lines", () => {
  assert.deepEqual(run([
    "function add_all takes first, second,",
    "        third",
    "    return first + second +",
    "        third",
    "print add_all 1, 2,",
    "    3",
    "ready is true and",
    "    false",
    "print ready",
    "words is (\"a\",",
    "    \"b\", \"c\")",
    "print words",
    "label is",
    "    \"long\" + \" text\"",
    "print label",
    "if 1 < 2 and",
    "        2 < 3",
    "    print \"both\"",
    "print (3, 1, 2):to_sorted function takes left, right return",
    "    left - right"
  ].join("\n")), [6, false, ["a", "b", "c"], "long text", "both", [1, 2, 3]]);
});

test("a function header can give each parameter a line, closing with giving", () => {
  const { declarations } = compile([
    "export function create_tags takes",
    "    body as text,",
    "    title as maybe text,",
    "giving list of text",
    "    return (body, title otherwise \"\")",
    "export function untyped takes",
    "    first,",
    "    second",
    "    return first + second"
  ].join("\n"));
  assert.match(declarations, /export function createTags\(body: string, title\?: string\): string\[\];/);
  assert.match(declarations, /export function untyped\(first\?: any, second\?: any\): any;/);
  assert.deepEqual(run("function add takes\n    first,\n    second,\ngiving number\n    return first + second\nprint add 2, 3"), [5]);
});

test("a line doesn't continue onto one that isn't indented more", () => {
  assert.throws(() => transpile("total is 1 +\nprint total"), /Expected an expression/);
  assert.throws(() => transpile("total is (1 +\n2)"), /Expected an expression|Expected '\)'/);
  assert.deepEqual(run("optional is\nprint optional"), [undefined]);
});

test("comment lines in a row document the declaration below them", () => {
  const { declarations } = compile([
    "\"Unrelated.\"",
    "",
    "\"The first line of the description,\"",
    "\"and the second.\"",
    "export function described giving number",
    "    return 1",
    "export type Thing is object",
    "    \"A field that's\"",
    "    \"described twice.\"",
    "    size as number"
  ].join("\n"));
  assert.match(declarations, /\/\*\* The first line of the description, and the second\. \*\/\nexport function described/);
  assert.match(declarations, /\/\*\* A field that's described twice\. \*\/\n {2}size: number;/);
  assert.doesNotMatch(declarations, /Unrelated/);
});
