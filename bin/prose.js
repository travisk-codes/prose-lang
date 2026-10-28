#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { transpile } from "../src/transpile.js";

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
  const output = transpile(readFileSync(args[0], "utf8"));
  if (args[1] === "--run") {
    const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", output], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else {
    process.stdout.write(output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
