import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeHelpers } from "../src/runtime.js";
import prose from "../src/vite.js";

const plugin = prose();
const context = { error(details) { throw Object.assign(new Error(details.message), details); } };

test("the plugin serves the runtime as one virtual module", () => {
  assert.equal(plugin.name, "prose");
  const id = plugin.resolveId("virtual:prose-runtime");
  assert.equal(id, "\0virtual:prose-runtime");
  assert.equal(plugin.resolveId("./other.js"), null);
  const runtime = plugin.load(id);
  for (const helper of runtimeHelpers) assert.match(runtime, new RegExp(`function ${helper}\\(`));
  assert.match(runtime, /export \{ __prose_chars, .*__prose_each\b.* \};/);
  assert.equal(plugin.load("/src/other.js"), null);
});

test("the plugin compiles .prose files, including ones with queries, and ignores other files", () => {
  const result = plugin.transform.call(context, "export function twice takes n\n    return n * 2", "/src/twice.prose?import");
  assert.match(result.code, /from "virtual:prose-runtime";/);
  assert.match(result.code, /export \{ _prose_twice as twice \};/);
  assert.doesNotMatch(result.code, /function __prose_get/);
  assert.equal(plugin.transform.call(context, "const x = 1", "/src/x.ts"), null);
});

test("imported Prose files supply their signatures and are watched for changes", () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-vite-"));
  try {
    writeFileSync(join(folder, "math.prose"), "export function twice takes value\n    return value * 2");
    const watched = [];
    const watching = { ...context, addWatchFile: path => watched.push(path) };
    const result = plugin.transform.call(watching, 'use twice from "./math.prose"\nexport limit is twice 4 + 1', join(folder, "main.prose"));
    assert.match(result.code, /_prose_limit = \(_prose_twice\(4\) \+ 1\);/);
    assert.deepEqual(watched, [join(folder, "math.prose")]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("forwarded method signatures watch their transitive source files", () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-vite-forwarded-"));
  try {
    const leaf = join(folder, 'calculator.prose'), forward = join(folder, 'tools.prose');
    writeFileSync(leaf, 'export calculator is object\n    add is function takes a, b return a + b');
    writeFileSync(forward, 'use calculator from "./calculator.prose"\nexport math is calculator');
    const watched = [], watching = { ...context, addWatchFile: path => watched.push(path) };
    const result = plugin.transform.call(watching, 'use math from "./tools.prose"\nprint math.add 1, 2, 3', join(folder, 'main.prose'));
    assert.match(result.code, /\[1, 2\].*3\]/);
    assert.deepEqual(watched, [forward, leaf]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("compile errors name the file and line", () => {
  assert.throws(() => plugin.transform.call(context, "x is 1\nprint y", "/src/bad.prose"), error => {
    assert.match(error.message, /\/src\/bad\.prose: Line 2: Unknown name 'y'/);
    assert.deepEqual(error.loc, { file: "/src/bad.prose", line: 2, column: 0 });
    return true;
  });
});
