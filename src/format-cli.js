import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { proseFiles } from "./declarations.js";
import { format } from "./format.js";
import { moduleReader } from "./node-hooks.js";

/** Prepare every edit before writing any files, so a syntax error leaves the batch alone. */
export function formatCommand(args) {
  const targets = [];
  let width = 80, check = false, stdinFile;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") check = true;
    else if (arg === "--width") width = Number(args[++i]);
    else if (arg.startsWith("--width=")) width = Number(arg.slice(8));
    else if (arg === "--stdin-filepath") {
      stdinFile = args[++i];
      if (!stdinFile) throw new Error("Expected a path after --stdin-filepath.");
    } else if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown format option: ${arg}`);
    else targets.push(arg);
  }
  if (!targets.length) throw new Error("Usage: node bin/prose.js format <files or folders...> [--width 80] [--check]");
  format("", { width }); // Validate the options even when a folder has no Prose files.
  if (targets.includes("-")) {
    if (targets.length !== 1 || check) throw new Error("Format stdin with '-' on its own, without --check.");
    const file = resolve(stdinFile ?? "stdin.prose");
    process.stdout.write(format(readFileSync(0, "utf8"), { width, readModule: moduleReader(file) }));
    return;
  }
  if (stdinFile) throw new Error("--stdin-filepath requires '-' as the input.");
  const edits = [];
  for (const file of new Set(proseFiles(targets.map(target => resolve(target))))) {
    const shown = relative(process.cwd(), file);
    if (!file.endsWith(".prose")) throw new Error(`${shown}: expected a .prose file.`);
    const source = readFileSync(file, "utf8");
    let formatted;
    try { formatted = format(source, { width, readModule: moduleReader(file) }); }
    catch (error) { throw new Error(`${shown}: ${error.message}`); }
    if (source !== formatted) edits.push({ file, shown, formatted });
  }
  for (const { file, shown, formatted } of edits) {
    if (!check) writeFileSync(file, formatted);
    console.log(`${check ? "Would format" : "Formatted"} ${shown}`);
  }
  if (check && edits.length) process.exitCode = 1;
}
