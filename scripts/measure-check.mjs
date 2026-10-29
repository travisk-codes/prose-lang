// Keep the historical Datums audit format, using the same public checker.
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkProject } from "../src/check-project.js";

/** Check a project's src/ using its TypeScript and tsconfig, with fresh import
 * declarations and checking output kept entirely in memory.
 */
export function measureProject(project, { typescript } = {}) {
  project = resolve(project);
  const result = checkProject({ cwd: project, project, targets: [resolve(project, "src")], typescript });
  return {
    typescriptVersion: result.typescriptVersion, modules: result.files.length,
    diagnostics: result.diagnostics.map(diagnostic => ({
      file: diagnostic.file ? relative(project, diagnostic.file).replaceAll("\\", "/") : "(project)",
      line: diagnostic.line, column: diagnostic.column, code: diagnostic.code, message: diagnostic.message,
      ...(diagnostic.source === "checker" ? { unmapped: true } : {})
    })),
    ignored: result.ignored
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const paths = args.filter(arg => arg !== "--json");
    if (paths.length !== 1 || paths[0].startsWith("-")) throw new Error("Usage: node scripts/measure-check.mjs <project folder> [--json]");
    const result = measureProject(paths[0]);
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.modules} Prose modules; ${result.diagnostics.length} diagnostics; TypeScript ${result.typescriptVersion}`);
      for (const diagnostic of result.diagnostics) console.log(`${diagnostic.file}:${diagnostic.line ?? "?"}:${diagnostic.column ?? "?"} TS${diagnostic.code} ${diagnostic.message}`);
    }
    if (result.diagnostics.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
