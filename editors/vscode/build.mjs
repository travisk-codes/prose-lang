// The extension ships the same formatter, parser, and checker as the CLI.
// Only checking loads the workspace's TypeScript, inside a background worker.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function build(output = new URL("./dist/formatter/", import.meta.url)) {
  mkdirSync(output, { recursive: true });
  for (const name of ["format.js", "transpile.js", "runtime.js", "check.js", "check-project.js", "declarations.js", "source-map.js"]) {
    copyFileSync(new URL(`../../src/${name}`, import.meta.url), new URL(name, output));
  }
  writeFileSync(new URL("package.json", output), '{"type":"module"}\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) build();
