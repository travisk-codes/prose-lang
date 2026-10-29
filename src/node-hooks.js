import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  try {
    const { code } = compile(readFileSync(file, "utf8"), {
      runtime, readModule: moduleReader(file), sourceMap: "inline", filename: pathToFileURL(file).href
    });
    return { format: "module", source: code, shortCircuit: true };
  } catch (error) {
    if (error.line !== undefined) error.message = `${file}: ${error.message}`;
    throw error;
  }
}
