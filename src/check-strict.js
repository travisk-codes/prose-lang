import { camel, sourceLines } from "./transpile.js";

const libraryDeclaration = declaration => /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/i.test(declaration.getSourceFile().fileName);

// Walk public contract types, including aliases and recursive structures. Native
// container arguments matter; implementation members of native types do not
// make a concrete Date or list unchecked just because the library has an any.
export function containsAny(ts, checker, type, location, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  if (type.flags & ts.TypeFlags.Any) return type.intrinsicName !== "error";
  if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike |
    ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Never | ts.TypeFlags.Void |
    ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.BigIntLike)) return false;
  seen.add(type);
  const has = child => containsAny(ts, checker, child, location, seen);
  if (type.isUnionOrIntersection()) return type.types.some(has);
  if (checker.isTupleType(type)) return checker.getTypeArguments(type).some(has);
  if (checker.isArrayType(type)) return has(checker.getIndexTypeOfType(type, ts.IndexKind.Number));
  if (type.aliasTypeArguments?.some(has)) return true;
  if (type.objectFlags & ts.ObjectFlags.Reference && checker.getTypeArguments(type).some(has)) return true;
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    if (signature.getParameters().some(parameter => has(checker.getTypeOfSymbolAtLocation(parameter, location))) || has(signature.getReturnType())) return true;
  }
  const declarations = type.getSymbol()?.getDeclarations();
  if (declarations?.length && declarations.every(libraryDeclaration)) return false;
  if (checker.getIndexInfosOfType(type).some(index => has(index.type))) return true;
  return checker.getPropertiesOfType(type).some(field => {
    const declarations = field.getDeclarations() ?? [];
    if (declarations.length && declarations.every(declaration => libraryDeclaration(declaration) ||
      declaration.name && ts.isPrivateIdentifier(declaration.name) || declaration.modifiers?.some(modifier =>
        [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(modifier.kind)))) return false;
    return has(checker.getTypeOfSymbolAtLocation(field, location));
  });
}

export function strictDiagnostics(ts, checker, program, records, information) {
  const diagnostics = [];
  const report = (record, at, code, message) => diagnostics.push({ source: "prose", code, severity: "error",
    file: record.file, line: at.line, column: at.column, message });
  for (const record of records) {
    for (const item of information.get(record) ?? []) {
      const node = item.node;
      if (!node || !ts.isIdentifier(node) || !ts.isParameter(node.parent) || node.parent.name !== node ||
        !node.parent.parent.body || ![ts.isFunctionDeclaration, ts.isArrowFunction, ts.isFunctionExpression].some(is => is(node.parent.parent))) continue;
      if (containsAny(ts, checker, checker.getTypeAtLocation(node), node)) {
        const name = record.source.split(/\r?\n/)[item.line - 1].slice(item.column - 1, item.endColumn - 1);
        report(record, item, "PROSE_UNCHECKED_PARAMETER", `Parameter '${name}' has any in its type. Add a checked as type or provide a typed callback context.`);
      }
    }
    const exports = new Map();
    for (const line of sourceLines(record.source, { locations: true })) {
      if (line.indent || line.tokens[0]?.value !== "export" || line.tokens[1]?.value === "type") continue;
      const token = line.tokens[line.tokens[1]?.value === "function" ? 2 : 1];
      if (token?.type === "word") exports.set(camel(token.value), { name: token.value, line: token.source.line, column: token.source.start + 1 });
    }
    const source = program.getSourceFile(record.declaration);
    for (const statement of source?.statements ?? []) {
      if (ts.isFunctionDeclaration(statement) && statement.name && exports.has(statement.name.text)) {
        const at = exports.get(statement.name.text), signature = checker.getSignatureFromDeclaration(statement);
        if (signature && containsAny(ts, checker, signature.getReturnType(), statement)) {
          report(record, at, "PROSE_UNCHECKED_RETURN", `Exported function '${at.name}' has any in its return contract. Use a checked giving return type.`);
        }
      } else if (ts.isVariableStatement(statement)) for (const variable of statement.declarationList.declarations) {
        if (!ts.isIdentifier(variable.name) || !exports.has(variable.name.text)) continue;
        const at = exports.get(variable.name.text);
        if (containsAny(ts, checker, checker.getTypeAtLocation(variable.name), variable)) {
          report(record, at, "PROSE_UNCHECKED_EXPORT", `Exported value '${at.name}' has any in its type. Give its unchecked parts concrete types.`);
        }
      }
    }
  }
  return diagnostics;
}
