import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The declaration file TypeScript reads for `name.prose`: `name.d.prose.ts`. */
export const declarationPath = file => file.replace(/\.prose$/, ".d.prose.ts");

/** Whether a file already holds these declarations, ignoring line-ending differences. */
export function declarationsCurrent(file, declarations) {
  const path = declarationPath(file);
  return existsSync(path) && readFileSync(path, "utf8").replace(/\r\n/g, "\n") === declarations;
}

/** Writes a file's declarations unless they are already current; returns whether it wrote. */
export function writeDeclarations(file, declarations) {
  if (declarationsCurrent(file, declarations)) return false;
  writeFileSync(declarationPath(file), declarations);
  return true;
}

// Folders a search skips: dependencies and build output, as `prose check` skips them too.
const skippedFolders = new Set(["node_modules", "dist", "build", "coverage"]);

/** The `.prose` files in some files and folders, searching folders recursively. Hidden
 * entries, symlinks, and dependency or build folders are skipped.
 */
export function proseFiles(paths) {
  return paths.flatMap(path => {
    if (!existsSync(path)) throw new Error(`Input does not exist: ${path}`);
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
      if (entry.name.startsWith(".") || skippedFolders.has(entry.name) || entry.isSymbolicLink()) return [];
      const child = join(path, entry.name);
      return entry.isDirectory() ? proseFiles([child]) : entry.name.endsWith(".prose") ? [child] : [];
    });
  });
}
