import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

test("the browser compiler bundle compiles Prose and exposes its helpers", () => {
  const text = buildSync({
    entryPoints: [fileURLToPath(new URL("../site/compiler-entry.js", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "Prose",
    platform: "browser",
    target: ["es2020"],
    write: false,
    legalComments: "none",
    logLevel: "silent"
  }).outputFiles[0].text;
  const context = {};
  runInNewContext(`${text}\nProse;`, context);
  assert.match(context.Prose.compile("print 1 + 2").code, /console\.log/);
  assert.equal(typeof context.Prose.inlineSourceMap, "function");
  assert.equal(typeof context.Prose.mapStackTrace, "function");
});
