// The extension ships the same formatter, parser, and checker as the CLI.
// Editor analysis loads the workspace's TypeScript inside a background worker.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function build(output = new URL("./dist/formatter/", import.meta.url)) {
  const language = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const extension = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  if (extension.version !== language.version) {
    throw new Error(`VS Code extension ${extension.version} must match Prose ${language.version}. Update both package.json versions together.`);
  }
  mkdirSync(output, { recursive: true });
  for (const name of ["format.js", "transpile.js", "call-arity.js", "call-quick-fixes.js", "layout-diagnostics.js", "runtime.js", "check.js", "check-project.js", "check-hover.js", "check-any.js", "check-strict.js", "check-definition.js", "check-references.js", "check-refactor.js", "refactor-project.js", "check-semantic.js", "completions.js", "check-completion.js", "signature-help.js", "check-signature.js", "declarations.js", "source-map.js"]) {
    copyFileSync(new URL(`../../src/${name}`, import.meta.url), new URL(name, output));
  }
  writeFileSync(new URL("package.json", output), '{"type":"module"}\n');
  copyFileSync(new URL('../../src/markup.js', import.meta.url), new URL('markup.js', output));
  const runtime = new URL('../runtime/', output);
  mkdirSync(new URL('bin/', runtime), { recursive: true });
  mkdirSync(new URL('src/', runtime), { recursive: true });
  copyFileSync(new URL('../../bin/prose.js', import.meta.url), new URL('bin/prose.js', runtime));
  for (const name of readdirSync(new URL('../../src/', import.meta.url)).filter(name => name.endsWith('.js'))) {
    copyFileSync(new URL(`../../src/${name}`, import.meta.url), new URL(`src/${name}`, runtime));
  }
  writeFileSync(new URL('package.json', runtime), '{"type":"module"}\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) build();
