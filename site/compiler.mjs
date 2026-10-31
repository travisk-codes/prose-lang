import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runtimeSource } from "../src/runtime.js";

const runtimePath = fileURLToPath(new URL("../src/runtime.js", import.meta.url));
const runtimeMarker = 'export const runtimeSource = helpers.map(helper => helper.toString()).join("\\n\\n");';

// esbuild reprints function bodies, so calling toString on the bundled helpers would
// embed different source than the Node compiler. Keep the exact Node source instead.
function preserveRuntimeSource() {
  return {
    name: "preserve-runtime-source",
    setup(build) {
      build.onLoad({ filter: /runtime\.js$/ }, args => {
        if (args.path.replace(/\\/g, "/") !== runtimePath.replace(/\\/g, "/")) return null;
        const text = readFileSync(args.path, "utf8");
        if (!text.includes(runtimeMarker)) throw new Error("Runtime source marker changed; update site/compiler.mjs.");
        return {
          contents: text.replace(runtimeMarker, `export const runtimeSource = ${JSON.stringify(runtimeSource)};`),
          loader: "js"
        };
      });
    }
  };
}

/** The browser compiler for the playground: one esbuild bundle of the same
 * modules the CLI and extension use. */
export async function browserCompiler() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("compiler-entry.js", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "Prose",
    platform: "browser",
    target: ["es2020"],
    write: false,
    legalComments: "none",
    logLevel: "silent",
    plugins: [preserveRuntimeSource()]
  });
  return result.outputFiles[0].text;
}
