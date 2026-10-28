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

/** The `.prose` files in some files and folders, searching folders recursively and skipping node_modules. */
export function proseFiles(paths) {
  return paths.flatMap(path => {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      const child = join(path, entry.name);
      return entry.isDirectory() ? proseFiles([child]) : entry.name.endsWith(".prose") ? [child] : [];
    });
  });
}
