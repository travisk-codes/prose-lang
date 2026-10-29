import { camel, sourceLines } from "./transpile.js";

// Explain only the unchecked parts that the hover renderer exposes. Tracing is
// bounded and follows symbols, never matching a source spelling such as JSON.
export function createAnyExplainer(ts, checker, program, records) {
  const clean = name => name.replace(/^_prose_/, "");
  const canonical = file => {
    const normalized = file.replaceAll('\\', '/');
    return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
  };
  const byFile = new Map(), writes = new Map(), tokens = new Map();
  const any = type => Boolean(type?.flags & ts.TypeFlags.Any);
  const unwrap = node => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  for (const record of records) {
    byFile.set(canonical(record.name), record); byFile.set(canonical(record.declaration), record);
    const lines = sourceLines(record.source, { locations: true });
    tokens.set(record, lines);
    function scan(node) {
      const target = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.left : null;
      if (target && ts.isIdentifier(target)) {
        const symbol = checker.getSymbolAtLocation(target);
        if (symbol) { if (!writes.has(symbol)) writes.set(symbol, []); writes.get(symbol).push(node.right); }
      }
      ts.forEachChild(node, scan);
    }
    const source = program.getSourceFile(record.name);
    if (source) scan(source);
  }
  function sourceToken(node) {
    const record = byFile.get(canonical(node.getSourceFile().fileName));
    if (!record || canonical(node.getSourceFile().fileName) !== canonical(record.name)) return;
    const position = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    const original = record.lookup(position.line, position.character);
    if (!original) return;
    const line = tokens.get(record).find(line => line.tokens.some(token => token.source.line === original.line));
    const name = clean(node.text ?? "");
    const token = line?.tokens.find(token => token.type === "word" &&
      (token.value === name || camel(token.value) === name) &&
      (token.source.line > original.line || token.source.line === original.line && token.source.start >= original.column - 1));
    return token && { token, next: line.tokens[line.tokens.indexOf(token) + 1] };
  }
  const nameOf = node => sourceToken(node)?.token.value ?? clean(node?.text ?? "value");
  const generated = node => {
    const file = canonical(node.getSourceFile().fileName);
    const record = byFile.get(file);
    return record && canonical(record.name) === file;
  };
  const explicitAny = type => {
    if (!type) return false;
    if (type.kind === ts.SyntaxKind.AnyKeyword) return true;
    return Boolean(ts.forEachChild(type, explicitAny));
  };
  function originalExport(declaration) {
    const record = byFile.get(canonical(declaration.getSourceFile().fileName));
    if (!record || canonical(declaration.getSourceFile().fileName) !== canonical(record.declaration)) return;
    const source = program.getSourceFile(record.name), name = declaration.name?.text;
    for (const statement of source?.statements ?? []) {
      if (ts.isFunctionDeclaration(statement) && clean(statement.name?.text ?? "") === name) return statement;
      if (ts.isVariableStatement(statement)) for (const variable of statement.declarationList.declarations) {
        if (ts.isIdentifier(variable.name) && clean(variable.name.text) === name) return variable;
      }
    }
  }
  function returnExpressions(declaration) {
    if (!declaration.body) return [];
    if (!ts.isBlock(declaration.body)) return [declaration.body];
    const values = [];
    function visit(node) {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
      else ts.forEachChild(node, visit);
    }
    visit(declaration.body);
    return values;
  }
  function origin(node, symbol, seen = new Set(), depth = 0) {
    if (!node || depth > 12 || seen.has(node)) return [];
    seen = new Set(seen).add(node);
    node = unwrap(node);
    const trace = (child, value) => origin(child, value, seen, depth + 1);
    if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return trace(node.parent);
    if (generated(node) && ts.isArrayLiteralExpression(node) && !node.elements.length) return ['An empty-list placeholder has an unchecked element type.'];
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const value = unwrap(node.expression);
      if (generated(node)) {
        if (ts.isArrayLiteralExpression(value) && !value.elements.length) return ['An empty-list placeholder has an unchecked element type.'];
        if (ts.isObjectLiteralExpression(value) && !value.properties.length) return ['An empty-object placeholder is kept unchecked so properties can be added later.'];
        if (value.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(value) && value.text === 'undefined') return ['An unset or null placeholder is kept unchecked so it can receive a value later.'];
      }
      if (explicitAny(node.type)) return ['A type assertion explicitly introduces any.'];
      return trace(value);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = node.expression, type = checker.getTypeAtLocation(receiver);
      if (any(type)) return trace(receiver);
      if (type.flags & ts.TypeFlags.Unknown) return ['The receiver is unknown, so this access could not be typed. Check or narrow the value before accessing it.'];
      const member = ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node.name) : undefined;
      if (member) return trace(member.valueDeclaration ?? member.declarations?.[0], member);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      const isHelper = ts.isIdentifier(callee) && callee.text.startsWith('__prose_');
      if (isHelper) {
        if (['__prose_dot', '__prose_maybe_dot', '__prose_dot_key', '__prose_maybe_dot_key', '__prose_each', '__prose_open'].includes(callee.text)) {
          const receiver = node.arguments[0], type = checker.getTypeAtLocation(receiver);
          if (type.flags & ts.TypeFlags.Unknown) return ['The receiver is unknown, so this access cannot be verified. Check or narrow the value first.'];
          if (any(type)) return trace(receiver);
          const key = node.arguments[2] ?? node.arguments[1];
          if (key && ts.isStringLiteral(key)) {
            const field = checker.getPropertyOfType(type, key.text);
            if (field) return trace(field.valueDeclaration ?? field.declarations?.[0], field);
          }
          const index = node.arguments[1];
          if (index && any(checker.getTypeAtLocation(index))) return trace(index);
          return trace(receiver);
        }
        if (callee.text === '__prose_list') return [...new Set(node.arguments.flatMap(argument => any(checker.getTypeAtLocation(argument)) ? trace(argument) : []))].slice(0, 3);
        return [];
      }
      if (any(checker.getTypeAtLocation(callee))) return trace(callee);
      if (ts.isNewExpression(node)) return ['The constructor has no concrete inferred or declared type for this unchecked part.'];
      const declaration = checker.getResolvedSignature(node)?.getDeclaration();
      return trace(declaration);
    }
    if (ts.isIdentifier(node)) {
      symbol ??= checker.getSymbolAtLocation(node);
      if (!symbol) return [];
      if (symbol.flags & ts.SymbolFlags.Alias) {
        const imported = checker.getAliasedSymbol(symbol);
        const declaration = imported.valueDeclaration ?? imported.declarations?.[0];
        return declaration ? trace(declaration, imported) : [`Import ${JSON.stringify(nameOf(node))} has no usable checked declaration.`];
      }
      const assigned = writes.get(symbol);
      if (assigned?.length > 1) return ['This binding has several assignments; a unique source of any could not be established.'];
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (declaration && declaration !== node) {
        const result = trace(declaration, symbol);
        if (result.length) return result;
      }
      return assigned?.length === 1 ? trace(assigned[0]) : [];
    }
    if (ts.isParameter(node)) {
      const original = originalExport(node.parent);
      if (original && ts.isFunctionLike(original)) {
        const index = node.parent.parameters.indexOf(node);
        return trace(original.parameters[index]);
      }
      if (ts.isFunctionTypeNode(node.parent) || ts.isConstructorTypeNode(node.parent)) return ['The function type explicitly includes any for this parameter.'];
      const annotated = generated(node) ? sourceToken(node.name)?.next?.value === 'as' : Boolean(node.type);
      const declared = checker.getTypeAtLocation(node.name);
      if (annotated && declared.intrinsicName === 'error') return ['The parameter annotation could not be resolved. Check its type diagnostics.'];
      if (annotated) return explicitAny(node.type) || any(declared) ? [`The declared type of parameter ${JSON.stringify(nameOf(node.name))} includes any.`] : [];
      const contextual = ts.isArrowFunction(node.parent) || ts.isFunctionExpression(node.parent) ? checker.getContextualType(node.parent) : undefined;
      if (contextual?.getCallSignatures().length) return [`Callback parameter ${JSON.stringify(nameOf(node.name))} receives any from its contextual function type.`];
      return [`Parameter ${JSON.stringify(nameOf(node.name))} has no type annotation or inferred contextual type.`];
    }
    if (ts.isFunctionLike(node)) {
      const original = originalExport(node);
      if (original && !original.type) return [`Imported Prose function ${JSON.stringify(clean(node.name?.text ?? 'value'))} has no giving return annotation; its exported return contract uses any.`];
      if (node.type && explicitAny(node.type)) {
        const parentName = node.parent?.name ? nameOf(node.parent.name) : undefined;
        const name = node.name ? nameOf(node.name) : parentName ?? 'function';
        const library = /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/i.test(node.getSourceFile().fileName);
        return [`${library ? 'JavaScript library' : 'The declared'} function ${JSON.stringify(library && parentName ? parentName + '.' + name : name)} specifies any in its return type.`];
      }
      const values = returnExpressions(node).filter(value => any(checker.getTypeAtLocation(value)));
      return [...new Set(values.flatMap(value => trace(value)))].slice(0, 3);
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      const original = originalExport(node);
      if (original && !original.type) return [`Imported Prose value ${JSON.stringify(clean(node.name?.text ?? 'value'))} has no declared export type; its exported contract uses any.`];
      if (node.type && checker.getTypeFromTypeNode(node.type).intrinsicName === 'error') return ['The type annotation could not be resolved. Check its type diagnostics.'];
      if (node.type && (explicitAny(node.type) || any(checker.getTypeFromTypeNode(node.type)))) return ['The declared type explicitly includes or resolves to any.'];
      if (node.initializer) return trace(node.initializer);
      const assigned = symbol && writes.get(symbol);
      if (assigned?.length === 1) return trace(assigned[0]);
    }
    return [];
  }
  return (type, node, symbol) => {
    const leaves = [], visited = new Set();
    let steps = 0;
    function walk(type, location, label = '', depth = 0, compact = false, owner) {
      if (!type || depth > 5 || ++steps > 50 || leaves.length >= 3 || visited.has(type)) return;
      if (any(type)) {
        const reasons = origin(location, owner);
        leaves.push((label ? label + ': ' : '') + (reasons.join(' ') || 'The checker reports any here, but its source could not be established.'));
        return;
      }
      visited.add(type);
      if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return;
      const child = (type, at = location, part = label, small = compact, owner) => walk(type, at, part, depth + 1, small, owner);
      if (type.isUnion()) { type.types.forEach(part => child(part)); return; }
      if (type.aliasSymbol && !type.aliasSymbol.getName().startsWith('__Prose')) {
        type.aliasTypeArguments?.forEach(part => child(part)); return;
      }
      if (checker.isTupleType(type)) { checker.getTypeArguments(type).forEach((part, index) => child(part, location, `Position ${index + 1}`)); return; }
      if (checker.isArrayType(type) || type.isIntersection() && type.types.some(part => checker.isArrayType(part))) {
        child(checker.getIndexTypeOfType(type, ts.IndexKind.Number), location, 'List element'); return;
      }
      const signature = type.getCallSignatures()[0];
      if (signature) {
        for (const parameter of signature.getParameters()) {
          const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? location;
          child(checker.getTypeOfSymbolAtLocation(parameter, location), declaration, `Parameter ${JSON.stringify(nameOf(declaration.name ?? declaration))}`, true, parameter);
        }
        child(signature.getReturnType(), signature.getDeclaration() ?? location, 'Return type', true); return;
      }
      const name = type.getSymbol()?.getName();
      if (name && !['__type', '__object'].includes(name) && !name.startsWith('__Prose')) {
        if (type.objectFlags & ts.ObjectFlags.Reference) checker.getTypeArguments(type).forEach(part => child(part, location, 'Type argument'));
        return;
      }
      if (!compact) for (const field of checker.getPropertiesOfType(type).slice(0, 12)) child(checker.getTypeOfSymbolAtLocation(field, location), field.valueDeclaration ?? field.declarations?.[0] ?? location, `Property ${JSON.stringify(field.getName())}`, false, field);
    }
    walk(type, node, '', 0, false, symbol);
    return leaves.length ? ['Unchecked type: any allows operations and assignments without verifying that part of the value.', ...new Set(leaves)] : [];
  };
}
