#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { declarationPath, declarationsCurrent, proseFiles, writeDeclarations } from "../src/declarations.js";
import { moduleReader } from "../src/node-hooks.js";
import { compile } from "../src/transpile.js";

const usage = `Usage: node bin/prose.js <file.prose> [--run]
       node bin/prose.js types <files or folders...> [--check]

Outputs JavaScript, or executes it with --run. The types command writes a
TypeScript declaration file (name.d.prose.ts) for each .prose file that
exports something; --check only reports the ones that are out of date.`;

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log(usage);
  process.exit(args.includes("--help") ? 0 : 1);
}

function compileFile(file) {
  try {
    return compile(readFileSync(file, "utf8"), { readModule: moduleReader(file) });
  } catch (error) {
    throw new Error(`${relative(process.cwd(), file)}: ${error.message}`);
  }
}

try {
  if (args[0] === "types") {
    const check = args.includes("--check");
    const targets = args.slice(1).filter(arg => arg !== "--check");
    if (!targets.length || targets.some(arg => arg.startsWith("--"))) {
      console.error(usage);
      process.exit(1);
    }
    const stale = [];
    for (const file of proseFiles(targets.map(target => resolve(target)))) {
      const { declarations } = compileFile(file);
      if (!declarations) continue;
      const shown = relative(process.cwd(), declarationPath(file));
      if (check) {
        if (!declarationsCurrent(file, declarations)) stale.push(shown);
      } else if (writeDeclarations(file, declarations)) {
        console.log(`Wrote ${shown}`);
      }
    }
    if (stale.length) {
      console.error(`Out of date; run the types command without --check:\n  ${stale.join("\n  ")}`);
      process.exitCode = 1;
    }
  } else {
    if (args.length > 2 || (args.length === 2 && args[1] !== "--run") || args[0].startsWith("--")) {
      console.error(usage);
      process.exit(1);
    }
    const file = resolve(args[0]);
    if (args[1] === "--run") {
      // The hook compiles this file and every .prose file it imports as Node loads them.
      register("../src/node-hooks.js", import.meta.url);
      await import(pathToFileURL(file).href);
    } else {
      process.stdout.write(compileFile(file).code);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
