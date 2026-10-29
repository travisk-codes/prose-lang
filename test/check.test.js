import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/transpile.js";
import { untypedError } from "../src/check.js";
import { sourceMapLookup } from "../src/source-map.js";
import { measureProject } from "../scripts/measure-check.mjs";

// The checking output is TypeScript written to be type-checked, never run.
const checked = (source, options = {}) => compile(source, { check: true, ...options }).code;
const body = source => checked(source).split("declare function __prose_error(reason: unknown): Error;\n")[1];

test("parameters, results, and variables carry their types", () => {
  const code = body([
    "function f takes a as text, b, giving number",
    "    return length a",
    "function g takes items as list of number, when as maybe Date",
    "    return items",
    "x is 5",
    "counts as map from text to number is new Map",
    "total as number is 0",
    "total is total + x",
    "if x > 1 then label is \"big\"",
    "names is array",
    "names:push \"Ada\""
  ].join("\n"));
  // Trailing untyped or maybe parameters can be left out, as with calls allow.
  assert.match(code, /function _prose_f\(_prose_a: string, _prose_b\?: any\): number \{/);
  assert.match(code, /function _prose_g\(_prose_items: readonly number\[\], _prose_when\?: Date\) \{/);
  // Variables assigned again, or only in a branch, are declared up front; the rest are const.
  assert.match(code, /let _prose_total: number, _prose_label;/);
  assert.match(code, /const _prose_x = 5;/);
  assert.match(code, /const _prose_counts: Map<string, number> = new \(Map\)\(\);/);
  assert.match(code, /_prose_total = \(_prose_total \+ _prose_x\);/);
  // An empty list takes its type from what's added to it.
  assert.match(code, /const _prose_names = \[\];/);
});

test("objects can gain properties, and unset ones can be filled in", () => {
  const code = body([
    "stats is object count is 0, best is unset, note is null",
    "stats:best is 3",
    "stats:streak is 2",
    "history is object past is array",
    "print stats, history"
  ].join("\n"));
  assert.match(code, /const _prose_stats = \(\{count: 0, best: \(undefined as any\), note: \(null as any\), streak: \(undefined as any\)\}\);/);
  // An empty list inside something else can hold anything.
  assert.match(code, /const _prose_history = \(\{past: \(\[\] as any\[\]\)\}\);/);
});

test("imports, type imports, and type declarations are TypeScript's own", () => {
  const code = checked([
    'use type Datum from "./types"',
    'use find_tag from "./tags.prose"',
    "export type Entry is object",
    "    datum as Datum",
    "    note as maybe text",
    "export function first takes entry as Entry, giving Datum",
    "    return entry:datum"
  ].join("\n"), { readModule: () => "export function find_tag takes datum, name\n    return datum" });
  assert.match(code, /import type \{ Datum \} from "\.\/types";/);
  assert.match(code, /import \{ findTag as _prose_find_tag \} from "\.\/tags\.prose";/);
  assert.match(code, /export interface Entry \{\n  datum: Datum;\n  note\?: string;\n\}/);
  assert.match(code, /export \{ _prose_first as first \};/);
  // A file that exports nothing is still a module, so its names stay its own.
  assert.match(checked("print 1"), /export \{\};\n$/);
});

test("properties, methods, and calls are plain TypeScript", () => {
  const code = body([
    'person is object name is "Ada", created_at is 1',
    "print person:name + person:created_at",
    "print person.name",
    'print person:name:pad_start 2, "0"',
    "print maybe person:address:city",
    "print maybe person:nickname:to_upper_case run",
    "items is 1, 2, 3",
    "print items:filter function takes n return n > 1",
    "print new Date 0",
    "callback is unset",
    "print maybe callback run"
  ].join("\n"));
  assert.match(code, /_prose_person = \(\{name: "Ada", createdAt: 1\}\);/);
  assert.match(code, /_prose_person\.name \+ _prose_person\.createdAt/);
  assert.match(code, /console\.log\(_prose_person\.name\);/);
  assert.match(code, /_prose_person\.name\.padStart\(2, "0"\)/);
  assert.match(code, /_prose_person\?\.address\?\.city/);
  assert.match(code, /_prose_person\?\.nickname\?\.toUpperCase\?\.\(\)/);
  assert.match(code, /_prose_items\.filter\(\(\(_prose_n\) => \(_prose_n > 1\)\)\)/);
  assert.match(code, /new \(Date\)\(0\)/);
  assert.match(code, /_prose_callback\?\.\(\)/);
});

test("positions shift to zero and dots named like variables use typed helpers", () => {
  const code = body([
    "rows is (1, 2), (3, 4)",
    "row is 2",
    "column is 1",
    "print rows.1",
    "print rows.row.column",
    "print rows.(row - 1)",
    "rows.1 is (5, 6)",
    "rows.row.column is 7",
    "rows.(row) is (8, 9)",
    'person is object name is "Ada"',
    'person:name is "Grace"',
    'person.name is "Lin"'
  ].join("\n"));
  assert.match(code, /console\.log\(_prose_rows\[0\]\);/);
  assert.match(code, /__prose_dot\(__prose_dot\(_prose_rows, _prose_row, "row"\), _prose_column, "column"\)/);
  assert.match(code, /__prose_dot_key\(_prose_rows, \(_prose_row - 1\)\)/);
  assert.match(code, /__prose_set_at\(_prose_rows, 1, \[5, 6\]\);/);
  assert.match(code, /__prose_dot_set\(__prose_dot\(_prose_rows, _prose_row, "row"\), _prose_column, "column", 7\);/);
  assert.match(code, /__prose_dot_key_set\(_prose_rows, _prose_row, \[8, 9\]\);/);
  assert.match(code, /_prose_person\.name = "Grace";/);
  assert.match(code, /_prose_person\.name = "Lin";/);
});

test("type tests, otherwise, waiting, and errors keep their TypeScript meaning", () => {
  const code = body([
    "function load takes url as text, giving text",
    "    response is wait for fetch url",
    "    return wait for response:text run",
    "function describe takes value",
    "    if value is a text return value otherwise \"\"",
    "    try",
    "        fail \"no\"",
    "    on error problem",
    "        return problem:message"
  ].join("\n"));
  assert.match(code, /async function _prose_load\(_prose_url: string\): Promise<string> \{/);
  assert.match(code, /\(await fetch\(_prose_url\)\)/);
  assert.match(code, /typeof \(_prose_value\) === "string"/);
  assert.match(code, /\?\? ""/);
  assert.match(code, /throw __prose_error\("no"\);/);
  // Anything can be thrown, so the handler is trusted with what it caught.
  assert.match(code, /catch \(__error: any\)/);
});

test("the running JavaScript is unchanged by the checking output", () => {
  const source = "rows is (1, 2), (3, 4)\nrow is 2\nprint rows.row.1\nperson is object name is \"Ada\"\nprint person:name";
  const plain = compile(source).code;
  assert.ok(plain.includes("__prose_dot(") && plain.includes("__prose_property("));
  assert.ok(!plain.includes("declare function"));
});

// The rest runs TypeScript itself on the checking output, as `prose check` will.
let ts;
try { ts = createRequire(import.meta.url)("typescript"); } catch {}
const withTypeScript = { skip: !ts && "typescript is not installed" };

const typesFile = [
  "export interface DatumTag { name: string; value: string }",
  "export interface Datum { id: string; time: number; tags: DatumTag[] }"
].join("\n");
const tagsModule = [
  'use type Datum, DatumTag from "./types"',
  "export function find_tag takes datum as Datum, name as text, giving maybe DatumTag",
  "    return datum:tags:find function takes tag return tag:name = name",
  "export function without_tag takes tags as list of DatumTag, name as text, giving list of DatumTag",
  "    return tags:filter function takes tag return tag:name != name"
].join("\n");

// Type-check one Prose file beside types.ts and tags.prose, all in memory. Each error comes
// back with its TypeScript code and the Prose line its source map points to.
function typeCheck(source) {
  const readModule = () => tagsModule;
  const result = compile(source, { check: true, sourceMap: true, filename: "main.prose", readModule });
  const root = "/prose-check/";
  const files = new Map([
    [root + "main.ts", result.code],
    [root + "types.ts", typesFile],
    [root + "tags.d.prose.ts", compile(tagsModule).declarations]
  ]);
  const options = {
    strict: true, noEmit: true, skipLibCheck: true, allowArbitraryExtensions: true,
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"]
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, directoryExists, readFile } = host;
  host.getSourceFile = (name, version, ...rest) => files.has(name)
    ? ts.createSourceFile(name, files.get(name), version, true) : getSourceFile.call(host, name, version, ...rest);
  host.fileExists = name => files.has(name) || fileExists.call(host, name);
  host.directoryExists = name => name.replace(/\/?$/, "/") === root || directoryExists.call(host, name);
  host.readFile = name => files.get(name) ?? readFile.call(host, name);
  const program = ts.createProgram([root + "main.ts"], options, host);
  const lookup = sourceMapLookup(result.map);
  return ts.getPreEmitDiagnostics(program).filter(diagnostic =>
    !untypedError(diagnostic.code, ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).map(diagnostic => {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const original = diagnostic.file.fileName === root + "main.ts" ? lookup(position.line, position.character) : null;
    return { code: diagnostic.code, line: original?.line, file: diagnostic.file.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") };
  });
}

test("working Prose type-checks without complaint", withTypeScript, () => {
  const diagnostics = typeCheck([
    'use type Datum, DatumTag from "./types"',
    'use find_tag from "./tags.prose"',
    "",
    "export type Entry is object",
    "    datum as Datum",
    "    tag as DatumTag",
    "",
    "type Category is object",
    "    key as text",
    '    kind as "value" or "empty" or "other"',
    "",
    "export function note_text takes datum as Datum, giving text",
    '    tag is find_tag datum, "note"',
    '    return maybe tag:value otherwise ""',
    "",
    "function counts_by_hour takes entries as list of Entry, giving list of number",
    "    counts is Array:from (object length is 24), function return 0",
    "    for each entry in entries",
    "        hour is (new Date entry:datum:time):get_hours run + 1",
    "        counts.hour is counts.hour + 1",
    "    return counts",
    "",
    "function grid_max takes grid as list of list of number, giving number",
    "    best is 0",
    "    for row is 1 to length grid",
    "        for column is 1 to length grid.row",
    "            best is Math:max best, grid.row.column",
    "    return best",
    "",
    "function tally takes words as list of text, giving map from text to number",
    "    totals as map from text to number is new Map",
    "    for each word in words",
    "        totals:set word, ((totals:get word otherwise 0) + 1)",
    "    return totals",
    "",
    "function first_label takes entries as list of Entry, now as maybe Date, giving text",
    "    if now = unset now is new Date",
    "    if not entries:length return now:to_iso_string run",
    "    return entries.1:tag:name",
    "",
    "function categories takes words as list of text, giving list of Category",
    "    category_of is function takes word as text, giving Category",
    '        if not word return object key is "empty", kind is "empty"',
    '        return object key is word, kind is "value"',
    "    return words:map category_of",
    "",
    "function load takes url as text, giving text",
    "    response is wait for fetch url",
    "    return wait for response:text run",
    "",
    "function shout_all takes words as list of text, giving list of text",
    "    loud is array",
    "    for each word in words",
    "        loud:push word:to_upper_case run",
    "    return loud",
    "",
    "function summary takes entries as list of Entry",
    "    stats is object count is 0, latest is unset",
    "    for each entry in entries",
    "        stats:count is stats:count + 1",
    "        stats:latest is entry:datum",
    "    stats:days is 7",
    "    return stats",
    "",
    "function safe_parse takes input as text",
    "    try",
    "        return JSON:parse input",
    "    on error problem",
    "        return problem:message"
  ].join("\n"));
  assert.deepEqual(diagnostics, []);
});

test("mistakes are reported at the Prose lines that made them", withTypeScript, () => {
  const diagnostics = typeCheck([
    'use type Datum, DatumTag from "./types"',
    'use find_tag, without_tag from "./tags.prose"',
    "type Entry is object",
    "    datum as Datum",
    "    tag as DatumTag",
    "function note_text takes datum as Datum, giving text",
    '    tag is find_tag datum, "note"',
    "    return tag:value",
    "function note_title takes datum as Datum, giving text",
    '    tag is find_tag datum, "title"',
    '    return maybe tag:valeu otherwise ""',
    "function other_tags takes datum as Datum, giving list of DatumTag",
    '    return without_tag (without_tag datum, "note"), "title"',
    "function labels takes datum as Datum, giving list of DatumTag",
    '    return datum:tags:filtr function takes tag return tag:value = ""',
    "function padded takes label as text, giving text",
    '    return label:pad_start "2", "0"',
    "function count takes datums as list of Datum, giving number",
    '    return datums:length + " notes"',
    "function entry_tag takes entry as Entry, tagg as number, giving DatumTag",
    "    return entry.tagg",
    "function frozen takes numbers as list of number, position as number",
    "    numbers.position is 0"
  ].join("\n"));
  assert.deepEqual(diagnostics.map(({ line, code }) => [line, code]), [
    [8, 18048],   // tag is possibly undefined: maybe was left out
    [11, 2551],   // valeu: did you mean value?
    [13, 2345],   // a Datum where a list of DatumTag belongs
    [15, 2551],   // filtr: did you mean filter?
    [17, 2345],   // pad_start takes a number first
    [19, 2322],   // text where the function gives a number
    [21, 2322],   // ...so what it reads isn't a DatumTag either
    [21, 2345],   // tagg is a variable here, and not a property of Entry
    [23, 2345]    // a list parameter can't be written to
  ]);
  assert.ok(diagnostics.every(diagnostic => diagnostic.file === "/prose-check/main.ts"));
});

test("contextual dots distinguish numeric positions from same-named literal methods", withTypeScript, () => {
  const diagnostics = typeCheck([
    'function labels takes words as list of text, giving list of text',
    '    map is "literal method"',
    '    slice is false',
    '    return (words.map function takes word return word.to_upper_case run).slice 1',
    'function cleaned takes text as text, giving text',
    '    trim is false',
    '    return text.trim run',
    'function pick takes words as list of text, i as number, giving text',
    '    return words.i',
    'function named takes i as number, giving text',
    '    record is object i is "literal property"',
    '    return record.i'
  ].join('\n'));
  assert.deepEqual(diagnostics, []);
});

test("computed dot keys support sequence properties as well as numeric positions", withTypeScript, () => {
  assert.deepEqual(typeCheck([
    'function count takes words as list of text, giving number',
    '    return words.("length")',
    'function first takes words as list of text, giving text',
    '    return words.(1)',
    'function upper takes text as text, giving text',
    '    return text.("toUpperCase") run',
    'function append takes word as text',
    '    words is array',
    '    words.("push") word',
    '    return words'
  ].join('\n')), []);
});

test("returned objects can gain properties without weakening annotated objects", withTypeScript, () => {
  assert.deepEqual(typeCheck([
    'function make_point', '    return object x is 1',
    'point is make_point run', 'point.y is 2', 'print point.y',
    'type Point is object', '    x as number',
    'typed as Point is make_point run', 'typed.y is 2'
  ].join('\n')).map(({ line, code }) => [line, code]), [[9, 2339]]);
});

test("later properties follow lexical bindings rather than the variable spelling", withTypeScript, () => {
  const diagnostics = typeCheck([
    'function first', '    stats is object count is 0', '    stats.extra is 1', '    return stats',
    'function second', '    stats is object count is 0', '    return stats.extra',
    'function captured', '    stats is object count is 0',
    '    update is function', '        stats.extra is 1', '    update run', '    return stats.extra'
  ].join('\n'));
  assert.deepEqual(diagnostics.map(({ line, code }) => [line, code]), [[7, 2339]]);
});

test("generic function values declare their own type variables and capture outer ones", withTypeScript, () => {
  assert.deepEqual(typeCheck([
    'identity is function takes value as item giving item return value',
    'print identity "hello"',
    'function select takes value as item, giving item',
    '    captured is function takes replacement as item giving item return replacement',
    '    return captured value'
  ].join('\n')), []);
});

test("typed values and readonly positions stay protected after allowing dynamic fields", withTypeScript, () => {
  const diagnostics = typeCheck([
    'function point', '    return object x is 1',
    'value is point run', 'value.extra is 2', 'value.x is "wrong"',
    'function frozen takes values as list of number',
    '    values.1 is 2', '    values.(1) is 2', '    i is 1', '    values.i is 2',
    'function text_position takes word as text', '    i is 1', '    word.i is 3'
  ].join('\n'));
  assert.deepEqual(diagnostics.map(({line}) => line), [5, 7, 8, 10, 13]);
});

test("untyped empty variables support text construction and optional calls", withTypeScript, () => {
  assert.deepEqual(typeCheck([
    'function letter giving text', '    word', '    i is 1', '    word.i is "a"', '    return word',
    'callback is unset', 'print maybe callback run'
  ].join('\n')), []);
});

test("constructors selected through contextual and computed dots remain constructible", withTypeScript, () => {
  assert.deepEqual(typeCheck([
    'function epoch giving Date', '    classes is (Date,)', '    i is 1', '    return new classes.i 0',
    'function computed giving Date', '    classes is object Date is Date', '    key is "Date"',
    '    return new classes.(key) 0'
  ].join('\n')), []);
});

test("checking output supports inline maps without changing the runtime output", () => {
  const source = 'export function twice takes n as number, giving number\n    return n * 2';
  const result = compile(source, { check: true, sourceMap: 'inline', filename: 'twice.prose' });
  const encoded = result.code.match(/sourceMappingURL=data:[^,]+,([^\n]+)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), result.map);
  assert.doesNotMatch(compile(source).code, /declare function|__prose_open|_prose_n: number/);
});

test("measurement uses fresh declarations, strict checks, and leaves project files alone", withTypeScript, () => {
  const folder = mkdtempSync(join(tmpdir(), 'prose-check-project-'));
  try {
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'package.json'), '{"type":"module"}');
    writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'es2023', module: 'esnext', moduleResolution: 'bundler', allowArbitraryExtensions: true,
      strict: false, strictNullChecks: false, noUnusedLocals: true, noUnusedParameters: true, types: [], skipLibCheck: true
    }, include: ['src'] }));
    writeFileSync(join(folder, 'src', 'value.prose'), 'export function amount giving number\n    return 5');
    const stale = 'export function amount(): string;\n';
    writeFileSync(join(folder, 'src', 'value.d.prose.ts'), stale);
    writeFileSync(join(folder, 'src', 'main.prose'), [
      'use amount from "./value.prose"',
      'export function valid giving number', '    return amount run',
      'export function invalid takes text as maybe text, giving text', '    return text',
      'fail "This program must not run during checking"'
    ].join('\n'));
    const result = measureProject(folder, { typescript: ts });
    assert.equal(result.modules, 2);
    assert.deepEqual(result.diagnostics.map(({ file, line, code }) => [file, line, code]), [['src/main.prose', 5, 2322]]);
    assert.equal(readFileSync(join(folder, 'src', 'value.d.prose.ts'), 'utf8'), stale);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
