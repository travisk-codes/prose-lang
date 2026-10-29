import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { compile } from "../src/transpile.js";
import { inlineScript } from "./scripts.mjs";

const strip = file => readFileSync(new URL("../src/" + file, import.meta.url), "utf8")
  .split("\n").filter(line => !line.startsWith("import ")).join("\n").replace(/^export /gm, "");
const browserCompiler = inlineScript(`(() => {\n${strip("runtime.js")}\n${strip("check.js")}\n${strip("source-map.js")}\n${strip("call-arity.js")}\n${strip("transpile.js")}\nreturn { compile, inlineSourceMap, mapStackTrace };\n})();`);

test("checking output also works in the browser bundle without TypeScript installed", () => {
  const browser = runInNewContext(browserCompiler, { TextEncoder });
  const source = 'export function twice takes n as number, giving number\n    return n * 2';
  const options = { check: true, sourceMap: true, filename: 'twice.prose' };
  const actual = browser.compile(source, options);
  const expected = compile(source, options);
  assert.equal(actual.code, expected.code);
  assert.equal(JSON.stringify(actual.map), JSON.stringify(expected.map));
});

test("the browser compiler emits the same maps as the Node compiler", () => {
  const browser = runInNewContext(browserCompiler, { TextEncoder });
  const source = 'word is "héllo 😀 </script>"\nprint word.to_upper_case run';
  const options = { sourceMap: true, filename: "playground.prose" };
  const actual = browser.compile(source, options);
  const expected = compile(source, options);
  assert.equal(actual.code, expected.code);
  assert.equal(JSON.stringify(actual.map), JSON.stringify(expected.map));
  assert.doesNotMatch(browser.inlineSourceMap(actual.map, 2), /<\/script/i);
});

test("the actual playground worker returns printed output and a mapped error location", () => {
  const browser = runInNewContext(browserCompiler, { TextEncoder });
  const playground = readFileSync(new URL("playground.js", import.meta.url), "utf8");
  const literal = playground.match(/const workerSource = (`[\s\S]*?`);/)[1];
  const worker = runInNewContext(literal);
  const messages = [];
  const context = { self: { postMessage: message => messages.push(message) } };
  runInNewContext(worker, context);
  const result = browser.compile('print "before"\nprint JSON.parse "bad"', { sourceMap: true, filename: "playground.prose" });
  context.self.onmessage({ data: result.code + "\n" + browser.inlineSourceMap(result.map, 2) + "\n//# sourceURL=prose-playground.js" });
  assert.deepEqual(Array.from(messages[0].lines), ["before"]);
  assert.equal(messages[0].name, "SyntaxError");
  const trace = browser.mapStackTrace(messages[0].stack, result.map, { generatedFile: "prose-playground.js", lineOffset: 2 });
  assert.equal(trace.location.line, 2);
  assert.equal(trace.location.column, 7);
  assert.match(trace.stack, /playground\.prose:2:7/);
});
