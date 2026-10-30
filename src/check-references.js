import { camel, sourceLines } from './transpile.js';

const range = token => ({ line: token.source.line, column: token.source.start + 1, endColumn: token.source.start + token.source.raw.length + 1 });
const key = item => `${item.line}:${item.column}`;

function declares(ts, node) {
  const parent = node.parent;
  if ([ts.isVariableDeclaration, ts.isParameter, ts.isFunctionDeclaration, ts.isImportSpecifier].some(is => is(parent)) && parent.name === node) return true;
  const target = ts.isArrayLiteralExpression(parent) ? parent : node;
  return ts.isBinaryExpression(target.parent) && target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && target.parent.left === target ||
    ts.isForOfStatement(target.parent) && target.parent.initializer === target;
}

/** Index value bindings by checker identity. Source maps locate words; syntax
 * and receiver types distinguish property keys from references to local names. */
export function collectReferences(ts, checker, generated, record) {
  const lines = sourceLines(record.source, { locations: true }), owners = new Map(), bindings = new Map();
  for (const row of lines) for (const token of row.tokens) owners.set(token.source.line, row.tokens);
  function kind(type, seen = new Set()) {
    type = checker.getNonNullableType(type);
    if (seen.has(type)) return 'unknown';
    seen = new Set(seen).add(type);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return 'unknown';
    if (type.flags & ts.TypeFlags.StringLike || checker.isArrayType(type) || checker.isTupleType(type)) return 'sequence';
    if (type.isUnionOrIntersection()) {
      const kinds = type.types.map(part => kind(part, seen));
      if (type.isIntersection() && kinds.includes('sequence')) return 'sequence';
      return kinds.every(part => part === kinds[0]) ? kinds[0] : 'unknown';
    }
    if (type.getBaseTypes?.()?.some(base => kind(base, seen) === 'sequence')) return 'sequence';
    // A broad structural object contract can still hold an array at runtime.
    if (type.flags & (ts.TypeFlags.NonPrimitive | ts.TypeFlags.Object)) {
      return type.getSymbol()?.getDeclarations()?.some(ts.isObjectLiteralExpression) ? 'object' : 'unknown';
    }
    return 'object';
  }
  function numeric(type) {
    if (type.flags & ts.TypeFlags.NumberLike) return 'yes';
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return 'unknown';
    if (type.flags & ts.TypeFlags.Object && type.getSymbol()?.getName() === 'Number') return 'unknown';
    if (type.flags & ts.TypeFlags.Object && !checker.isArrayType(type) && !checker.isTupleType(type) && !type.getCallSignatures().length &&
        !type.getSymbol()?.getDeclarations()?.some(ts.isObjectLiteralExpression)) return 'unknown';
    if (type.isUnionOrIntersection()) {
      const kinds = type.types.map(numeric);
      return kinds.every(part => part === kinds[0]) ? kinds[0] : 'unknown';
    }
    return 'no';
  }
  function visit(node) {
    if (ts.isIdentifier(node) && node.text.startsWith('_prose_')) {
      const symbol = checker.getSymbolAtLocation(node), declarations = symbol?.getDeclarations() ?? [];
      const declaration = declarations.find(item => item.getSourceFile() === generated &&
        [ts.isVariableDeclaration, ts.isParameter, ts.isFunctionDeclaration, ts.isImportSpecifier].some(is => is(item)));
      if (declaration) {
        const position = generated.getLineAndCharacterOfPosition(node.getStart(generated));
        const original = record.lookup(position.line, position.character), name = node.text.slice('_prose_'.length);
        const tokens = original && owners.get(original.line);
        const candidates = tokens?.[0]?.value === 'on' && tokens[1]?.value === 'error' && declares(ts, node) ? tokens.slice(2) : tokens;
        const token = candidates?.find(token => token.type === 'word' && token.value === name &&
          (token.source.line > original.line || token.source.line === original.line && token.source.start >= original.column - 1));
        if (token) {
          let mode = 'name', reason;
          const parent = node.parent;
          const contextual = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) &&
            ['__prose_dot', '__prose_maybe_dot', '__prose_dot_set'].includes(parent.expression.text) && parent.arguments[1] === node;
          if (contextual) {
            const receiver = kind(checker.getTypeAtLocation(parent.arguments[0]));
            const index = numeric(checker.getTypeAtLocation(node));
            if (receiver === 'object' || index === 'no') mode = 'property';
            else {
              mode = 'index';
              if (receiver !== 'sequence' || index !== 'yes') reason = 'This binding is used in a dot that could mean either an index or a property. Make that access explicit before renaming.';
            }
          }
          if (mode !== 'property') {
            const previous = tokens[tokens.indexOf(token) - 1];
            const shorthand = ts.isPropertyAssignment(parent) && parent.initializer === node &&
              (previous?.value === 'object' || previous?.value === ',');
            const binding = bindings.get(symbol) ?? { name, kind: ts.isImportSpecifier(declaration) ? 'import' : ts.isParameter(declaration) ? 'parameter' : ts.isFunctionDeclaration(declaration) ? 'function' : 'variable', occurrences: new Map() };
            bindings.set(symbol, binding);
            const occurrence = { ...range(token), mode, ...(reason ? { ambiguous: true } : {}), ...(shorthand ? { shorthand: true } : {}) };
            binding.occurrences.set(key(occurrence), occurrence);
            if (declares(ts, node) && (!binding.declaration || occurrence.line < binding.declaration.line || occurrence.line === binding.declaration.line && occurrence.column < binding.declaration.column)) binding.declaration = range(token);
            if (reason) binding.reason = reason;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(generated);
  const exported = new Set(lines.filter(row => !row.indent && row.tokens[0]?.value === 'export').map(row => {
    const token = row.tokens[row.tokens[1]?.value === 'function' ? 2 : 1];
    return token && key(range(token));
  }));
  return [...bindings.entries()].filter(([, binding]) => binding.declaration).map(([symbol, binding]) => {
    const declaration = symbol.getDeclarations()?.find(ts.isImportSpecifier);
    const imported = declaration && { source: declaration.parent.parent.parent.moduleSpecifier.text,
      name: (declaration.propertyName ?? declaration.name).text };
    return { ...binding, ...(imported ? { imported } : {}),
    ...(exported.has(key(binding.declaration)) ? { exportName: camel(binding.name) } : {}),
    occurrences: [...binding.occurrences.values()].sort((a, b) => a.line - b.line || a.column - b.column)
  }; });
}
