import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "./transpile.js";

const runtime = new URL("./runtime.js", import.meta.url).href;

/** Reads modules imported by `file`, with paths relative to it. */
export function moduleReader(file) {
  return specifier => readFileSync(resolve(dirname(file), specifier), "utf8");
}

/** A Node module hook that compiles `.prose` files as they are imported. Register it with `module.register`. */
export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.split(/[?#]/)[0].endsWith(".prose")) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const { code } = compile(readFileSync(file, "utf8"), { runtime, readModule: moduleReader(file) });
  return { format: "module", source: code, shortCircuit: true };
}
