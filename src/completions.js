import { camel, sourceLines } from "./transpile.js";
import { hoverType } from "./check-hover.js";

// Locate the member being typed without treating strings, patterns, decimals,
// namespace types, or keyword-shaped properties as completion triggers.
export function completionContext(source, line, column) {
  const text = source.split(/\r?\n/)[line - 1], caret = column - 1;
  if (text === undefined || caret < 0 || caret > text.length) return;
  let lines;
  try { lines = sourceLines(source, { locations: true }); } catch { return; }
  const logical = lines.find(row => row.tokens.some(token => token.source.line === line));
  if (!logical) return;
  const tokens = logical.tokens.filter(token => token.source.line === line);
  const member = tokens.find(token => token.type === "word" && token.source.start <= caret && token.source.start + token.source.raw.length >= caret);
  let accessor, start, end;
  if (member) {
    accessor = tokens[tokens.indexOf(member) - 1];
    start = member.source.start; end = start + member.source.raw.length;
  } else {
    accessor = tokens.filter(token => token.source.start + token.source.raw.length <= caret).at(-1);
    if (!accessor || text.slice(accessor.source.start + accessor.source.raw.length, caret).trim()) return;
    start = end = caret;
  }
  if (accessor?.type !== "symbol" || ![".", ":"].includes(accessor.value)) return;
  const before = logical.tokens.slice(0, logical.tokens.indexOf(accessor));
  if (!before.length) return;
  // A bare integer followed by a dot may still be an unfinished decimal.
  if (!member && accessor.value === "." && before.at(-1).type === "number" && before.at(-2)?.value !== ".") return;
  const firstIndex = before[0]?.value === "export" ? 1 : 0, first = before[firstIndex];
  if (first?.value === "use" || first?.value === "type" && !["is", "as"].includes(before[firstIndex + 1]?.value)) return;
  let inType = false;
  for (let index = 0; index < before.length; index++) {
    const token = before[index];
    if (token.type !== "word" || [".", ":"].includes(before[index - 1]?.value) || ["is", "as"].includes(before[index + 1]?.value)) continue;
    if (["as", "giving"].includes(token.value)) inType = true;
    else if (["is", "return", "then", "else"].includes(token.value)) inType = false;
  }
  if (inType) return;
  const next = logical.tokens.find(token => token.source.line > line || token.source.line === line && token.source.start >= end && token !== member && token !== accessor);
  let suffix = " run";
  if (next && ["run", "with", "is", "as"].includes(next.value)) suffix = "";
  else if (next && (["number", "string", "pattern"].includes(next.type) || next.type === "symbol" && next.value === "(" ||
    next.type === "word" && !["if", "else", "and", "or", "otherwise", "mod", "xor", "shifted"].includes(next.value))) suffix = " with";
  let probe = "__prose_completion_probe_0", index = 0;
  while (source.includes(probe)) probe = `__prose_completion_probe_${++index}`;
  const rows = source.split('\n');
  rows[line - 1] = rows[line - 1].slice(0, start) + probe + suffix + rows[line - 1].slice(end);
  return { line, column, startColumn: start + 1, endColumn: end + 1, accessorColumn: accessor.source.start + 1,
    accessor: accessor.value, accessorPrefix: text.slice(accessor.source.start, start), prefix: text.slice(start, caret), probe, source: rows.join('\n') };
}

function propertySpelling(name) {
  if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) {
    const snake = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (camel(snake) === name) return { label: snake, insertText: snake, filterText: snake, bare: true };
    if (camel(name) === name) return { label: name, insertText: name, filterText: name, bare: true };
  }
  const key = `(${JSON.stringify(name)})`;
  return { label: key, insertText: key, filterText: name, bare: false };
}

export function collectCompletions(ts, checker, generated, context) {
  let target;
  function find(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === context.probe) target = node;
    ts.forEachChild(node, find);
  }
  find(generated);
  if (!target) return [];
  const receiver = checker.getTypeAtLocation(target.expression);
  if (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return [];
  const type = checker.getApparentType(checker.getNonNullableType(receiver));
  function sequence(type, seen = new Set()) {
    if (!type || seen.has(type)) return false;
    seen.add(type);
    if (type.flags & ts.TypeFlags.StringLike || checker.isArrayType(type) || checker.isTupleType(type)) return true;
    if (type.isUnionOrIntersection()) return type.types.some(part => sequence(part, seen));
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint && constraint !== type && sequence(constraint, seen)) return true;
    return type.getBaseTypes?.()?.some(base => sequence(base, seen)) ?? false;
  }
  const indexed = sequence(receiver), visible = new Map(checker.getSymbolsInScope(target, ts.SymbolFlags.Value).map(symbol => [symbol.getName(), symbol]));
  function possiblyNumeric(type) {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NumberLike | ts.TypeFlags.TypeParameter)) return true;
    return type.isUnionOrIntersection() && type.types.some(possiblyNumeric);
  }
  return checker.getPropertiesOfType(type).flatMap(symbol => {
    const name = symbol.getName();
    if (name === context.probe || name.startsWith('__@') || indexed && /^\d+$/.test(name)) return [];
    const declarations = symbol.getDeclarations() ?? [];
    if (declarations.some(declaration => declaration.name && ts.isPrivateIdentifier(declaration.name) || declaration.modifiers?.some(modifier =>
      [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(modifier.kind)))) return [];
    const spelling = propertySpelling(name), memberType = checker.getTypeOfSymbolAtLocation(symbol, target);
    const binding = spelling.bare && visible.get('_prose_' + camel(spelling.label));
    const escape = context.accessor === '.' && indexed && binding && possiblyNumeric(checker.getTypeOfSymbolAtLocation(binding, target));
    const rendered = hoverType(ts, checker, memberType, target);
    const signature = rendered.startsWith('function') ? rendered.replace(/^function/, 'function ' + spelling.label) : spelling.label + ' as ' + rendered;
    const note = escape ? `Uses :${spelling.label} to select the property because a visible variable could make this dot an index.`
      : !spelling.bare ? `Uses the exact JavaScript property ${JSON.stringify(name)}.` : name !== spelling.label ? `JavaScript property: ${name}.` : '';
    return [{ label: spelling.label, insertText: escape ? ':' + spelling.insertText : spelling.insertText,
      filterText: escape ? context.accessorPrefix + spelling.filterText : spelling.filterText,
      kind: memberType.getCallSignatures().length ? 'method' : 'property', detail: signature.slice(0, 2400),
      documentation: [ts.displayPartsToString(symbol.getDocumentationComment(checker)), note].filter(Boolean).join('\n\n'),
      line: context.line, startColumn: escape ? context.accessorColumn : context.startColumn, endColumn: context.endColumn }];
  }).sort((a, b) => a.label.localeCompare(b.label));
}
