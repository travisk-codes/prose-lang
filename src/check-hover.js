import { camel, sourceLines } from "./transpile.js";

const clean = name => name.replace(/^_prose_/, "");

// Render the common inferred types in Prose's vocabulary. Named project and
// library types keep their names; synthetic checker aliases stay private.
export function hoverType(ts, checker, type, location, seen = new Set(), compact = false) {
  if (!type || seen.has(type) || seen.size > 5) return "object";
  const next = new Set(seen).add(type);
  const render = child => hoverType(ts, checker, child, location, next, compact);
  const flags = ts.TypeFlags;
  if (type.flags & flags.Any) return "any";
  if (type.flags & flags.Unknown) return "unknown";
  if (type.flags & flags.String) return "text";
  if (type.flags & flags.Number) return "number";
  if (type.flags & flags.Boolean) return "boolean";
  if (type.flags & flags.Undefined) return "unset";
  if (type.flags & flags.Null) return "null";
  if (type.flags & flags.Void) return "nothing";
  if (type.flags & flags.Never) return "never";
  if (type.isUnion()) {
    const parts = [...new Set(type.types.map(render))];
    if (parts.includes("true") && parts.includes("false")) {
      parts.splice(parts.indexOf("true"), 1);
      parts.splice(parts.indexOf("false"), 1);
      parts.unshift("boolean");
    }
    if (parts.length === 2 && parts.includes("unset")) return `maybe ${parts.find(part => part !== "unset")}`;
    return parts.join(" or ");
  }
  if (type.flags & (flags.StringLiteral | flags.NumberLiteral | flags.BooleanLiteral | flags.TypeParameter)) {
    return checker.typeToString(type);
  }
  const alias = type.aliasSymbol?.getName();
  if (alias && !alias.startsWith("__Prose")) return alias + (type.aliasTypeArguments?.length
    ? ` of ${type.aliasTypeArguments.map(render).join(", ")}` : "");
  if (checker.isTupleType(type)) return `(${checker.getTypeArguments(type).map(render).join(", ")})`;
  const array = checker.isArrayType(type) || type.isIntersection() && type.types.some(child => checker.isArrayType(child));
  if (array) {
    const item = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    const text = render(item);
    return `list of ${item?.isUnion() ? `(${text})` : text}`;
  }
  const signatures = type.getCallSignatures();
  if (signatures.length) return hoverSignature(ts, checker, signatures[0], location, next);
  const name = type.getSymbol()?.getName();
  if (name && !["__type", "__object"].includes(name) && !name.startsWith("__Prose")) {
    const args = type.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type) : [];
    if (name === "Map" || name === "ReadonlyMap") return `map from ${render(args[0])} to ${render(args[1])}`;
    return args.length ? `${name} of ${args.map(render).join(", ")}` : name;
  }
  const fields = checker.getPropertiesOfType(type);
  if (compact) return "object";
  if (fields.length) return "object\n" + fields.slice(0, 12).map(field => {
    const value = checker.getTypeOfSymbolAtLocation(field, location);
    return `    ${clean(field.getName())} as ${render(value).replace(/\n/g, "\n    ")}`;
  }).join("\n") + (fields.length > 12 ? "\n    …" : "");
  return "object";
}

function hoverSignature(ts, checker, signature, location, seen, internalLine = false) {
  const parameters = signature.getParameters().filter(parameter => !internalLine || parameter.getName() !== "line").map(parameter => {
    const type = checker.getTypeOfSymbolAtLocation(parameter, location);
    return `${clean(parameter.getName())} as ${hoverType(ts, checker, type, location, seen, true)}`;
  });
  return `function${parameters.length ? ` takes ${parameters.join(", ")}` : ""} giving ${hoverType(ts, checker, signature.getReturnType(), location, seen, true)}`;
}

/** Collect source words and their checker symbols for hovers and navigation.
 * Source-map anchors select the logical line; original tokens locate names whose
 * generated spelling changed (snake_case members, parameters, and dot helpers).
 * Compiler objects stay internal and are stripped before returning editor data.
 */
export function collectSourceInfo(ts, checker, generated, record, { hover = true } = {}) {
  const lines = sourceLines(record.source, { locations: true });
  const owners = new Map();
  for (const line of lines) for (const token of line.tokens) owners.set(token.source.line, line);
  const found = new Map();
  const anchor = node => {
    const start = generated.getLineAndCharacterOfPosition(node.getStart(generated));
    return record.lookup(start.line, start.character);
  };
  function propertyPath(node) {
    if (ts.isParenthesizedExpression(node)) return propertyPath(node.expression);
    if (ts.isIdentifier(node)) return [clean(node.text)];
    if (ts.isPropertyAccessExpression(node)) {
      const parent = propertyPath(node.expression);
      return parent && [...parent, node.name.text];
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ["__prose_dot", "__prose_maybe_dot"].includes(node.expression.text) && ts.isStringLiteral(node.arguments[2])) {
      const parent = propertyPath(node.arguments[0]);
      return parent && [...parent, node.arguments[2].text];
    }
  }
  const positionType = (type, index, node) => {
    const property = checker.getPropertyOfType(type, String(index));
    return property ? checker.getTypeOfSymbolAtLocation(property, node) : checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  };
  function identifierType(node) {
    let target = node, index;
    if (ts.isArrayLiteralExpression(node.parent)) {
      target = node.parent;
      index = target.elements.indexOf(node);
    }
    const parent = target.parent;
    if (ts.isForOfStatement(parent) && parent.initializer === target) {
      const iterable = checker.getTypeAtLocation(parent.expression);
      const item = iterable.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(iterable)[0] : undefined;
      if (item) return index === undefined ? item : positionType(item, index, node);
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === target) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol?.valueDeclaration?.type) {
        const value = checker.getTypeAtLocation(parent.right);
        return index === undefined ? value : positionType(value, index, node);
      }
    }
    return checker.getTypeAtLocation(node);
  }
  function add(node, name, type, priority = 0, symbol, path, builtin = false) {
    const original = anchor(node);
    if (!original) return;
    const line = owners.get(original.line);
    const after = token => token.source.line > original.line || token.source.line === original.line && token.source.start >= original.column - 1;
    const matches = (token, value) => token?.type === "word" && (token.value === value || camel(token.value) === value);
    let token;
    if (path) {
      let index = line?.tokens.findIndex(token => after(token) && matches(token, path[0]));
      if (index >= 0) {
        token = line.tokens[index];
        for (const member of path.slice(1)) {
          while (["(", ")"].includes(line.tokens[index + 1]?.value)) index++;
          if (![".", ":"].includes(line.tokens[index + 1]?.value) || !matches(line.tokens[index + 2], member)) { token = undefined; break; }
          index += 2;
          token = line.tokens[index];
        }
      }
    } else token = line?.tokens.find(token => after(token) && matches(token, name));
    if (!token) return;
    const key = `${token.source.line}:${token.source.start}`;
    if (found.has(key) && found.get(key).priority >= priority) return;
    let code, documentation;
    if (hover) {
      const rendered = builtin ? hoverSignature(ts, checker, type.getCallSignatures()[0], node, new Set(), true) : hoverType(ts, checker, type, node);
      code = rendered.startsWith("function")
        ? rendered.replace(/^function/, `function ${token.value}`) : `${token.value} as ${rendered}`;
      if (code.length > 2400) code = code.slice(0, 2399) + "…";
      const documented = symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      documentation = documented ? ts.displayPartsToString(documented.getDocumentationComment(checker)) : "";
    }
    found.set(key, { file: record.file, line: token.source.line, column: token.source.start + 1,
      endColumn: token.source.start + token.source.raw.length + 1, code, documentation, priority, node, symbol });
  }
  function visit(node) {
    // The console call belongs to `print`, not to any word named console or log
    // in its argument. User-written console.log calls keep their ordinary path.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(generated) === "console" && node.expression.name.text === "log") {
      const original = anchor(node);
      const source = original && owners.get(original.line)?.tokens.find(token => token.source.line === original.line && token.source.start === original.column - 1);
      if (source?.value === "print") { node.arguments.forEach(visit); return; }
    }
    if (ts.isIdentifier(node) && !node.text.startsWith("__prose_") && !node.text.startsWith("__Prose") &&
        !/^_limit\d+$/.test(node.text) && node.text !== "__error") {
      // Prose function types list parameter types without names. TypeScript's
      // generated arg1/arg2 names must not consume a real source word.
      if (ts.isParameter(node.parent) && node.parent.name === node &&
          (ts.isFunctionTypeNode(node.parent.parent) || ts.isConstructorTypeNode(node.parent.parent))) return;
      const property = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      add(node, clean(node.text), identifierType(node), 0, checker.getSymbolAtLocation(node), property ? propertyPath(node.parent) : undefined);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ["__prose_dot", "__prose_maybe_dot"].includes(node.expression.text) && ts.isStringLiteral(node.arguments[2])) {
      const receiver = checker.getTypeAtLocation(node.arguments[0]);
      const index = node.arguments[1];
      const sequence = receiver.flags & ts.TypeFlags.StringLike || checker.isArrayType(receiver) ||
        receiver.isIntersection() && receiver.types.some(type => checker.isArrayType(type));
      const symbol = sequence && ts.isIdentifier(index) && checker.getTypeAtLocation(index).flags & ts.TypeFlags.NumberLike
        ? checker.getSymbolAtLocation(index) : undefined;
      add(node, node.arguments[2].text, checker.getTypeAtLocation(node), 1, symbol, propertyPath(node));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ["__prose_length", "__prose_char_to_number", "__prose_number_to_char"].includes(node.expression.text)) {
      add(node, node.expression.text.slice("__prose_".length), checker.getTypeAtLocation(node.expression), 1, undefined, undefined, true);
    }
    ts.forEachChild(node, visit);
  }
  visit(generated);
  return [...found.values()].sort((a, b) => a.line - b.line || a.column - b.column);
}
