import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { camel, sourceLines } from './transpile.js';

export const sourceHash = source => createHash('sha256').update(source).digest('hex');
export const directProse = specifier => specifier.endsWith('.prose') && (specifier.startsWith('.') || isAbsolute(specifier));
const ignored = new Set(['node_modules', 'dist', 'build', 'coverage']);
const sourceFile = file => /\.(?:prose|[cm]?[jt]sx?)$/i.test(file) && !/\.d\.prose\.ts$|\.__prose_check__\./i.test(file);

/** Discover static consumers without parsing unrelated Prose bodies. Nested
 * projects, generated files and symlinks are outside the search boundary. */
export function discoverRefactorProject({ cwd, file, checked, overlays, typescript, canonical }) {
  const root = checked.project ? checked.projectRoot : relative(cwd, file).startsWith('..') ? checked.projectRoot : cwd;
  const ts = typescript ?? createRequire(join(checked.projectRoot, 'package.json'))('typescript');
  const buffers = new Map(overlays.map(([file, source]) => [canonical(file), source]));
  const sources = new Map(), directories = [], walked = new Set();
  function add(file) { const source = buffers.get(canonical(file)) ?? readFileSync(file, 'utf8'); sources.set(canonical(file), { file: resolve(file), source }); }
  function walk(directory) {
    directories.push({ file: directory, mtimeMs: statSync(directory).mtimeMs });
    if (directory !== root && existsSync(join(directory, 'tsconfig.json'))) return;
    walked.add(canonical(directory));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (sourceFile(file)) add(file);
    }
  }
  walk(root);
  for (const [file] of overlays) if (sourceFile(file) && walked.has(canonical(dirname(file)))) add(file);
  let options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowArbitraryExtensions: true };
  if (checked.project) {
    const config = ts.readConfigFile(checked.project, ts.sys.readFile);
    options = { ...options, ...ts.parseJsonConfigFileContent(config.config, ts.sys, checked.projectRoot).options };
  }
  const host = { ...ts.sys, fileExists: file => sources.has(canonical(file)) || ts.sys.fileExists(file) ||
    file.endsWith('.d.prose.ts') && sources.has(canonical(file.slice(0, -'.d.prose.ts'.length) + '.prose')) };
  function target(specifier, file) {
    if (directProse(specifier)) {
      const path = resolve(dirname(file), specifier);
      return existsSync(path) ? realpathSync(path) : path;
    }
    const result = ts.resolveModuleName(specifier, file, options, host).resolvedModule?.resolvedFileName;
    return result?.endsWith('.d.prose.ts') ? result.slice(0, -'.d.prose.ts'.length) + '.prose' : result;
  }
  const edges = [], invalid = [];
  for (const record of sources.values()) {
    if (record.file.endsWith('.prose')) {
      const rows = record.source.split(/\r?\n/);
      for (let index = 0; index < rows.length; index++) {
        if (!/^\uFEFF?use\b/.test(rows[index])) continue;
        let header = rows[index], tokens;
        for (let end = index; end < rows.length; end++) {
          try {
            tokens = sourceLines(header, { locations: true })[0]?.tokens;
            if (tokens?.at(-1)?.type === 'string' && tokens.at(-2)?.value === 'from') break;
          } catch { tokens = undefined; }
          if (!/^\s+\S/.test(rows[end + 1] ?? '')) { tokens = undefined; break; }
          header += '\n' + rows[end + 1];
        }
        if (!tokens) { invalid.push(record.file); continue; }
        const typeOnly = tokens[1]?.value === 'type' && tokens[2]?.type === 'word' && tokens[2]?.value !== 'from';
        if (typeOnly) continue;
        const names = tokens.slice(1, -2).filter(token => token.type === 'word').map(token => camel(token.value));
        const specifier = tokens.at(-1).value;
        const resolved = target(specifier, record.file);
        edges.push({ file: record.file, target: resolved, specifier, names,
          supported: directProse(specifier) && canonical(resolved) === canonical(resolve(dirname(record.file), specifier)) });
      }
    } else {
      const tree = ts.createSourceFile(record.file, record.source, ts.ScriptTarget.Latest, true);
      function visit(node) {
        let specifier, names = null;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          specifier = node.moduleSpecifier;
          const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
          if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) && !(ts.isImportDeclaration(node) && node.importClause?.name)) names = bindings.elements.map(item => (item.propertyName ?? item.name).text);
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) specifier = node.arguments[0];
        if (specifier && ts.isStringLiteralLike(specifier)) edges.push({ file: record.file, target: target(specifier.text, record.file), specifier: specifier.text, names, supported: false });
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  const files = [...sources.values()].map(record => ({ file: record.file, hash: sourceHash(record.source) }));
  if (checked.project) files.push({ file: checked.project, hash: sourceHash(readFileSync(checked.project, 'utf8')) });
  return { root, sources, edges, invalid, snapshot: { files, directories } };
}
