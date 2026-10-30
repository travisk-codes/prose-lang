import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkProject } from './check-project.js';
import { parse } from './transpile.js';
import { directProse, discoverRefactorProject } from './refactor-project.js';

const key = item => `${item.line}:${item.column}`;
const range = item => ({ line: item.line, column: item.column, endColumn: item.endColumn });
const at = (source, item) => source.split('\n').slice(0, item.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + item.column - 1;

export function refactorProject({ cwd = process.cwd(), project, refactor, overlays = [], typescript } = {}) {
  cwd = resolve(cwd);
  const file = resolve(cwd, refactor.file);
  const canonical = name => process.platform === 'win32' ? resolve(cwd, name).toLowerCase() : resolve(cwd, name);
  const buffers = new Map(overlays.map(([name, source]) => [canonical(name), source]));
  let analysisOverlays = overlays;
  const sourceOf = name => buffers.get(canonical(name)) ?? readFileSync(name, 'utf8');
  let targets = [file];
  const check = changes => checkProject({ cwd, project, typescript, targets, referenceAll: true,
    overlays: [...analysisOverlays.filter(([name]) => !changes.has(canonical(name))), ...changes.values()].map(item => Array.isArray(item) ? item : [item.file, item.source]) });
  const empty = { exitCode: 0, diagnostics: [], references: [] };
  let before = check(new Map());
  if (before.exitCode === 2) return { exitCode: 2, diagnostics: before.diagnostics };
  let records = before.references;
  let current = records?.find(record => canonical(record.file) === canonical(file));
  if (!current) return { ...empty, renameError: 'Fix the Prose syntax errors before renaming.' };
  const contains = (item, end = false) => item.line === refactor.line && item.column <= refactor.column && (end ? refactor.column === item.endColumn : refactor.column < item.endColumn);
  const select = record => record?.bindings.find(binding => binding.occurrences.some(item => contains(item))) ?? record?.bindings.find(binding => binding.occurrences.some(item => contains(item, true)));
  let selected = select(current), graph, exportFile, exportName, projectError;
  if (!selected) return { ...empty, renameError: 'Choose a Prose variable, parameter, or function name.' };
  if (selected.exportName || selected.imported) {
    if (selected.imported && !directProse(selected.imported.source)) projectError = 'Renaming this import requires support for aliases or JavaScript/TypeScript modules. Direct .prose imports are supported.';
    else {
      exportFile = selected.imported ? resolve(dirname(file), selected.imported.source) : file;
      exportName = selected.exportName ?? selected.imported.name;
      graph = discoverRefactorProject({ cwd, file, checked: before, overlays, typescript, canonical });
      for (const [key, record] of graph.sources) buffers.set(key, record.source);
      analysisOverlays = [...overlays.filter(([name]) => !graph.sources.has(canonical(name))), ...[...graph.sources.values()].map(record => [record.file, record.source])];
      if (!graph.sources.has(canonical(exportFile))) projectError = 'The exported declaration is outside this project’s refactoring boundary.';
      else {
        const consumers = graph.edges.filter(edge => edge.target && canonical(edge.target) === canonical(exportFile) && (!edge.names || edge.names.includes(exportName)));
        const unsupported = consumers.find(edge => !edge.supported);
        if (unsupported) projectError = `Cannot rename this export because ${unsupported.file} uses it through an unsupported import or re-export. Direct .prose imports are supported.`;
        else if (graph.invalid.length) projectError = `Fix the incomplete use statement in ${graph.invalid[0]} before renaming an export.`;
        targets = [...new Set([file, exportFile, ...consumers.filter(edge => edge.supported).map(edge => edge.file)])];
        before = check(new Map()); records = before.references;
        current = records?.find(record => canonical(record.file) === canonical(file)); selected = select(current);
        if (!selected) return { ...empty, renameError: 'Fix the Prose syntax errors in the importing files before refactoring this export.' };
      }
    }
  }
  const members = [];
  for (const record of records) for (const binding of record.bindings) {
    const match = !exportFile ? binding === selected
      : canonical(record.file) === canonical(exportFile) && binding.exportName === exportName ||
        binding.imported && directProse(binding.imported.source) && canonical(resolve(dirname(record.file), binding.imported.source)) === canonical(exportFile) && binding.imported.name === exportName;
    if (match) {
      if (graph && !graph.sources.has(canonical(record.file))) projectError ??= 'A consumer is outside this project’s refactoring boundary.';
      else members.push({ file: record.file, binding });
    }
  }
  if (exportFile && !members.some(member => canonical(member.file) === canonical(exportFile) && member.binding.exportName === exportName)) projectError ??= 'The exported declaration could not be resolved safely.';
  const result = { ...empty, ...(graph ? { projectSnapshot: graph.snapshot } : {}), references: members.flatMap(({ file, binding }) => binding.occurrences
    .filter(item => refactor.includeDeclaration !== false || key(item) !== key(binding.declaration)).map(item => ({ file, ...range(item) })))
    .sort((a,b) => a.file.localeCompare(b.file) || a.line-b.line || a.column-b.column) };
  const reason = projectError ?? members.find(member => member.binding.reason)?.binding.reason;
  if (reason) return { ...result, renameError: reason };
  const origin = selected.occurrences.find(item => contains(item)) ?? selected.occurrences.find(item => contains(item, true));
  result.rename = { ...range(origin), placeholder: selected.name };
  if (refactor.newName === undefined) return result;
  const name = refactor.newName;
  try {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error();
    parse(`${name} is 0`);
  } catch { return { ...result, renameError: 'Use a valid Prose variable name, without spaces or reserved words.' }; }
  if (name === selected.name) return { ...result, edits: [] };
  const edits = members.flatMap(({ file, binding }) => binding.occurrences.map(item => ({ ...range(item), file,
    newText: item.shorthand ? `${binding.name} is ${name}` : name,
    offset: at(sourceOf(file), item), length: item.endColumn - item.column,
    symbolOffset: item.shorthand ? binding.name.length + 4 : 0 })));
  const changes = new Map();
  for (const file of new Set(edits.map(item => item.file))) {
    let source = sourceOf(file);
    for (const item of edits.filter(item => item.file === file).sort((a, b) => b.offset - a.offset)) source = source.slice(0, item.offset) + item.newText + source.slice(item.offset + item.length);
    changes.set(canonical(file), { file, source });
  }
  const after = check(changes), next = after.references;
  const conflict = () => ({ ...result, renameError: 'That name would capture another binding, collide with an export, change a dot access, or make a connected module invalid. Choose a different name.' });
  if (!next || after.exitCode === 2 || next.length !== records.length) return conflict();
  for (const record of records) {
    const original = sourceOf(record.file), changed = changes.get(canonical(record.file))?.source ?? original;
    const recordEdits = edits.filter(item => canonical(item.file) === canonical(record.file));
    function translated(item) {
      const offset = at(original, item), edit = recordEdits.find(edit => edit.offset === offset);
      return offset + recordEdits.filter(edit => edit.offset < offset).reduce((sum, edit) => sum + edit.newText.length - edit.length, 0) + (edit?.symbolOffset ?? 0);
    }
    const expected = new Map(), actual = new Map();
    for (const binding of record.bindings) for (const item of binding.occurrences) expected.set(translated(item), translated(binding.declaration));
    const corresponding = next.find(item => canonical(item.file) === canonical(record.file));
    if (!corresponding) return conflict();
    for (const binding of corresponding.bindings) for (const item of binding.occurrences) actual.set(at(changed, item), at(changed, binding.declaration));
    if (expected.size !== actual.size || [...expected].some(([position, id]) => actual.get(position) !== id)) return conflict();
  }
  return { ...result, edits: edits.map(({ offset, length, symbolOffset, ...item }) => item)
    .sort((a,b) => a.file.localeCompare(b.file) || a.line-b.line || a.column-b.column) };
}
