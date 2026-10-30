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
export function collectSourceInfo(ts, checker, generated, record, { hover = true, explainAny, includeType = false } = {}) {
  const lines = sourceLines(record.source, { locations: true });
  const owners = new Map();
  for (const line of lines) for (const token of line.tokens) owners.set(token.source.line, line);
  const found = new Map(), computedNotes = new Map();
  const positionNote = "Prose positions start at 1. In text, each Unicode code point occupies one position; an emoji such as 😀 occupies one. JavaScript methods use their own zero-based positions.";
  function receiverKind(type) {
    type = checker.getNonNullableType(type);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return "unknown";
    if (type.flags & ts.TypeFlags.StringLike) return "text";
    if (checker.isArrayType(type) || checker.isTupleType(type)) return "list";
    if (type.isIntersection()) {
      const kinds = type.types.map(receiverKind);
      return kinds.includes("text") ? "text" : kinds.includes("list") ? "list" : "object";
    }
    if (type.isUnion()) {
      const kinds = type.types.map(receiverKind);
      return kinds.every(kind => kind === kinds[0]) ? kinds[0]
        : kinds.every(kind => ["text", "list", "sequence"].includes(kind)) ? "sequence" : "unknown";
    }
    return "object";
  }
  function propertyNotes(receiver, token, name, selector, explicit = false) {
    const notes = [], kind = receiverKind(receiver);
    const spelling = token.value !== name && `For property access, ${JSON.stringify(token.value)} is spelled ${JSON.stringify(name)} in JavaScript. Use .(${JSON.stringify(token.value)}) for the literal key ${JSON.stringify(token.value)}.`;
    const sequence = ["text", "list", "sequence"].includes(kind);
    const indexType = selector && checker.getTypeAtLocation(selector);
    const numeric = indexType && Boolean(indexType.flags & ts.TypeFlags.NumberLike);
    if (selector && !explicit) {
      if (sequence && numeric) return [positionNote, `Here ${token.value} supplies the position. Use :${token.value} to force property access.`];
      if (kind !== "object" && (!indexType || !(indexType.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike)))) {
        return [`Dot access uses a numeric ${token.value} as a one-based position on text or lists; otherwise it reads the JavaScript property ${JSON.stringify(name)}. Use :${token.value} to force property access.`, ...(spelling ? [spelling] : [])];
      }
    }
    if (explicit) notes.push(`Colon access reads the JavaScript property ${JSON.stringify(name)}. A variable with the same name cannot turn it into a Prose position.`);
    if (spelling) notes.push(spelling);
    const symbol = checker.getPropertyOfType(checker.getNonNullableType(receiver), name);
    const native = symbol?.getDeclarations()?.length && symbol.getDeclarations().every(declaration => {
      const file = declaration.getSourceFile();
      return file.isDeclarationFile && /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/i.test(file.fileName);
    });
    if (!native) return notes;
    if (kind === "text" && name === "length") notes.push('JavaScript text.length counts UTF-16 code units: "😀" has length 2. Prose length counts Unicode code points, so length "😀" is 1.');
    if (sequence) {
      const methods = {
        slice: "JavaScript slice uses zero-based start and end positions; the end is excluded. slice with 0, 2 selects the first two items.",
        at: "JavaScript at uses zero-based positions: 0 is the first item, and negative positions count from the end.",
        indexOf: "JavaScript indexOf returns a zero-based position, or -1 when the value is missing.",
        lastIndexOf: "JavaScript lastIndexOf returns a zero-based position, or -1 when the value is missing.",
        findIndex: "JavaScript findIndex returns a zero-based position, or -1 when no item matches.",
        findLastIndex: "JavaScript findLastIndex returns a zero-based position, or -1 when no item matches.",
        substring: "JavaScript substring uses zero-based start and end positions; the end is excluded.",
        charAt: "JavaScript charAt uses a zero-based position.",
        charCodeAt: "JavaScript charCodeAt uses a zero-based position.",
        codePointAt: "JavaScript codePointAt uses a zero-based UTF-16 position."
      };
      if (methods[name]) notes.push(methods[name] + (kind === "text"
        ? " Text positions in JavaScript count UTF-16 code units; Prose text positions start at 1 and count Unicode code points."
        : " Prose positions start at 1."));
    }
    return notes;
  }
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
    let code, documentation, notes;
    if (hover) {
      const rendered = builtin ? hoverSignature(ts, checker, type.getCallSignatures()[0], node, new Set(), true) : hoverType(ts, checker, type, node);
      code = rendered.startsWith("function")
        ? rendered.replace(/^function/, `function ${token.value}`) : `${token.value} as ${rendered}`;
      if (code.length > 2400) code = code.slice(0, 2399) + "…";
      const documented = symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      documentation = documented ? ts.displayPartsToString(documented.getDocumentationComment(checker)) : "";
      if (builtin && token.value === "length") notes = ['Prose length counts list elements or Unicode code points in text. length "😀" is 1; JavaScript "😀".length is 2 because it counts UTF-16 code units.'];
      const parent = node.parent;
      if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        const operator = line.tokens[line.tokens.indexOf(token) - 1]?.value;
        notes = propertyNotes(checker.getTypeAtLocation(parent.expression), token, node.text, undefined, operator === ":");
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["__prose_dot", "__prose_maybe_dot"].includes(node.expression.text)) {
        notes = propertyNotes(checker.getTypeAtLocation(node.arguments[0]), token, node.arguments[2].text, node.arguments[1]);
      }
      const unchecked = explainAny?.(type, node, symbol) ?? [];
      if (unchecked.length) notes = [...(notes ?? []), ...unchecked];
    }
    found.set(key, { file: record.file, line: token.source.line, column: token.source.start + 1,
      endColumn: token.source.start + token.source.raw.length + 1, code, documentation, ...(notes?.length ? { notes } : {}),
      ...(includeType ? { valueType: type } : {}), priority, node, symbol });
  }
  function visit(node) {
    if (hover) {
      const keyed = ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ["__prose_dot_key", "__prose_maybe_dot_key"].includes(node.expression.text);
      const receiver = keyed ? node.arguments[0] : ts.isElementAccessExpression(node) ? node.expression : null;
      const key = keyed ? node.arguments[1] : ts.isElementAccessExpression(node) ? node.argumentExpression : null;
      if (receiver && key && (ts.isStringLiteral(key) || ts.isNumericLiteral(key))) {
        const original = anchor(key), line = original && owners.get(original.line);
        const token = line?.tokens.find(token => token.source.line === original.line && token.source.start === original.column - 1 &&
          (token.type === "string" ? token.value === key.text : token.type === "number" && token.value === Number(key.text)));
        if (token) {
          const type = checker.getTypeAtLocation(receiver);
          const kind = receiverKind(type);
          computedNotes.set(`${token.source.line}:${token.source.start}`, token.type === "string" ? propertyNotes(type, token, key.text)
            : [kind === "object" ? "On this object, the computed number is a JavaScript property key; there is no one-based position adjustment."
              : ["text", "list", "sequence"].includes(kind) ? positionNote
              : "A computed numeric dot selects a one-based position on text or lists, and a JavaScript property key on other receivers."]);
        }
      }
    }
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
  if (hover) for (const line of lines) for (let index = 0; index < line.tokens.length; index++) {
    const token = line.tokens[index], previous = line.tokens[index - 1];
    const position = token.type === "number" && previous?.value === ".";
    const literalKey = ["string", "number"].includes(token.type) && previous?.value === "(" &&
      [".", ":"].includes(line.tokens[index - 2]?.value) && line.tokens[index + 1]?.value === ")";
    if (!position && !literalKey) continue;
    const key = `${token.source.line}:${token.source.start}`;
    if (found.has(key)) continue;
    const notes = position ? [positionNote] : token.type === "number" && line.tokens[index - 2]?.value === "."
      ? computedNotes.get(key) ?? ["A computed numeric dot selects a one-based position on text or lists, and a JavaScript property key on other receivers."]
      : ["This computed key is used literally as a JavaScript property, without snake_case conversion or a one-based position adjustment.", ...(token.type === "string" ? computedNotes.get(key) ?? [] : [])];
    found.set(key, { file: record.file, line: token.source.line, column: token.source.start + 1,
      endColumn: token.source.start + token.source.raw.length + 1, code: token.source.raw, documentation: "",
      notes, priority: 0 });
  }
  return [...found.values()].sort((a, b) => a.line - b.line || a.column - b.column);
}
