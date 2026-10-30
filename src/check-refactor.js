import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkProject } from './check-project.js';
import { parse } from './transpile.js';

const key = item => `${item.line}:${item.column}`;
const range = item => ({ line: item.line, column: item.column, endColumn: item.endColumn });
const at = (source, item) => source.split('\n').slice(0, item.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + item.column - 1;

/** References and rename are deliberately confined to one Prose file. Renames
 * are rechecked against every local binding before returning a workspace edit. */
export function refactorProject({ cwd = process.cwd(), project, refactor, overlays = [], typescript } = {}) {
  const file = resolve(cwd, refactor.file);
  const canonical = name => process.platform === 'win32' ? resolve(cwd, name).toLowerCase() : resolve(cwd, name);
  const source = overlays.find(([name]) => canonical(name) === canonical(file))?.[1] ?? readFileSync(file, 'utf8');
  const check = text => checkProject({ cwd, project, typescript, targets: [file], referenceTargets: [file],
    overlays: [...overlays.filter(([name]) => canonical(name) !== canonical(file)), [file, text]] });
  const before = check(source);
  if (before.exitCode === 2) return { exitCode: 2, diagnostics: before.diagnostics };
  const bindings = before.references?.find(record => canonical(record.file) === canonical(file))?.bindings;
  const empty = { exitCode: 0, diagnostics: [], references: [] };
  if (!bindings) return { ...empty, renameError: 'Fix the Prose syntax errors before renaming.' };
  const contains = (item, end = false) => item.line === refactor.line && item.column <= refactor.column && (end ? refactor.column === item.endColumn : refactor.column < item.endColumn);
  const selected = bindings.find(binding => binding.occurrences.some(item => contains(item))) ?? bindings.find(binding => binding.occurrences.some(item => contains(item, true)));
  if (!selected) return { ...empty, renameError: 'Choose a local Prose variable, parameter, or function name.' };
  const declaration = key(selected.declaration);
  const result = { ...empty, references: selected.occurrences.filter(item => refactor.includeDeclaration !== false || key(item) !== declaration).map(item => ({ file, ...range(item) })) };
  if (selected.reason) return { ...result, renameError: selected.reason };
  const origin = selected.occurrences.find(item => contains(item)) ?? selected.occurrences.find(item => contains(item, true));
  result.rename = { ...range(origin), placeholder: selected.name };
  if (refactor.newName === undefined) return result;
  const name = refactor.newName;
  try {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error();
    parse(`${name} is 0`);
  } catch { return { ...result, renameError: 'Use a valid Prose variable name, without spaces or reserved words.' }; }
  if (name === selected.name) return { ...result, edits: [] };
  const edits = selected.occurrences.map(item => ({ ...range(item), file,
    newText: item.shorthand ? `${selected.name} is ${name}` : name,
    offset: at(source, item), length: item.endColumn - item.column,
    symbolOffset: item.shorthand ? selected.name.length + 4 : 0 }));
  let changed = source;
  for (const item of [...edits].sort((a, b) => b.offset - a.offset)) changed = changed.slice(0, item.offset) + item.newText + changed.slice(item.offset + item.length);
  const after = check(changed);
  const next = after.references?.find(record => canonical(record.file) === canonical(file))?.bindings;
  const conflict = () => ({ ...result, renameError: 'That name would capture another binding, change a dot access, or make the program invalid. Choose a different name.' });
  if (!next || after.exitCode === 2) return conflict();
  function translated(item) {
    const offset = at(source, item), edit = edits.find(edit => edit.offset === offset);
    return offset + edits.filter(edit => edit.offset < offset).reduce((sum, edit) => sum + edit.newText.length - edit.length, 0) + (edit?.symbolOffset ?? 0);
  }
  const expected = new Map();
  for (const binding of bindings) {
    const id = translated(binding.declaration);
    for (const item of binding.occurrences) expected.set(translated(item), id);
  }
  const actual = new Map();
  for (const binding of next) {
    const id = at(changed, binding.declaration);
    for (const item of binding.occurrences) actual.set(at(changed, item), id);
  }
  if (expected.size !== actual.size || [...expected].some(([position, id]) => actual.get(position) !== id)) return conflict();
  return { ...result, edits: edits.map(({ offset, length, symbolOffset, ...item }) => item) };
}
