import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { transpile } from "./transpile.js";
import { runtimeModule } from "./runtime.js";

const runtimeId = "virtual:prose-runtime";
const resolvedRuntimeId = "\0" + runtimeId;

/** A Vite plugin that compiles imported `.prose` files to ES modules sharing one runtime module. */
export default function prose() {
  return {
    name: "prose",
    resolveId(id) {
      return id === runtimeId ? resolvedRuntimeId : null;
    },
    load(id) {
      return id === resolvedRuntimeId ? runtimeModule : null;
    },
    transform(source, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".prose")) return null;
      // Watching imported Prose files recompiles this one when their function signatures change.
      const readModule = specifier => {
        const path = resolve(dirname(file), specifier);
        this.addWatchFile(path);
        return readFileSync(path, "utf8");
      };
      try {
        return { code: transpile(source, { runtime: runtimeId, readModule }), map: null };
      } catch (error) {
        if (error.line === undefined) throw error;
        this.error({ message: `${file}: ${error.message}`, id: file, loc: { file, line: error.line, column: 0 } });
      }
    }
  };
}
