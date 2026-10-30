import { sourceLines } from './transpile.js';
import { collectSourceInfo } from './check-hover.js';
import { collectReferences } from './check-references.js';

const key = item => `${item.line}:${item.column}`;
const builtinHelpers = new Set(['__prose_length', '__prose_char_to_number', '__prose_number_to_char']);

/** Return only source word segments. Compiler objects stay inside the worker,
 * while underscores, punctuation, strings and comments keep grammar styling. */
export function collectSemanticTokens(ts, checker, generated, record) {
  const rows = record.source.split(/\r?\n/);
  const lines = sourceLines(record.source, { locations: true, embedded: true }), owners = new Map();
  for (const row of lines) for (const token of row.tokens) owners.set(token.source.line, row.tokens);
  const information = collectSourceInfo(ts, checker, generated, record, { hover: false, includeType: true });
  const found = new Map(information.map(item => [key(item), item]));
  const classifications = new Map();
  const bindings = collectReferences(ts, checker, generated, record);
  function callable(type) {
    return type && !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) &&
      checker.getNonNullableType(type).getCallSignatures().length > 0;
  }
  function invoked(node) {
    while (node?.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
    const parent = node?.parent;
    return parent && ts.isCallExpression(parent) && parent.expression === node;
  }
  function constructed(node) {
    while (node?.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
    return node?.parent && ts.isNewExpression(node.parent) && node.parent.expression === node;
  }
  function write(node) {
    const parent = node?.parent;
    if (!parent) return false;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
    const target = ts.isArrayLiteralExpression(parent) ? parent : node;
    return ts.isBinaryExpression(target.parent) && target.parent.left === target && target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  function native(symbol) {
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol?.getDeclarations() ?? [];
    return declarations.length && declarations.every(declaration => declaration.getSourceFile().isDeclarationFile &&
      /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/i.test(declaration.getSourceFile().fileName));
  }
  function iterator(binding) {
    return binding.occurrences.some(item => {
      const tokens = owners.get(item.line), at = tokens?.findIndex(token => token.source.line === item.line && token.source.start === item.column - 1);
      if (!tokens || tokens[0]?.value !== 'for') return false;
      return tokens[1]?.value === 'each' ? at > 1 && at < tokens.findIndex(token => token.value === 'in') : at === 1;
    });
  }
  for (const binding of bindings) {
    const loop = iterator(binding);
    for (const occurrence of binding.occurrences) {
      const id = key(occurrence), item = found.get(id);
      let type;
      if (!occurrence.ambiguous) {
        if (occurrence.mode !== 'index' && (invoked(item?.node) || binding.kind === 'function' || callable(item?.valueType)) &&
            !(binding.kind === 'parameter' && !invoked(item?.node))) type = 'proseFunction';
        else if (binding.kind === 'parameter') type = 'proseParameter';
        else if (loop) type = 'proseIterator';
        else if (key(binding.declaration) === id || write(item?.node)) type = 'proseBinding';
        else type = 'proseVariable';
      }
      // Reserve ambiguous selectors too, so a property-shaped helper cannot
      // override the decision to let the lexical grammar handle that word.
      classifications.set(id, { ...occurrence, type });
    }
  }
  for (const item of information) {
    const id = key(item), node = item.node;
    if (classifications.has(id) || !node) continue;
    let type;
    const helper = ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : '';
    if (builtinHelpers.has(helper)) type = 'proseBuiltin';
    else if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ||
        ts.isIdentifier(node) && ts.isPropertyAssignment(node.parent) && node.parent.name === node ||
        ['__prose_dot', '__prose_maybe_dot'].includes(helper)) {
      const symbol = item.symbol ?? (['__prose_dot', '__prose_maybe_dot'].includes(helper) && ts.isStringLiteral(node.arguments[2])
        ? checker.getPropertyOfType(checker.getNonNullableType(checker.getTypeAtLocation(node.arguments[0])), node.arguments[2].text) : undefined);
      type = callable(item.valueType) || invoked(ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) ? node.parent : node)
        ? native(symbol) ? 'proseBuiltin' : 'proseFunction' : 'proseProperty';
    } else if (native(item.symbol) && (callable(item.valueType) || invoked(node)) && !constructed(node)) type = 'proseBuiltin';
    if (type) classifications.set(id, { ...item, type });
  }
  const tokens = [];
  for (const item of classifications.values()) {
    if (!item.type) continue;
    const word = rows[item.line - 1]?.slice(item.column - 1, item.endColumn - 1);
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(word ?? '')) continue;
    for (const part of word.matchAll(/[^_]+/g)) tokens.push({ line: item.line, column: item.column + part.index, length: part[0].length, type: item.type });
  }
  return tokens.sort((a,b) => a.line-b.line || a.column-b.column);
}
