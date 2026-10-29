import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { format } from "../src/format.js";
import { compile, parse, sourceLines } from "../src/transpile.js";

const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
const meaning = source => JSON.stringify(parse(source), (key, value) => key === "line" ? undefined : value);

function layout(source, expected, options = {}) {
  const formatted = format(source, options);
  assert.equal(formatted, expected);
  assert.equal(meaning(formatted), meaning(source));
  assert.equal(format(formatted, options), formatted);
  assert.ok(formatted.split("\n").every(line => line.length <= (options.width ?? 80)), formatted);
}

test("long function headers put each parameter on its own line and align giving", () => {
  layout(
    'export function create_note_tags takes body as text, title as maybe text, labels as maybe list of text, giving list of DatumTag\n    return array',
    'export function create_note_tags takes\n    body as text,\n    title as maybe text,\n    labels as maybe list of text,\ngiving list of DatumTag\n    return array\n'
  );
  layout(
    'export function is_numeric_selection takes entries as list of Entry, giving boolean\n    return true',
    'export function is_numeric_selection takes\n    entries as list of Entry,\ngiving boolean\n    return true\n'
  );
});

test("short function headers stay on one line, including after spacing normalization", () => {
  const source = 'export function is_note takes datum as Datum, giving boolean\n    return true\n';
  layout(source, source);
  layout('function   greet   takes   name   as   text,   giving   text\n    return name',
    'function greet takes name as text, giving text\n    return name\n', { width: 48 });
});

test("fitting wrapped headers and expressions retain their breaks and continuation indentation", () => {
  const source = [
    'function greet takes',
    '      name as text,',
    'giving text',
    '    return name',
    'result is first_choice or',
    '',
    '      second_choice or',
    '          last_choice',
    'listed is labels:some function takes label return',
    '      label = name',
    'lines is (items:map function takes line return',
    '      (line:replace pattern "[ ]+" everywhere, " "):trim_end run)',
    ''
  ].join('\n');
  layout(source, source);
  const crlf = source.replace(/\n/g, '\r\n');
  layout(crlf, crlf);
});

test("spacing and indentation normalization never make a fitting line overflow", () => {
  const source = 'value is 1+2+3+4+5+6\n';
  layout(source, source, { width: 25 });
  const indented = 'callback is function takes word\n  if word = "" return unset\n  return word.to_upper_case run\n';
  layout(indented, indented, { width: 32 });
  const continuation = 'function greet\n  message is\n    "hello"\n';
  layout(continuation, continuation);
  layout(continuation, continuation, { tabWidth: 2, insertSpaces: false });
  const tabs = 'result is first_choice or\n\tsecond_choice or\n\t\tlast_choice\n';
  layout(tabs, tabs, { insertSpaces: false });
});

test("long logical chains prefer or and otherwise to and, with level continuation indentation", () => {
  layout(
    'function accepts takes entry\n    return entry:active and entry:visible or entry:archived and entry:owned or entry:shared and entry:enabled',
    'function accepts takes entry\n    return entry:active and entry:visible or\n        entry:archived and entry:owned or\n        entry:shared and entry:enabled\n',
    { width: 60 }
  );
  layout('result is first_choice otherwise second_choice otherwise third_choice',
    'result is first_choice otherwise\n    second_choice otherwise third_choice\n', { width: 48 });
});

test("long and chains break after and without stepping right on later lines", () => {
  layout('result is first_condition and second_condition and third_condition and fourth_condition',
    'result is first_condition and\n    second_condition and third_condition and\n    fourth_condition\n', { width: 48 });
});

test("long lambdas break after return before splitting their body's call arguments", () => {
  const prefix = 'function same_tag_name takes label, name\n    return label = name\nfunction check takes labels, name\n';
  layout(prefix + '    listed is labels:some function takes label return same_tag_name label, name',
    prefix + '    listed is labels:some function takes label return\n        same_tag_name label, name\n', { width: 72 });
  layout('result is (items:map function takes line return (line:replace pattern "[ ]+" everywhere, " "):trim_end run)',
    'result is (items:map function takes line return\n    (line:replace pattern "[ ]+" everywhere, " "):trim_end run)\n');
});

test("reflow prefers outer call arguments and object entries to nested call arguments", () => {
  layout('result is combine (normalize first_argument, second_argument), third_argument, fourth_argument',
    'result is combine (normalize first_argument, second_argument),\n    third_argument, fourth_argument\n', { width: 76 });
  layout('result is object first is (normalize first_argument, second_argument), second is third_argument',
    'result is object first is (normalize first_argument, second_argument),\n    second is third_argument\n', { width: 76 });
  layout('result is items:map function takes item\n    average is window_average series, (date_from_key key), window, missing_as_zero\n    return average',
    'result is items:map function takes item\n    average is window_average series, (date_from_key key), window,\n        missing_as_zero\n    return average\n', { width: 72 });
});

test("header reflow preserves function and tuple parameter types and optional giving", () => {
  layout('function transform takes callback as function taking text giving number, pair as (text, number), giving number\n    return 1',
    'function transform takes\n    callback as function taking text giving number,\n    pair as (text, number),\ngiving number\n    return 1\n');
  layout('function combine_words takes first_word as text, second_word as text\n    return first_word + second_word',
    'function combine_words takes\n    first_word as text,\n    second_word as text\n    return first_word + second_word\n', { width: 40 });
  layout('function greeting giving text\n    return "hello"',
    'function greeting giving\n    text\n    return "hello"\n', { width: 24 });
});

test("format normalizes spacing, indentation, blank lines, and the final newline", () => {
  const before = '\nfunction  shout takes text\n\treturn   text . to_upper_case  run   \n\n\nprint  shout   "done"';
  assert.equal(format(before), 'function shout takes text\n    return text.to_upper_case run\n\nprint shout "done"\n');
  assert.equal(format("  \n\t\r\n"), "");
  assert.equal(format("\uFEFFprint  1"), "print 1\n");
});

test("format wraps nested expressions, headers, calls, and postfix conditionals safely", () => {
  const source = [
    "function join_words takes first_word as text, second_word as text, giving text",
    '    return first_word + " " + second_word',
    'message is join_words "Hello there", "Prose reader"',
    'words is "first word", "second word", "third word", "fourth word"',
    'label is message if length words > 2 else "nothing to see here"',
    'point is object x is 1, y is 2, describe is function takes value',
    '    return value.x + value.y',
    'print point.describe point'
  ].join("\n");
  const formatted = format(source, { width: 40 });
  assert.equal(meaning(formatted), meaning(source));
  assert.ok(formatted.split("\n").every(line => line.length <= 40), formatted);
  assert.match(formatted, /takes\n    first_word as text,\n/);
  assert.equal(format(formatted, { width: 40 }), formatted);
});

test("format preserves parentheses, unary minus, subtraction, accessors, and function references", () => {
  const source = [
    "function twice takes value", "    return value*2", "value is 5",
    "print value-1", "print value - 1", "print - 1", "print -value",
    "print value* - 2", "print twice (-1)", "print (twice value) + 1",
    "items is 1, 2", "print items.at with -1", "print items : length",
    'matrix is ("first", "second"), ("third", "fourth")', 'print matrix.1 .2',
    'name is "Ada"', "action is name . to_upper_case", "print name.to_upper_case run",
    'person is object name is "Grace"', 'key is "name"', "print person . (key)"
  ].join("\n");
  const formatted = format(source, { width: 20 });
  assert.match(formatted, /print value - 1/);
  assert.match(formatted, /print -1/);
  assert.match(formatted, /action is\s+name.to_upper_case/);
  assert.match(formatted, /print person.\(key\)/);
  const run = text => {
    const output = [];
    runInNewContext(compile(text).code, { console: { log: value => output.push(value) } });
    return output;
  };
  assert.deepEqual(run(formatted), run(source));
});

test("format never splits or rewrites strings, escapes, or regular expression patterns", () => {
  const source = String.raw`"A long standalone comment that stays on one line because it is a string."
word is "hello, \"Prose\" 😀"
print word.replace (pattern "\s+" everywhere), "-"
print 0001.00`;
  const formatted = format(source, { width: 30 });
  assert.ok(formatted.includes(String.raw`"hello, \"Prose\" 😀"`));
  assert.ok(formatted.includes(String.raw`pattern "\s+"`));
  assert.ok(formatted.includes("0001.00"));
  assert.equal(formatted.split("\n")[0], source.split("\n")[0]);
  assert.equal(meaning(formatted), meaning(source));
});

test("format preserves documentation, types, object bodies, and inline function bodies", () => {
  const source = [
    '"A greeting."', 'export type Greeting is object', '  "Who receives it."', '  name as text',
    '', '"Create one."', 'export function greet takes name as text, giving Greeting',
    '  return object', '      name is name', '', 'callback is function takes word',
    '  if word = "" return unset', '  return word.to_upper_case run'
  ].join("\n");
  const formatted = format(source, { width: 32 });
  assert.equal(compile(formatted).declarations, compile(source).declarations);
  assert.equal(meaning(formatted), meaning(source));
  assert.match(formatted, /return object\n        name is name/);
});

test("format preserves CRLF and supports editor indentation options", () => {
  const source = 'function greet\r\n  print "hello"\r\n';
  assert.equal(format(source, { tabWidth: 2 }), source);
  assert.equal(format(source, { tabWidth: 2, insertSpaces: false }), 'function greet\r\n\tprint "hello"\r\n');
  assert.equal(format(source, { endOfLine: "\n" }), 'function greet\n    print "hello"\n');
});

test("format uses imported Prose argument counts and reports invalid syntax", () => {
  const readModule = () => 'export function double takes value\n    return value * 2';
  const source = 'use double from "./math.prose"\nprint double 2, double 3';
  assert.equal(format(source, { width: 25, readModule }), 'use double from "./math.prose"\nprint double 2, double 3\n');
  assert.throws(() => format(source), /readModule/);
  assert.throws(() => format('if true\nprint 1'), /Line 1: Expected an indented body/);
  assert.throws(() => format('print 1', { width: 0 }), /width/);
  assert.throws(() => format('print 1', { tabWidth: 0 }), /Tab width/);
  assert.throws(() => format('print 1', { endOfLine: "\r" }), /Line ending/);
});

test("format is stable and preserves meaning for every runnable example", () => {
  const folder = fileURLToPath(new URL("../examples/", import.meta.url));
  let checked = 0;
  for (const name of readdirSync(folder).filter(name => name.endsWith(".prose"))) {
    const source = readFileSync(join(folder, name), "utf8");
    const options = { readModule: path => readFileSync(resolve(folder, path), "utf8") };
    // Design sketches and unfinished user experiments can have unsupported syntax.
    try { parse(source, options); } catch { continue; }
    const formatted = format(source, options);
    assert.equal(format(formatted, options), formatted, name);
    assert.equal(compile(source, options).declarations, compile(formatted, options).declarations, name);
    checked++;
  }
  assert.ok(checked >= 18, `Checked ${checked} examples`);
});

test("format CLI checks, writes recursively, skips dependencies, and resolves imports", () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-format-"));
  const command = (...args) => spawnSync(process.execPath, [cli, "format", ...args], { cwd: folder, encoding: "utf8" });
  try {
    mkdirSync(join(folder, "node_modules"));
    writeFileSync(join(folder, "node_modules", "broken.prose"), "not valid prose!");
    writeFileSync(join(folder, "math.prose"), 'export function double takes value\n\treturn value*2');
    writeFileSync(join(folder, "main.prose"), 'use double from "./math.prose"\nprint  double 2, double 3');
    const before = readFileSync(join(folder, "main.prose"), "utf8");
    const check = command(".", "--check");
    assert.equal(check.status, 1, check.stderr);
    assert.match(check.stdout, /Would format main.prose/);
    assert.equal(readFileSync(join(folder, "main.prose"), "utf8"), before);
    const written = command(".", "main.prose", "--width", "80");
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout.match(/Formatted main.prose/g).length, 1);
    assert.equal(command("--check", ".").status, 0);
    assert.equal(command(".").stdout, "");
    const run = spawnSync(process.execPath, [cli, "main.prose", "--run"], { cwd: folder, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, "\n"), "[ 4, 6 ]\n");
    writeFileSync(join(folder, "a.prose"), "print  1");
    writeFileSync(join(folder, "broken.prose"), "if true\nprint 1");
    const failed = command(".");
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /broken.prose: Line 1/);
    assert.equal(readFileSync(join(folder, "a.prose"), "utf8"), "print  1");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("format CLI supports stdin and rejects invalid options without writing", () => {
  const command = (args, input = 'print  1') => spawnSync(process.execPath, [cli, "format", ...args], { input, encoding: "utf8" });
  assert.equal(command(["-"]).stdout, "print 1\n");
  for (const args of [[], ["-", "--check"], ["-", "--width", "0"], ["-", "--width=foo"], ["-", "--wat"], ["-", "--stdin-filepath"]]) {
    assert.equal(command(args).status, 1, args.join(" "));
  }
});

test("source locations preserve original lexemes while the parser remains unchanged", () => {
  const lines = sourceLines('value is\n  001 + (pattern "\\d+").source', { locations: true });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].tokens.map(token => token.source.raw), ['value', 'is', '001', '+', '(', 'pattern "\\d+"', ')', '.', 'source']);
  assert.equal(lines[0].tokens.at(-1).source.line, 2);
});
