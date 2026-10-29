// Read-only measurement for the checking-output stage. The public checker
// command, diagnostic wording, and build/editor integration follow separately.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../src/transpile.js";
import { untypedError } from "../src/check.js";
import { declarationPath, proseFiles } from "../src/declarations.js";
import { sourceMapLookup } from "../src/source-map.js";

/** Check a project's src/ using its TypeScript and tsconfig, with fresh import
 * declarations and checking output kept entirely in memory.
 */
export function measureProject(project, { typescript } = {}) {
  project = resolve(project);
  const ts = typescript ?? createRequire(resolve(project, "package.json"))("typescript");
  const configFile = ts.findConfigFile(project, ts.sys.fileExists, "tsconfig.json");
  if (!configFile) throw new Error(`No tsconfig.json found for ${project}.`);
  const message = diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error) throw new Error(message(config.error));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configFile), {}, configFile);
  // A project containing only Prose has no TypeScript inputs (TS18003).
  const errors = parsed.errors.filter(diagnostic => diagnostic.code !== 18003);
  if (errors.length) throw new Error(errors.map(message).join("\n"));
  const options = { ...parsed.options, strict: true, noEmit: true, noUnusedLocals: false, noUnusedParameters: false };
  // Explicit child flags in a project's config otherwise override strict:true.
  for (const option of ts.optionDeclarations) if (option.strictFlag) options[option.name] = true;
  const canonical = name => {
    const path = resolve(name).replaceAll("\\", "/");
    return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();
  };
  const files = proseFiles([resolve(project, "src")]);
  const virtual = new Map(), mapped = new Map(), roots = [];
  for (const file of files) {
    const result = compile(readFileSync(file, "utf8"), {
      check: true, sourceMap: true, filename: file,
      readModule: specifier => readFileSync(resolve(dirname(file), specifier), "utf8")
    });
    const name = file.replace(/\.prose$/, ".prose-check.ts");
    roots.push(name);
    virtual.set(canonical(name), result.code);
    mapped.set(canonical(name), { file, lookup: sourceMapLookup(result.map) });
    if (result.declarations) virtual.set(canonical(declarationPath(file)), result.declarations);
  }
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getCurrentDirectory = () => project;
  host.getSourceFile = (name, version, ...rest) => virtual.has(canonical(name))
    ? ts.createSourceFile(name, virtual.get(canonical(name)), version, true)
    : getSourceFile.call(host, name, version, ...rest);
  host.fileExists = name => virtual.has(canonical(name)) || fileExists.call(host, name);
  host.readFile = name => virtual.get(canonical(name)) ?? readFile.call(host, name);
  const program = ts.createProgram(roots, options, host);
  const diagnostics = [];
  let ignored = 0;
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const text = message(diagnostic);
    if (untypedError(diagnostic.code, text)) { ignored++; continue; }
    const where = diagnostic.file && mapped.get(canonical(diagnostic.file.fileName));
    const generated = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
    const original = where && generated && where.lookup(generated.line, generated.character);
    diagnostics.push({
      file: diagnostic.file ? relative(project, where?.file ?? diagnostic.file.fileName).replaceAll("\\", "/") : "(project)",
      line: original?.line ?? (generated ? generated.line + 1 : null),
      column: original?.column ?? (generated ? generated.character + 1 : null),
      code: diagnostic.code, message: text,
      ...(where && !original ? { unmapped: true } : {})
    });
  }
  return { typescriptVersion: ts.version, modules: files.length, diagnostics, ignored };
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
