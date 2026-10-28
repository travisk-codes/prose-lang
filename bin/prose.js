#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { moduleReader } from "../src/node-hooks.js";
import { compile } from "../src/transpile.js";

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log("Usage: node bin/prose.js <file.prose> [--run]\n\nOutputs JavaScript, or executes it with --run.");
  process.exit(args.includes("--help") ? 0 : 1);
}
if (args.length > 2 || (args.length === 2 && args[1] !== "--run") || args[0].startsWith("--")) {
  console.error("Usage: node bin/prose.js <file.prose> [--run]");
  process.exit(1);
}
try {
  const file = resolve(args[0]);
  if (args[1] === "--run") {
    // The hook compiles this file and every .prose file it imports as Node loads them.
    register("../src/node-hooks.js", import.meta.url);
    await import(pathToFileURL(file).href);
  } else {
    process.stdout.write(compile(readFileSync(file, "utf8"), { readModule: moduleReader(file) }).code);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
