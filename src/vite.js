import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeDeclarations } from "./declarations.js";
import { compile } from "./transpile.js";
import { runtimeModule } from "./runtime.js";

const runtimeId = "virtual:prose-runtime";
const resolvedRuntimeId = "\0" + runtimeId;

/**
 * A Vite plugin that compiles imported `.prose` files to ES modules sharing one runtime module.
 * With `declarations: true`, it also keeps each file's `.d.prose.ts` up to date as files compile.
 */
export default function prose({ declarations = false } = {}) {
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
        const result = compile(source, { runtime: runtimeId, readModule });
        if (declarations && result.declarations) writeDeclarations(file, result.declarations);
        return { code: result.code, map: null };
      } catch (error) {
        if (error.line === undefined) throw error;
        this.error({ message: `${file}: ${error.message}`, id: file, loc: { file, line: error.line, column: 0 } });
      }
    }
  };
}
