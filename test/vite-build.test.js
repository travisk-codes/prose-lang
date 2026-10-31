import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import prose from "../src/vite.js";

test("a real Vite build bundles Prose modules and their shared runtime", async () => {
  const folder = mkdtempSync(join(tmpdir(), "prose-vite-build-"));
  try {
    writeFileSync(join(folder, "package.json"), '{"type":"module"}');
    writeFileSync(join(folder, "math.prose"), [
      "export function double takes value as number, giving number",
      "    return value * 2"
    ].join("\n"));
    writeFileSync(join(folder, "main.prose"), [
      'use double from "./math.prose"',
      "export function answer takes value as number, giving number",
      "    return double value"
    ].join("\n"));

    await build({
      root: folder,
      configFile: false,
      logLevel: "silent",
      plugins: [prose()],
      build: {
        lib: { entry: join(folder, "main.prose"), formats: ["es"], fileName: () => "main.js" },
        outDir: join(folder, "out"),
        emptyOutDir: true,
        minify: false,
        sourcemap: false
      }
    });

    const output = join(folder, "out", "main.js");
    const module = await import(pathToFileURL(output).href);
    assert.equal(module.answer(21), 42);
    assert.match(readFileSync(output, "utf8"), /_prose_answer as answer/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
