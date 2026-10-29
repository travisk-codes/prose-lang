import { camel, sourceLines } from "./transpile.js";
import { resolve } from "node:path";

const range = item => ({ file: item.file, line: item.line, column: item.column, endColumn: item.endColumn });

// Hoisted Prose variables have synthetic TypeScript declarations. Their first
// source assignment is the declaration users should navigate to instead.
function declares(ts, node) {
  const parent = node.parent;
  if ([ts.isVariableDeclaration, ts.isParameter, ts.isFunctionDeclaration, ts.isInterfaceDeclaration,
    ts.isTypeAliasDeclaration, ts.isTypeParameterDeclaration].some(is => is(parent)) && parent.name === node) return true;
  let target = node;
  if (ts.isArrayLiteralExpression(parent)) target = parent;
  return ts.isBinaryExpression(target.parent) && target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && target.parent.left === target ||
    ts.isForOfStatement(target.parent) && target.parent.initializer === target;
}

/** Resolve symbols to original Prose declarations or real TypeScript/JavaScript
 * files. Virtual checking files and generated .d.prose.ts files never escape.
 */
export function definitionResolver(ts, checker, records, information, canonical) {
  const locals = new Map(), virtual = new Map(), exports = new Map();
  for (const record of records) {
    virtual.set(canonical(record.name), record);
    virtual.set(canonical(record.declaration), record);
    const names = new Map();
    for (const line of sourceLines(record.source, { locations: true })) {
      if (line.indent || line.tokens[0]?.value !== "export") continue;
      const token = line.tokens[["function", "type"].includes(line.tokens[1]?.value) ? 2 : 1];
      if (token?.type === "word") names.set(camel(token.value), {
        file: record.file, line: token.source.line, column: token.source.start + 1, endColumn: token.source.start + token.source.raw.length + 1
      });
    }
    exports.set(record, names);
  }
  for (const items of information.values()) for (const item of items) {
    if (item.symbol && ts.isIdentifier(item.node) && declares(ts, item.node) && !locals.has(item.symbol)) {
      locals.set(item.symbol, range(item));
    }
  }
  return symbol => {
    if (!symbol) return [];
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (locals.has(symbol)) return [locals.get(symbol)];
    const targets = [];
    for (const declaration of symbol.getDeclarations() ?? []) {
      const source = declaration.getSourceFile();
      const record = virtual.get(canonical(source.fileName));
      if (record) {
        const topLevel = declaration.parent === source || ts.isVariableDeclaration(declaration) && declaration.parent.parent?.parent === source;
        if (topLevel && canonical(source.fileName) === canonical(record.declaration)) {
          const target = exports.get(record).get(symbol.getName());
          if (target) targets.push(target);
        }
        continue;
      }
      const name = declaration.name ?? declaration;
      const start = source.getLineAndCharacterOfPosition(name.getStart(source));
      const end = source.getLineAndCharacterOfPosition(name.getEnd());
      targets.push({ file: resolve(source.fileName), line: start.line + 1, column: start.character + 1,
        endLine: end.line + 1, endColumn: end.character + 1 });
    }
    return targets.filter((target, index) => targets.findIndex(other => other.file === target.file &&
      other.line === target.line && other.column === target.column && other.endColumn === target.endColumn) === index);
  };
}
