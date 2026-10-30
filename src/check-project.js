import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { compile } from "./transpile.js";
import { untypedError } from "./check.js";
import { declarationPath } from "./declarations.js";
import { sourceMapLookup } from "./source-map.js";
import { collectSourceInfo } from "./check-hover.js";
import { createAnyExplainer } from "./check-any.js";
import { strictDiagnostics } from "./check-strict.js";
import { collectCompletions } from "./completions.js";
import { collectSignatureHelp } from "./signature-help.js";
import { collectReferences } from "./check-references.js";
import { definitionResolver } from "./check-definition.js";

export class CheckSetupError extends Error {
  constructor(message, diagnostics = []) {
    super(message);
    this.diagnostics = diagnostics;
  }
}

function findConfig(start) {
  for (let directory = start;;) {
    const file = join(directory, "tsconfig.json");
    if (existsSync(file)) return file;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(entry.name) || entry.isSymbolicLink()) return [];
    const file = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : file.endsWith(".prose") ? [file] : [];
  });
}

/** Check Prose and its imported Prose dependencies without writing or executing
 * anything. Resolve TypeScript from the selected project, never from this tool.
 */
export function checkProject({ cwd = process.cwd(), project, targets = [], typescript, hoverTargets = [], definitionTargets = [], referenceTargets = [], overlays = [], strict = false, completionProbe, signatureProbe } = {}) {
  cwd = resolve(cwd);
  const bufferKey = file => process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
  const buffers = new Map(overlays.map(([file, source]) => [bufferKey(file), source]));
  const exists = file => buffers.has(bufferKey(file)) || existsSync(file);
  const directory = file => existsSync(file) && statSync(file).isDirectory();
  const sourceText = file => buffers.get(bufferKey(file)) ?? readFileSync(file, "utf8");
  const paths = targets.map(target => resolve(cwd, target));
  for (const path of paths) {
    if (!exists(path)) throw new CheckSetupError(`Input does not exist: ${path}`);
    if (!directory(path) && !path.endsWith(".prose")) throw new CheckSetupError(`Expected a .prose file or folder: ${path}`);
  }
  let configFile;
  if (project) {
    const selected = resolve(cwd, project);
    configFile = existsSync(selected) && statSync(selected).isDirectory() ? join(selected, "tsconfig.json") : selected;
    if (!existsSync(configFile) || !statSync(configFile).isFile()) throw new CheckSetupError(`Project configuration does not exist: ${configFile}`);
  } else {
    const start = paths[0] ? (directory(paths[0]) ? paths[0] : dirname(paths[0])) : cwd;
    configFile = findConfig(start);
    if (paths.some(path => findConfig(directory(path) ? path : dirname(path)) !== configFile)) {
      throw new CheckSetupError("Inputs belong to different projects. Check each project separately or select one with --project.");
    }
  }
  const projectRoot = configFile ? dirname(configFile) : (paths[0] ? (directory(paths[0]) ? paths[0] : dirname(paths[0])) : cwd);
  let ts = typescript;
  if (!ts) {
    const require = createRequire(join(projectRoot, "package.json"));
    let packagePath;
    try { packagePath = require.resolve("typescript"); }
    catch { throw new CheckSetupError(`TypeScript is not installed for ${projectRoot}. Install it there with npm.cmd install --save-dev typescript.`); }
    try { ts = require(packagePath); }
    catch (error) { throw new CheckSetupError(`Could not load the project's TypeScript: ${error.message}`); }
  }
  const major = Number.parseInt(ts.versionMajorMinor ?? ts.version, 10);
  if (major < 5 || major >= 7 || !ts.createProgram || !ts.createCompilerHost || !ts.parseJsonConfigFileContent) {
    throw new CheckSetupError("The project's TypeScript package does not expose the supported compiler API. Use TypeScript 5 or 6.");
  }
  const text = diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const ordinaryDiagnostic = (diagnostic, source = "typescript") => {
    const position = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
    return {
      source, code: diagnostic.code, severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      file: diagnostic.file ? resolve(diagnostic.file.fileName) : null,
      line: position ? position.line + 1 : null, column: position ? position.character + 1 : null,
      message: text(diagnostic)
    };
  };
  let parsed;
  if (configFile) {
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    if (config.error) throw new CheckSetupError("Could not read the project configuration.", [ordinaryDiagnostic(config.error, "configuration")]);
    parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot, {}, configFile, undefined,
      [{ extension: ".prose", isMixedContent: false, scriptKind: ts.ScriptKind.Deferred }]);
    const errors = parsed.errors.filter(diagnostic => diagnostic.code !== 18003);
    if (errors.length) throw new CheckSetupError("Invalid project configuration.", errors.map(diagnostic => ordinaryDiagnostic(diagnostic, "configuration")));
  }
  const options = {
    target: ts.ScriptTarget.ES2023 ?? ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true, ...parsed?.options,
    strict: true, noCheck: false, noEmit: true, allowArbitraryExtensions: true,
    noUnusedLocals: false, noUnusedParameters: false
  };
  for (const option of ts.optionDeclarations ?? []) if (option.strictFlag) options[option.name] = true;
  const canonical = name => {
    const normalized = resolve(name).replaceAll("\\", "/");
    return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
  };
  const selected = paths.length ? paths.flatMap(path => directory(path) ? filesUnder(path) : [path])
    : parsed ? parsed.fileNames.filter(file => file.endsWith(".prose")) : filesUnder(cwd);
  const records = new Map(), virtual = new Map(), sourceErrors = [];
  const proseForDeclaration = name => {
    if (!name.endsWith(".d.prose.ts")) return null;
    const file = name.slice(0, -".d.prose.ts".length) + ".prose";
    return exists(file) ? file : null;
  };
  const resolutionHost = {
    ...ts.sys, getCurrentDirectory: () => projectRoot,
    fileExists: name => buffers.has(bufferKey(name)) || virtual.has(canonical(name)) || ts.sys.fileExists(name) || Boolean(proseForDeclaration(name)),
    readFile: name => buffers.get(bufferKey(name)) ?? ts.sys.readFile(name)
  };
  const cache = ts.createModuleResolutionCache(projectRoot, canonical, options);
  function importedSource(specifier, importer) {
    if (specifier.startsWith(".") || isAbsolute(specifier)) {
      const direct = resolve(dirname(importer), specifier);
      if (exists(direct)) return direct;
    }
    const result = ts.resolveModuleName(specifier, importer, options, resolutionHost, cache).resolvedModule;
    const file = result && proseForDeclaration(result.resolvedFileName);
    if (file) return file;
    throw new Error(`Cannot find Prose module '${specifier}'.`);
  }
  function prepare(file) {
    file = resolve(file);
    const key = canonical(file);
    if (records.has(key)) return records.get(key);
    let name = file + ".__prose_check__.ts";
    while (exists(name) || virtual.has(canonical(name))) name += ".ts";
    const record = { file, name, declaration: declarationPath(file), code: "export {};", declarations: "export {};" };
    records.set(key, record);
    virtual.set(canonical(name), { record, declaration: false });
    virtual.set(canonical(record.declaration), { record, declaration: true });
    try {
      record.source = sourceText(file);
      const result = compile(record.source, {
        check: true, sourceMap: true, filename: file,
        signatureProbe: signatureProbe && canonical(signatureProbe.file) === key ? signatureProbe.probe : undefined,
        readModule: specifier => sourceText(importedSource(specifier, file))
      });
      record.code = result.code;
      record.declarations = result.declarations ?? "export {};";
      record.lookup = sourceMapLookup(result.map);
    } catch (error) {
      sourceErrors.push({ source: "prose", code: "PROSE", severity: "error", file,
        line: error.line ?? null, column: error.column ?? (error.line ? 1 : null),
        message: String(error.message).replace(/^Line \d+:\s*/, ""),
        ...(error.relatedInformation ? { relatedInformation: error.relatedInformation.map(item => ({ file, ...item })) } : {}) });
    }
    return record;
  }
  for (const file of selected) prepare(file);
  const host = ts.createCompilerHost(options);
  const { getSourceFile, readFile } = host;
  const virtualFile = name => {
    const entry = virtual.get(canonical(name));
    if (entry) return entry;
    const prose = proseForDeclaration(name);
    return prose ? { record: prepare(prose), declaration: true } : null;
  };
  host.getCurrentDirectory = () => projectRoot;
  host.fileExists = resolutionHost.fileExists;
  host.readFile = name => {
    const entry = virtualFile(name);
    return entry ? entry.record[entry.declaration ? "declarations" : "code"] : buffers.get(bufferKey(name)) ?? readFile.call(host, name);
  };
  host.getSourceFile = (name, version, ...rest) => {
    const entry = virtualFile(name);
    if (!entry) return buffers.has(bufferKey(name))
      ? ts.createSourceFile(name, buffers.get(bufferKey(name)), version, true) : getSourceFile.call(host, name, version, ...rest);
    const source = ts.createSourceFile(name, entry.record[entry.declaration ? "declarations" : "code"], version, true, ts.ScriptKind.TS);
    if ([ts.ModuleKind.Node16, ts.ModuleKind.NodeNext].includes(options.module)) source.impliedNodeFormat = ts.ModuleKind.ESNext;
    return source;
  };
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, containingSourceFile) => literals.map(literal => {
    const mode = ts.getModeForUsageLocation?.(containingSourceFile, literal, compilerOptions);
    const result = ts.resolveModuleName(literal.text, containingFile, compilerOptions, host, cache, redirected, mode);
    if (result.resolvedModule) virtualFile(result.resolvedModule.resolvedFileName);
    return result;
  });
  // Even an unexpected emit request cannot modify the filesystem.
  host.writeFile = () => { throw new Error("The Prose checker cannot emit files."); };
  const ambient = (parsed?.fileNames ?? []).filter(file => /\.d\.[cm]?ts$/.test(file) && !proseForDeclaration(file));
  let program, diagnostics = [], count = -1, ignored = 0;
  // Resolving a fresh declaration may discover a Prose dependency outside the
  // selected roots. Add its checking body too, including through TypeScript imports.
  while (count !== records.size && !sourceErrors.length) {
    count = records.size;
    const roots = [...records.values()].flatMap(record => strict ? [record.name, record.declaration] : [record.name]).concat(ambient);
    program = ts.createProgram({ rootNames: roots, options, host, oldProgram: program, projectReferences: parsed?.projectReferences });
    diagnostics = ts.getPreEmitDiagnostics(program);
  }
  const result = {
    project: configFile ?? null, projectRoot, typescriptVersion: ts.version,
    files: [...records.values()].map(record => record.file).sort(), diagnostics: [...sourceErrors], ignored: 0, exitCode: sourceErrors.length ? 1 : 0,
    ...(strict ? { strict: true } : {})
  };
  if (hoverTargets.length) result.hovers = [];
  if (definitionTargets.length) result.definitions = [];
  if (referenceTargets.length) result.references = [];
  if (completionProbe) result.completions = [];
  if (sourceErrors.length) return result;
  for (const file of referenceTargets) {
    const record = records.get(canonical(resolve(cwd, file)));
    if (record) result.references.push({ file: record.file,
      bindings: collectReferences(ts, program.getTypeChecker(), program.getSourceFile(record.name), record) });
  }
  if (completionProbe) {
    const record = records.get(canonical(completionProbe.file));
    if (record) result.completions = collectCompletions(ts, program.getTypeChecker(), program.getSourceFile(record.name), completionProbe);
  }
  if (signatureProbe) {
    const record = records.get(canonical(signatureProbe.file));
    if (record) result.signatureHelp = collectSignatureHelp(ts, program.getTypeChecker(), program.getSourceFile(record.name), record, signatureProbe);
  }
  if (strict || hoverTargets.length || definitionTargets.length) {
    const hoverFiles = new Set(hoverTargets.map(file => canonical(resolve(cwd, file))));
    const definitionFiles = new Set(definitionTargets.map(file => canonical(resolve(cwd, file))));
    const checker = program.getTypeChecker();
    const explainAny = hoverTargets.length ? createAnyExplainer(ts, checker, program, records.values()) : undefined;
    const information = new Map();
    for (const record of records.values()) if (strict || hoverFiles.has(canonical(record.file)) || definitionTargets.length) {
      const items = collectSourceInfo(ts, checker, program.getSourceFile(record.name), record, { hover: hoverFiles.has(canonical(record.file)), explainAny });
      information.set(record, items);
      if (hoverFiles.has(canonical(record.file))) result.hovers.push(...items.map(({ node, symbol, priority, ...item }) => item));
    }
    if (strict) result.diagnostics.push(...strictDiagnostics(ts, checker, program, records.values(), information));
    if (definitionTargets.length) {
      const resolveDefinition = definitionResolver(ts, checker, records.values(), information, canonical);
      for (const [record, items] of information) if (definitionFiles.has(canonical(record.file))) {
        result.definitions.push(...items.flatMap(item => {
          const targets = resolveDefinition(item.symbol);
          return targets.length ? [{ file: item.file, line: item.line, column: item.column, endColumn: item.endColumn, targets }] : [];
        }));
      }
    }
  }
  const optionErrors = new Set(program?.getOptionsDiagnostics() ?? []);
  for (const diagnostic of diagnostics) {
    const entry = diagnostic.file && virtual.get(canonical(diagnostic.file.fileName));
    // The corresponding checking body reports these more accurately than its
    // generated import declaration, and cannot be skipped by skipLibCheck.
    if (entry?.declaration) continue;
    const message = text(diagnostic);
    if (entry && untypedError(diagnostic.code, message)) { ignored++; continue; }
    const item = ordinaryDiagnostic(diagnostic, optionErrors.has(diagnostic) ? "configuration" : "typescript");
    if (entry) {
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const original = entry.record.lookup?.(position.line, position.character);
      item.file = entry.record.file;
      item.line = original?.line ?? null;
      item.column = original?.column ?? null;
      if (!original) item.source = "checker";
    }
    result.diagnostics.push(item);
  }
  result.ignored = ignored;
  result.diagnostics.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
  if (result.diagnostics.some(item => item.severity === "error")) result.exitCode = optionErrors.size ? 2 : 1;
  return result;
}
