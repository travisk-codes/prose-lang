// The extension ships the same formatter, parser, and checker as the CLI.
// Editor analysis loads the workspace's TypeScript inside a background worker.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function build(output = new URL("./dist/formatter/", import.meta.url)) {
  mkdirSync(output, { recursive: true });
  for (const name of ["format.js", "transpile.js", "call-arity.js", "layout-diagnostics.js", "runtime.js", "check.js", "check-project.js", "check-hover.js", "check-any.js", "check-strict.js", "check-definition.js", "check-references.js", "check-refactor.js", "refactor-project.js", "check-semantic.js", "completions.js", "check-completion.js", "signature-help.js", "check-signature.js", "declarations.js", "source-map.js"]) {
    copyFileSync(new URL(`../../src/${name}`, import.meta.url), new URL(name, output));
  }
  writeFileSync(new URL("package.json", output), '{"type":"module"}\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) build();
