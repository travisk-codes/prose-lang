import { runInNewContext } from "node:vm";
import { transpile } from "../src/transpile.js";

/** Runs a Prose program in a fresh context and returns what it printed: one entry per print,
 * which is the value itself, or a list of the values when it printed several (each of).
 * `globals` adds JavaScript values the program can use.
 */
export function run(source, globals = {}) {
  const output = [];
  const log = (...values) => output.push(values.length === 1 ? values[0] : values);
  runInNewContext(transpile(source), { ...globals, console: { log } }, { timeout: 1000 });
  // Copying turns the context's own objects and arrays into this realm's, for deepEqual.
  try { return structuredClone(output); } catch { return output; }
}
