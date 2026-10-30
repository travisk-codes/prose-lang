import { camel, sourceLines, markupExpressionAt } from "./transpile.js";
import { hoverType } from "./check-hover.js";

// Locate a member or expression name without changing the user's source.
export function completionContext(source, line, column) {
  return memberContext(source, line, column) ?? identifierContext(source, line, column);
}

function memberContext(source, line, column) {
  const text = source.split(/\r?\n/)[line - 1], caret = column - 1;
  if (text === undefined || caret < 0 || caret > text.length) return;
  let lines;
  try { const embedded = markupExpressionAt(source, line, column); lines = embedded ? [{ tokens: embedded.tokens }] : sourceLines(source, { locations: true }); } catch { return; }
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

// A literal probe has no binding and cannot shadow an existing name. Invalid
// declaration/property/type positions are rejected by the normal Prose parser.
// The checker sees it as never, preserving contextual callback inference.
const keywords = new Set(('if else for is to print and or not true false null remainder function return while async await takes run mod object array with new each in then use export unset otherwise maybe as giving are skip stop try fail xor').split(' '));
function identifierContext(source, line, column) {
  const rows = source.split('\n'), text = rows[line - 1]?.replace(/\r$/, ''), caret = column - 1;
  if (text === undefined || caret < 0 || caret > text.length) return;
  let lines;
  try { const embedded = markupExpressionAt(source, line, column); lines = embedded ? [{ tokens: embedded.tokens }] : sourceLines(source, { locations: true }); } catch { return; }
  const logical = lines.find(row => row.tokens.some(token => token.source.line === line));
  const tokens = logical?.tokens ?? [];
  const word = tokens.find(token => token.type === 'word' && token.source.line === line && token.source.start <= caret && token.source.start + token.source.raw.length >= caret);
  if (word && keywords.has(word.value)) return;
  if (!word && tokens.some(token => ['number', 'string', 'pattern'].includes(token.type) && token.source.line === line && token.source.start <= caret && token.source.start + token.source.raw.length >= caret)) return;
  const start = word?.source.start ?? caret, end = word ? start + word.source.raw.length : caret;
  const before = tokens.filter(token => token.source.line < line || token.source.start < start);
  const after = tokens.filter(token => token.source.line > line || token.source.start >= end && token !== word);
  const firstIndex = tokens[0]?.value === 'export' ? 1 : 0, first = tokens[firstIndex];
  if (first?.value === 'use' || first?.value === 'type' && !['is', 'as'].includes(tokens[firstIndex + 1]?.value) || ['.', ':'].includes(before.at(-1)?.value) ||
      ['is', 'as', 'are', 'in', 'to'].includes(after[0]?.value)) return;
  let probe = '__prose_identifier_probe_0', serial = 0;
  while (source.includes(probe)) probe = `__prose_identifier_probe_${++serial}`;
  const next = after[0];
  const suffix = next && (['number', 'string', 'pattern'].includes(next.type) || next.type === 'symbol' && next.value === '(' ||
    next.type === 'word' && !keywords.has(next.value)) ? ' with' : '';
  rows[line - 1] = rows[line - 1].slice(0, start) + JSON.stringify(probe) + suffix + rows[line - 1].slice(end);
  // Only the selected logical expression is repaired. A constructor's `new`
  // requires a name, so mask it while the probe stands in for that name.
  const previous = before.at(-1);
  if (previous?.value === 'new') {
    const at = previous.source;
    rows[at.line - 1] = rows[at.line - 1].slice(0, at.start) + ' '.repeat(at.raw.length) + rows[at.line - 1].slice(at.start + at.raw.length);
  }
  const depth = tokens.reduce((depth, token) => depth + (token.type !== 'symbol' ? 0 : token.value === '(' ? 1 : token.value === ')' ? -1 : 0), 0);
  if (depth > 0) {
    const lastLine = tokens.at(-1).source.line - 1;
    rows[lastLine] = rows[lastLine].replace(/\r?$/, ')'.repeat(depth) + (rows[lastLine].endsWith('\r') ? '\r' : ''));
  }
  return { kind: 'identifier', line, column, startColumn: start + 1, endColumn: end + 1,
    prefix: text.slice(start, caret), probe, source: rows.join('\n') };
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
  if (context.kind === 'identifier') return collectIdentifiers(ts, checker, generated, context);
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

function collectIdentifiers(ts, checker, generated, context) {
  let marker;
  function find(node) {
    if (ts.isStringLiteral(node) && node.text === context.probe) marker = node;
    ts.forEachChild(node, find);
  }
  find(generated);
  if (!marker) return [];
  return checker.getSymbolsInScope(marker, ts.SymbolFlags.Value | ts.SymbolFlags.Alias).flatMap(symbol => {
    const name = symbol.getName();
    // Only bindings emitted from this Prose file are eligible. This excludes
    // type-only imports, globals, compiler helpers, and automatic imports.
    if (!name.startsWith('_prose_') || !symbol.getDeclarations()?.some(node => node.getSourceFile() === generated)) return [];
    if (symbol.flags & ts.SymbolFlags.Alias && !(checker.getAliasedSymbol(symbol).flags & ts.SymbolFlags.Value)) return [];
    const label = name.slice('_prose_'.length);
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(label) || keywords.has(label)) return [];
    const type = checker.getTypeOfSymbolAtLocation(symbol, marker), rendered = hoverType(ts, checker, type, marker);
    const callable = type.getCallSignatures().length > 0;
    const parameter = symbol.getDeclarations()?.some(node => ts.isParameter(node));
    return [{ label, insertText: label, filterText: label, kind: callable ? 'function' : 'variable',
      detail: (rendered.startsWith('function') ? rendered.replace(/^function/, 'function ' + label) : label + ' as ' + rendered).slice(0, 2400),
      documentation: [parameter ? 'Parameter in this scope.' : '', ts.displayPartsToString(symbol.getDocumentationComment(checker))].filter(Boolean).join('\n\n'),
      line: context.line, startColumn: context.startColumn, endColumn: context.endColumn }];
  }).sort((a, b) => a.label.localeCompare(b.label));
}
