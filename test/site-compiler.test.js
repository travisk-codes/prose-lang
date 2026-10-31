import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { browserCompiler } from "../site/compiler.mjs";

test("the browser compiler bundle compiles Prose and exposes its helpers", async () => {
  const context = {};
  runInNewContext(`${await browserCompiler()}\nProse;`, context);
  assert.match(context.Prose.compile("print 1 + 2").code, /console\.log/);
  assert.equal(typeof context.Prose.inlineSourceMap, "function");
  assert.equal(typeof context.Prose.mapStackTrace, "function");
});
