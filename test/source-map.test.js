import test from "node:test";
import assert from "node:assert/strict";
import { SourceMap } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { compile, parse } from "../src/transpile.js";
import { inlineSourceMap, mapStackTrace, sourceMapLookup } from "../src/source-map.js";
import prose from "../src/vite.js";

const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
const position = (code, text, occurrence = 0) => {
  let at = -1;
  if (occurrence === -1) at = code.lastIndexOf(text);
  else for (let i = 0; i <= occurrence; i++) at = code.indexOf(text, at + 1);
  assert.notEqual(at, -1, `Missing generated text: ${text}`);
  const lines = code.slice(0, at).split(/\r\n|[\n\r\u2028\u2029]/);
  return [lines.length - 1, lines.at(-1).length];
};
const original = (result, text, occurrence) => new SourceMap(result.map).findEntry(...position(result.code, text, occurrence));

test("source maps are optional and preserve generated code and declaration output", () => {
  for (const source of ["", "print 1", "type Example is text", "export type Example is text", "export count is 1"]) {
    const plain = compile(source);
    const mapped = compile(source, { sourceMap: true, filename: "example.prose" });
    assert.equal(plain.map, null);
    assert.equal(mapped.code, plain.code);
    assert.equal(mapped.declarations, plain.declarations);
    assert.equal(mapped.map.version, 3);
    assert.deepEqual(mapped.map.sources, ["example.prose"]);
    assert.deepEqual(mapped.map.sourcesContent, [source]);
    assert.doesNotMatch(mapped.code, /\0prose-map/);
  }
  assert.throws(() => compile("print 1", { sourceMap: "invalid" }), /sourceMap must be/);
});

test("Node's source-map consumer resolves statements, function bodies, and caller locations", () => {
  const source = 'function decode takes text\n    return JSON.parse text\nprint decode "oops"';
  const result = compile(source, { sourceMap: true, filename: "decode.prose" });
  const declaration = original(result, "function _prose_decode");
  assert.equal(declaration.originalLine, 0);
  assert.equal(declaration.name, "decode");
  const call = original(result, "__prose_dot_method(JSON");
  assert.equal(call.originalLine, 1);
  assert.equal(call.originalColumn, 11);
  assert.equal(original(result, 'console.log(_prose_decode').originalLine, 2);
  assert.equal(original(result, "function __prose_dot_method").originalSource, undefined);
  const locals = compile('function local\n    value is 1\n    return value', { sourceMap: true });
  assert.equal(original(locals, "let _prose_value").originalSource, undefined);
});

test("wrapped expressions retain physical lines, Unicode columns, tabs, CRLF, and BOM", () => {
  for (const source of [
    'print "😀" + JSON.parse "oops"',
    'print "a\u2028b\u2029c" + JSON.parse "oops"',
    'print "😀" +\r\n    JSON.parse "oops"',
    'function decode\r\n\treturn JSON.parse "oops"\r\ndecode run',
    '\uFEFFprint JSON.parse "oops"'
  ]) {
    const result = compile(source, { sourceMap: true, filename: "unicode.prose" });
    const line = source.split(/\r?\n/).findIndex(line => line.includes("JSON"));
    const column = source.split(/\r?\n/)[line].indexOf("JSON");
    const entry = original(result, "__prose_dot_method(JSON");
    assert.equal(entry.originalLine, line);
    assert.equal(entry.originalColumn, column);
    assert.equal(result.code, compile(source).code);
  }
});

test("maps locate indented objects, lambdas, branches, catch handlers, and loop bodies", () => {
  const source = [
    'record is object', '    data is JSON.parse "{}"',
    'items is "{}", "[]"', 'decoded is items.map function takes text',
    '    return JSON.parse text',
    'if false', '    print "unused"', 'else if true', '    print "chosen"',
    'else', '    print "unused"', 'try', '    fail "broken"',
    'on error problem', '    print problem.message',
    'for i is 1 to 2', '    print i', 'while false', '    print "unused"'
  ].join("\n");
  const result = compile(source, { sourceMap: true });
  assert.equal(original(result, "__prose_dot_method(JSON", 0).originalLine, 1);
  assert.equal(original(result, "__prose_dot_method(JSON", 1).originalLine, 4);
  assert.equal(original(result, "else if").originalLine, 7);
  assert.equal(original(result, "else {", -1).originalLine, 9);
  assert.equal(original(result, "catch (__error)").originalLine, 13);
  assert.equal(original(result, "console.log(_prose_i)").originalLine, 16);
  assert.equal(original(result, "while (").originalLine, 17);
  assert.equal(result.code, compile(source).code);
});

test("inline maps encode Unicode as UTF-8 and preserve embedded source text", () => {
  const source = 'print "héllo 😀 </script>"';
  const result = compile(source, { sourceMap: "inline", filename: "unicode.prose" });
  const base64 = result.code.match(/sourceMappingURL=data:[^,]+,([^\n]+)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(base64, "base64").toString("utf8")), result.map);
  const offset = inlineSourceMap(result.map, 2).split(",")[1];
  const payload = JSON.parse(Buffer.from(offset, "base64").toString("utf8"));
  assert.equal(payload.mappings, ";;" + result.map.mappings);
});

test("private map markers cannot alter strings or patterns containing similar text", () => {
  for (const source of ['print "\\u0000prose-map:0;"', 'print pattern "\0prose-map:0;"']) {
    assert.equal(compile(source, { sourceMap: true }).code, compile(source).code);
  }
});

test("all runnable examples emit identical JavaScript with maps enabled", () => {
  const folder = fileURLToPath(new URL("../examples/", import.meta.url));
  let checked = 0;
  for (const name of readdirSync(folder).filter(name => name.endsWith(".prose"))) {
    const source = readFileSync(join(folder, name), "utf8");
    const readModule = path => readFileSync(resolve(folder, path), "utf8");
    try { parse(source, { readModule }); } catch { continue; }
    const plain = compile(source, { readModule });
    const result = compile(source, { readModule, sourceMap: true, filename: name });
    assert.equal(result.code, plain.code, name);
    assert.equal(result.declarations, plain.declarations, name);
    assert.doesNotThrow(() => new SourceMap(result.map));
    checked++;
  }
  assert.ok(checked >= 18);
});

test("Vite returns a source map for query-bearing imports with original content", () => {
  const source = 'export function decode takes text\n    return JSON.parse text';
  const result = prose().transform.call({}, source, "/src/decode.prose?import");
  assert.deepEqual(result.map.sources, ["/src/decode.prose"]);
  assert.deepEqual(result.map.sourcesContent, [source]);
  assert.equal(original(result, "__prose_dot_method(JSON").originalLine, 1);
  assert.doesNotMatch(result.code, /sourceMappingURL/);
});

test("--run maps synchronous and asynchronous errors across imported Prose files", () => {
  const folder = mkdtempSync(join(tmpdir(), "prose maps 😀 "));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: folder, encoding: "utf8" });
  try {
    writeFileSync(join(folder, "decoder.prose"), 'export function decode takes text\n    return JSON.parse text');
    writeFileSync(join(folder, "main file.prose"), 'use decode from "./decoder.prose"\nprint decode "oops"');
    const sync = run("main file.prose", "--run");
    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /decoder\.prose:2:12/);
    assert.match(sync.stderr, /main file\.prose:2:/);
    writeFileSync(join(folder, "async.prose"), [
      'function decode takes text', '    wait for Promise.resolve text',
      '    return JSON.parse text', 'wait for decode "oops"'
    ].join("\n"));
    const async = run("async.prose", "--run");
    assert.equal(async.status, 1);
    assert.match(async.stderr, /async\.prose:3:12/);
    writeFileSync(join(folder, "bad.prose"), "print unknown");
    const bad = run("bad.prose", "--run");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /bad\.prose: Line 1: Unknown name/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("redirected CLI JavaScript retains an inline map Node can use", () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-map-output-"));
  try {
    const file = join(folder, "original.prose");
    writeFileSync(file, 'print "starting"\nprint JSON.parse "oops"');
    const built = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const js = join(folder, "output.cjs");
    writeFileSync(js, built.stdout);
    const result = spawnSync(process.execPath, ["--enable-source-maps", js], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /original\.prose:2:7/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("Node's debugger receives the inline map and stops on a mapped Prose statement", () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-debug-map-"));
  try {
    const file = join(folder, "debug.prose");
    const source = "value is 41\nexport answer is value + 1";
    writeFileSync(file, source);
    const url = pathToFileURL(file).href;
    const runtime = new URL("../src/runtime.js", import.meta.url).href;
    const generated = compile(source, { runtime, sourceMap: true, filename: url });
    const [lineNumber] = position(generated.code, "_prose_answer =");
    const script = `
      import { Session } from 'node:inspector';
      import { register, SourceMap } from 'node:module';
      process.setSourceMapsEnabled(true);
      register(${JSON.stringify(new URL("../src/node-hooks.js", import.meta.url).href)});
      const session = new Session();
      session.connect();
      const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
      let parsed, hit;
      session.on('Debugger.scriptParsed', ({params}) => { if (params.url === ${JSON.stringify(url)}) parsed = params; });
      session.on('Debugger.paused', ({params}) => { hit = params.callFrames[0].location; session.post('Debugger.resume'); });
      await post('Debugger.enable');
      await post('Debugger.setBreakpointByUrl', {url: ${JSON.stringify(url)}, lineNumber: ${lineNumber}});
      const loaded = await import(${JSON.stringify(url)});
      session.disconnect();
      if (!hit) throw new Error('The breakpoint did not stop the program.');
      const origin = new SourceMap(${JSON.stringify(generated.map)}).findEntry(hit.lineNumber, hit.columnNumber);
      console.log(JSON.stringify({answer: loaded.answer, line: origin.originalLine + 1, inline: parsed.sourceMapURL.startsWith('data:application/json')}));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { answer: 42, line: 2, inline: true });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('debug stepping does not map synthetic function and callback closing braces to their headers', () => {
  const source = 'function double takes number\n    result is number * 2\n    return result\naction is function takes number\n    result is number * 2\n    return result\nprint double 2\nprint action 3';
  const generated = compile(source, { sourceMap: true, filename: 'debug.prose' });
  assert.equal(generated.code, compile(source).code);
  const lookup = sourceMapLookup(generated.map);
  let closures = 0;
  const rows = generated.code.split('\n');
  for (const [line, text] of rows.entries()) if (/^\s*\}\)?;?$/.test(text)) {
    assert.equal(lookup(line, text.indexOf('}')), null, text); closures++;
  }
  assert.ok(closures >= 2);
  const returns = rows.flatMap((row, line) => row.trim() === 'return _prose_result;' ? [{ row, line }] : []);
  assert.deepEqual(returns.map(({ row, line }) => lookup(line, row.length)?.line), [3, 6]);
});

test("playground trace mapping handles real Function wrappers and Firefox frames", () => {
  const source = 'function decode takes text\n    return JSON.parse text\nprint decode "oops"';
  const result = compile(source, { sourceMap: true, filename: "playground.prose" });
  let stack;
  try { new Function("console", result.code + "\n//# sourceURL=prose-playground.js")({ log() {} }); }
  catch (error) { stack = error.stack; }
  const mapped = mapStackTrace(stack, result.map, { generatedFile: "prose-playground.js", lineOffset: 2 });
  assert.deepEqual(mapped.location, { source: "playground.prose", line: 2, column: 12 });
  assert.match(mapped.stack, /playground\.prose:2:12/);
  const [line, column] = position(result.code, "__prose_dot_method(JSON");
  const firefox = mapStackTrace(`decode@prose-playground.js:${line + 3}:${column + 1}`, result.map, { generatedFile: "prose-playground.js", lineOffset: 2 });
  assert.equal(firefox.stack, "decode@playground.prose:2:12");
  assert.equal(sourceMapLookup(result.map)(0, 0), null);
  assert.equal(sourceMapLookup(result.map)(10000, 0), null);
});
