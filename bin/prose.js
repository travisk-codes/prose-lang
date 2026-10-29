#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { declarationPath, declarationsCurrent, proseFiles, writeDeclarations } from "../src/declarations.js";
import { moduleReader } from "../src/node-hooks.js";
import { compile } from "../src/transpile.js";
import { formatCommand } from "../src/format-cli.js";
import { checkCommand } from "../src/check-cli.js";

const usage = `Usage: node bin/prose.js <file.prose> [--run]
       node bin/prose.js check [files or folders...] [--project tsconfig.json] [--json]
       node bin/prose.js types <files or folders...> [--check]
       node bin/prose.js format <files or folders...> [--width 80] [--check]
       node bin/prose.js format - [--width 80] [--stdin-filepath file.prose]

Outputs JavaScript, or executes it with --run. The types command writes a
TypeScript declaration file (name.d.prose.ts) for each .prose file that
exports something; --check only reports the ones that are out of date.
Check uses the project's TypeScript and tsconfig without writing or running code.
Exit status: 0 for clean checks, 1 for source errors, 2 for check setup errors.
Format updates Prose files in place; --check reports changes without writing.
Use '-' to format standard input and print the result.`;

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log(usage);
  process.exit(args.includes("--help") ? 0 : 1);
}

function compileFile(file, sourceMap = false) {
  try {
    return compile(readFileSync(file, "utf8"), {
      readModule: moduleReader(file), filename: pathToFileURL(file).href,
      sourceMap: sourceMap ? "inline" : false
    });
  } catch (error) {
    throw new Error(`${relative(process.cwd(), file)}: ${error.message}`);
  }
}

let running = false;
try {
  if (args[0] === "check") {
    checkCommand(args.slice(1));
  } else if (args[0] === "format") {
    formatCommand(args.slice(1));
  } else if (args[0] === "types") {
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
    if (!existsSync(file)) throw new Error(`Input does not exist: ${file}`);
    if (args[1] === "--run") {
      running = true;
      process.setSourceMapsEnabled(true);
      // The hook compiles this file and every .prose file it imports as Node loads them.
      register("../src/node-hooks.js", import.meta.url);
      await import(pathToFileURL(file).href);
    } else {
      process.stdout.write(compileFile(file, true).code);
    }
  }
} catch (error) {
  const syntax = error?.name === "SyntaxError" && /Line \d+:/.test(error.message);
  console.error(running && !syntax ? (error?.stack ?? error?.message ?? error) : (error?.message ?? error));
  process.exitCode = 1;
}
