// The compiler: executable JavaScript, type-checking output, declarations, and source maps.
import { runtimeHelpers, runtimeSource } from "./runtime.js";
import { checkPrelude } from "./check.js";
import { inlineSourceMap, sourceMapBuilder } from "./source-map.js";
import { fail } from "./errors.js";
import { camel, variable } from "./names.js";
import { typeTests } from "./syntax.js";
import { parse } from "./parser.js";
import { awaits, topLevelAwait } from "./awaits.js";
import { createScope, resolve, dotKey, dotName, rebindable } from "./scope.js";
import {
  declarationsFor, declaredTypes, docComment, generic, genericParametersFor,
  laterProperties, parameterList, parameterType, returnType, singleAssignments,
  typeDeclarationLines, typeText
} from "./types.js";

const pad = depth => "  ".repeat(depth);

export function compile(source, options = {}) {
  if (![undefined, false, true, "inline"].includes(options.sourceMap)) throw new TypeError('sourceMap must be true, false, or "inline".');
  const program = parse(source, options);
  const containsMarkup = node => node && typeof node === 'object' &&
    (node.type === 'element' || Object.values(node).some(containsMarkup));
  const hasMarkup = Boolean(containsMarkup(program));
  const mapper = options.sourceMap ? sourceMapBuilder(source, options.filename ?? "program.prose") : null;
  const mapped = (node, code) => mapper && node?.location
    ? mapper.mark(node.location, code, ["name", "call", "function"].includes(node.type) ? (node.value ?? node.name) : undefined) : code;
  const unmapped = code => mapper ? mapper.mark(null, code) : code;
  // V8 can place a return breakpoint just after its semicolon. Keep that line
  // ending mapped to the final statement, while the generated brace is unmapped.
  const closeBody = (nodes, depth, suffix = "}") => mapped(nodes.at(-1), "\n") + unmapped(pad(depth) + suffix);
  const imports = program.filter(node => node.type === "use" && !node.typeOnly);
  const programScope = createScope([], program, null);
  for (const node of imports) {
    for (const name of node.names) {
      if (programScope.imports.has(name)) fail(node.line, `'${name}' is already imported.`);
      if (programScope.locals.has(name)) fail(programScope.locals.get(name), `'${name}' is imported, so it can't be assigned at the top level.`);
      programScope.imports.add(name);
      programScope.names.add(name);
    }
  }
  const exports = new Map();
  for (const node of program.filter(node => node.exported && node.type !== "typeDeclaration")) {
    if (exports.has(camel(node.name))) fail(node.line, `'${node.name}' is already exported.`);
    exports.set(camel(node.name), variable(node.name));
  }
  // Output that carries a value import, export, runtime import, or React import is a module.
  // Type-only imports and exports add no such syntax, so they cannot make an await legal.
  const moduleSyntax = hasMarkup || Boolean(options.runtime) || imports.length > 0 || exports.size > 0;
  const topLevelWait = topLevelAwait(program);
  if (topLevelWait && !moduleSyntax) {
    fail(topLevelWait.line, "Top-level 'wait for' needs a module: add a value use or export, or move the wait into a function.");
  }
  let loopId = 0;
  // The checking output is TypeScript written to be type-checked, never run: plain property
  // access, calls, and positions instead of runtime helpers, so the checker sees every type.
  const check = Boolean(options.check);
  const scopes = new WeakMap();
  function innerScope(node, parent) {
    if (!check) return createScope(node.params, node.body ?? [], parent);
    if (!scopes.has(node)) {
      const inner = createScope(node.params, node.body ?? [], parent);
      const inherited = parent.typeVariables ?? new Set();
      inner.typeParams = genericParametersFor(node, inherited);
      inner.ownTypeVariables = new Set(inner.typeParams.map(parameter => parameter.name));
      inner.typeVariables = new Set([...inherited, ...inner.ownTypeVariables]);
      scopes.set(node, inner);
    }
    return scopes.get(node);
  }
  const later = check ? laterProperties(program, programScope, innerScope) : new Map();

  function expression(node, scope, depth, filterPredicate = false) {
    if (check && node.type === "literal" && node.value === options.signatureProbe) {
      return mapped(node, `(${JSON.stringify(node.value)} as never)`);
    }
    if (check && node.signaturePadding) return '(undefined as never)';
    return mapped(node, (check && checkValue(node, scope, depth, filterPredicate)) || expressionValue(node, scope, depth));
  }

  function visible(name, scope) {
    for (let current = scope; current; current = current.parent) if (current.names.has(name)) return true;
    return false;
  }

  // A single comparison proves exactly which nullish value a parameter's field
  // cannot contain. Do not infer from truthiness, compound tests, or dot positions.
  function checkedPredicate(node, scope, filterPredicate) {
    // Use the receiver's contextual element type. A standalone or explicitly
    // untyped callback could otherwise turn a typed collection into any[].
    if (!filterPredicate || node.returns || !node.params.length || node.types?.[0]) return "";
    const value = node.value ?? (node.body?.length === 1 && node.body[0].type === "return" ? node.body[0].value : null);
    if (value?.type !== "binary" || value.op !== "!=") return "";
    const excluded = child => child.type === "unset" ? "undefined" : child.type === "literal" && child.value === null ? "null" : null;
    const type = excluded(value.right) ?? excluded(value.left);
    const property = excluded(value.right) ? value.left : value.right;
    if (!type || property?.type !== "property" || property.key || property.maybe ||
      property.object.type !== "name" || property.object.value !== node.params[0]) return "";
    const parameter = variable(node.params[0]);
    const helper = property.contextual && visible(property.name, scope) ? "__ProseWithoutObjectField" : "__ProseWithoutField";
    return `${parameter} is ${helper}<typeof ${parameter}, ${JSON.stringify(camel(property.name))}, ${type}>`;
  }

  // Inferred lists retain their position types without fixing their length.
  // Hoisted bindings also preserve scalar literals in each assignment's flow type.
  function checkedAssignment(node, scope, depth, preserveLiterals = true) {
    if (node.type === "array" && node.elements.length) {
      const item = child => child.type === "spread" ? spread(child, scope, depth)
        : child.type === "array" ? checkedAssignment(child, scope, depth, false) : expression(child, scope, depth);
      return mapped(node, `__prose_list(${node.elements.map(item).join(", ")})`);
    }
    if (preserveLiterals && node.type === "literal" && node.value !== null) return mapped(node, `(${expressionValue(node, scope, depth)} as const)`);
    if (node.type === "conditional") return mapped(node,
      `(${expression(node.condition, scope, depth)} ? ${checkedAssignment(node.then, scope, depth, preserveLiterals)} : ${checkedAssignment(node.otherwise, scope, depth, preserveLiterals)})`);
    return expression(node, scope, depth);
  }

  // An expression as the checking output writes it, or undefined where both outputs agree.
  function checkValue(node, scope, depth, filterPredicate) {
    const emit = child => expression(child, scope, depth);
    const element = child => child.type === "spread" ? spread(child, scope, depth) : emit(child);
    const args = (nodes, filter = false) => nodes.map((child, index) => filter && index === 0 && child.type === "lambda"
      ? expression(child, scope, depth, true) : element(child)).join(", ");
    if (node.type === 'element') {
      const tag = value => value.type === 'literal' ? value.value : value.type === 'name' ? mapped(value, resolve(value, scope)) : `${tag(value.object)}.${mapped(value, camel(value.name))}`;
      const name = node.tag ? tag(node.tag) : '';
      const attributes = node.attributes.map(attribute => mapped(attribute, attribute.spread
        ? ` {...${emit(attribute.value)}}` : ` ${attribute.name}={${emit(attribute.value)}}`)).join('');
      const closing = node.closingTag ? tag(node.closingTag) : name;
      return `<${name}${attributes}>${node.children.map(child => `{${emit(child)}}`).join('')}</${closing}>`;
    }
    if (node.type === "object") return checkObject(node, scope, depth);
    // An empty list can be added to later, so it isn't a list of nothing.
    if (node.type === "array" && !node.elements.length) return "([] as any[])";
    if (node.type === "property") return checkAccess(node, scope, depth, node.maybe);
    if (node.type === "index") {
      const position = node.index.type === "literal" ? String(node.index.value - 1) : `${emit(node.index)} - 1`;
      return `${emit(node.object)}${node.maybe ? "?." : ""}[${position}]`;
    }
    if (node.type === "invoke") {
      const callee = node.callee.type === "property" ? checkAccess(node.callee, scope, depth, node.maybe) : emit(node.callee);
      const filter = node.callee.type === "property" && !node.callee.key && camel(node.callee.name) === "filter";
      return `${callee}${node.maybe ? "?." : ""}(${args(node.args, filter)})`;
    }
    if (node.type === "new") return `new (${emit(node.callee)})(${args(node.args)})`;
    if (node.type === "lambda") {
      const inner = innerScope(node, scope);
      // Untyped parameters take their types from where the function is passed.
      const params = node.params.map((name, index) => {
        const parameter = mapped({ location: node.params.locations?.[index] }, variable(name));
        return node.types?.[index] ? `${parameter}: ${mapped(node.types[index], parameterType(node.types[index]))}` : parameter;
      }).join(", ");
      const predicate = checkedPredicate(node, inner, filterPredicate);
      const returns = node.returns ? `: ${mapped(node.returns, returnType(node))}` : predicate ? `: ${unmapped(predicate)}` : "";
      const async = awaits(node.body ?? node.value) ? "async " : "";
      let variables = generic(inner.typeParams, checkedType, mapped);
      if (hasMarkup) variables = variables.replace(/^<([^,>]+)>$/, '<$1,>');
      if (node.body) return `(${async}${variables}(${params})${returns} => {\n${emitScope(node.body, inner, depth + 1)}\n${pad(depth)}})`;
      return `(${async}${variables}(${params})${returns} => ${expression(node.value, inner, depth)})`;
    }
    return undefined;
  }

  // An object in the checking output. Unset and null properties can be filled in later, and
  // `extra` names the properties the program adds after making it, so each exists up front.
  function checkObject(node, scope, depth, extra = new Set()) {
    const value = child => child.type === "unset" ? "(undefined as any)"
      : child.type === "literal" && child.value === null ? "(null as any)" : expression(child, scope, depth);
    const own = new Set(node.properties.filter(property => !property.spread).map(property => property.name));
    const entries = node.properties.map(property => property.spread
      ? `...${expression(property.value, scope, depth)}` : `${mapped(property, camel(property.name))}: ${value(property.value)}`);
    for (const name of extra) if (!own.has(name)) entries.push(`${camel(name)}: (undefined as any)`);
    // An empty object, such as a fallback after otherwise, can hold anything.
    return entries.length ? `({${entries.join(", ")}})` : "({} as any)";
  }

  // A property, or a dot that may be a position, read in the checking output.
  function checkAccess(node, scope, depth, maybe) {
    const object = expression(node.object, scope, depth);
    const helper = maybe ? "__prose_maybe_" : "__prose_";
    if (node.contextual && node.key) return `${helper}dot_key(${object}, ${expression(node.key, scope, depth)})`;
    if (node.contextual && visible(node.name, scope)) {
      return `${helper}dot(${object}, ${variable(node.name)}, ${JSON.stringify(camel(node.name))})`;
    }
    if (node.key) return `${object}${maybe ? "?." : ""}[${expression(node.key, scope, depth)}]`;
    return `${object}${maybe ? "?." : "."}${camel(node.name)}`;
  }

  // An assignment to a property or position in the checking output.
  function checkWrite(target, value, scope, depth) {
    const object = expression(target.object, scope, depth);
    if (target.type === "index") return `__prose_set_at(${object}, ${expression(target.index, scope, depth)}, ${value})`;
    if (target.contextual && target.key) return `__prose_dot_key_set(${object}, ${expression(target.key, scope, depth)}, ${value})`;
    if (target.contextual && visible(target.name, scope)) {
      return `__prose_dot_set(${object}, ${variable(target.name)}, ${JSON.stringify(camel(target.name))}, ${value})`;
    }
    if (target.key) return `${object}[${expression(target.key, scope, depth)}] = ${value}`;
    return `${object}.${camel(target.name)} = ${value}`;
  }

  function expressionValue(node, scope, depth) {
    const emit = child => expression(child, scope, depth);
    if (node.type === 'element') {
      const tag = node.tag ? emit(node.tag) : '__prose_fragment';
      const attributes = node.attributes.length ? `{${node.attributes.map(attribute => mapped(attribute, attribute.spread
        ? `...${emit(attribute.value)}` : `[${JSON.stringify(attribute.name)}]: ${emit(attribute.value)}`)).join(', ')}}` : 'null';
      return `__prose_element(${[tag, attributes, ...node.children.map(emit)].join(', ')})`;
    }
    // Lists and arguments may spread a collection into them with `each of`.
    const element = child => child.type === "spread" ? spread(child, scope, depth) : emit(child);
    const list = nodes => `[${nodes.map(element).join(", ")}]`;
    if (node.type === "literal") return JSON.stringify(node.value);
    if (node.type === "unset") return "undefined";
    if (node.type === "name") return resolve(node, scope);
    if (node.type === "pattern") return node.literal;
    if (node.type === "spread") fail(node.line, "'each of' can only spread into a list, a call's arguments, or print.");
    if (node.type === "array") return list(node.elements);
    if (node.type === "object") {
      return `({${node.properties.map(property => property.spread
        ? `...${emit(property.value)}`
        : `[${JSON.stringify(camel(property.name))}]: ${emit(property.value)}`).join(", ")}})`;
    }
    if (node.type === "property") {
      if (node.contextual) {
        const key = dotKey(node, scope, emit);
        if (node.maybe) return `__prose_maybe_dot(${emit(node.object)}, () => ${key}, ${node.line}, ${dotName(node)})`;
        return `__prose_dot(${emit(node.object)}, ${key}, ${node.line}, ${dotName(node)})`;
      }
      const name = node.key ? emit(node.key) : JSON.stringify(camel(node.name));
      if (node.maybe) return `__prose_maybe_property(${emit(node.object)}, ${name})`;
      return `__prose_property(${emit(node.object)}, ${name}, ${node.line})`;
    }
    if (node.type === "typeTest") {
      const value = `(${emit(node.value)})`;
      const test = typeof node.kind === "string" ? typeTests[node.kind](value) : `${value} instanceof ${emit(node.kind)}`;
      return node.negated ? `(!(${test}))` : `(${test})`;
    }
    if (node.type === "await") return `(await ${emit(node.value)})`;
    if (node.type === "index") {
      if (node.maybe) return `__prose_maybe_get(${emit(node.object)}, () => ${emit(node.index)}, ${node.line})`;
      return `__prose_get(${emit(node.object)}, ${emit(node.index)}, ${node.line})`;
    }
    if (node.type === "call") {
      if (node.builtin) return `__prose_${node.name}(${[...node.args.map(emit), node.line].join(", ")})`;
      return `${variable(node.name)}(${node.args.map(emit).join(", ")})`;
    }
    if (node.type === "invoke") {
      // Under maybe, arguments are evaluated only when there is something to call.
      const args = node.maybe ? `() => ${list(node.args)}` : list(node.args);
      const helper = node.maybe ? "__prose_maybe_" : "__prose_";
      if (node.callee.type === "property") {
        if (node.callee.contextual) {
          const key = dotKey(node.callee, scope, emit);
          return `${helper}dot_method(${emit(node.callee.object)}, ${node.maybe ? `() => ${key}` : key}, ${args}, ${node.line}, ${dotName(node.callee)})`;
        }
        return `${helper}method(${emit(node.callee.object)}, ${node.callee.key ? emit(node.callee.key) : JSON.stringify(camel(node.callee.name))}, ${args}, ${node.line})`;
      }
      return `${helper}call(${emit(node.callee)}, ${args}, ${node.line})`;
    }
    if (node.type === "new") return `__prose_new(${emit(node.callee)}, ${list(node.args)}, ${node.line})`;
    if (node.type === "conditional") return `(${emit(node.condition)} ? ${emit(node.then)} : ${emit(node.otherwise)})`;
    if (node.type === "lambda") {
      const inner = createScope(node.params, node.body ?? [], scope);
      const params = node.params.map(variable).join(", ");
      const async = awaits(node.body ?? node.value) ? "async " : "";
      if (node.body) return `(${async}(${params}) => {\n${emitScope(node.body, inner, depth + 1)}${closeBody(node.body, depth, "})")}`;
      return `(${async}(${params}) => ${expression(node.value, inner, depth)})`;
    }
    if (node.type === "unary") {
      return `(${node.op === "not" ? "!" : "-"}${emit(node.operand)})`;
    }
    if (node.op === "mod") return `__prose_mod(${emit(node.left)}, ${emit(node.right)}, ${node.line})`;
    const op = { "=": "===", "!=": "!==", and: "&&", or: "||", otherwise: "??", xor: "^" }[node.op] ?? node.op;
    return `(${emit(node.left)} ${op} ${emit(node.right)})`;
  }

  function spread(node, scope, depth) {
    return `...__prose_each(${expression(node.value, scope, depth)}, ${node.line})`;
  }

  function reference(target, scope, depth, readOnlyParent = false) {
    if (target.type === "name") {
      if (readOnlyParent) {
        const name = resolve(target, scope);
        let binding = scope;
        while (binding && !binding.names.has(target.value)) binding = binding.parent;
        if (!binding || binding.imports.has(target.value)) {
          const reason = binding ? "is imported" : "belongs to JavaScript";
          const message = JSON.stringify(`Line ${target.line}: '${target.value}' ${reason}, so its positions can't be assigned.`);
          return `({ get: () => ${name}, set: () => { throw new TypeError(${message}); } })`;
        }
        return `({ get: () => ${name}, set: __value => ${name} = __value })`;
      }
      const name = rebindable(target, scope);
      return `({get: () => ${name}, set: __value => { ${name} = __value; }})`;
    }
    if (target.type === "property") {
      if (target.contextual) {
        return `__prose_dot_ref(${reference(target.object, scope, depth, true)}, () => ${dotKey(target, scope, child => expression(child, scope, depth))}, ${target.line}, ${dotName(target)})`;
      }
      const name = target.key ? expression(target.key, scope, depth) : JSON.stringify(camel(target.name));
      return `__prose_property_ref(${expression(target.object, scope, depth)}, ${name}, ${target.line})`;
    }
    return `__prose_index_ref(${reference(target.object, scope, depth)}, () => ${expression(target.index, scope, depth)}, ${target.line})`;
  }

  function emitBlock(nodes, scope, depth) {
    const indent = pad(depth);
    const emit = node => expression(node, scope, depth);
    const statement = node => {
      if (node.type === "function") {
        const inner = innerScope(node, scope);
        const signature = check
          ? `${generic(inner.typeParams, checkedType, mapped)}(${parameterList(node, (name, index) => mapped({ location: node.params.locations?.[index] }, variable(name)), undefined, checkedParameter)})${node.returns ? `: ${mapped(node.returns, returnType(node))}` : ""}`
          : `(${node.params.map(variable).join(", ")})`;
        const documentation = check && node.doc ? docComment(node.doc, indent).join("\n") + "\n" : "";
        return `${documentation}${indent}${awaits(node.body) ? "async " : ""}function ${variable(node.name)}${signature} {\n${emitScope(node.body, inner, depth + 1)}${closeBody(node.body, depth)}`;
      }
      if (node.type === "assign" && check) {
        const extra = !scope.types.has(node.name) && later.get(scope)?.get(node.name);
        // A list made empty here takes its type from what's added to it later.
        let value = node.value.type === "unset" && !scope.types.has(node.name) ? "(undefined as any)"
          : node.value.type === "array" && !node.value.elements.length ? "[]"
          : node.value.type === "object" ? mapped(node.value, checkObject(node.value, scope, depth, extra || undefined))
          : !scope.types.has(node.name) ? checkedAssignment(node.value, scope, depth, !scope.constants.has(node.name)) : emit(node.value);
        if (extra?.size && node.value.type !== "object") {
          value = `__prose_open(${value}, ${[...extra].map(name => JSON.stringify(camel(name))).join(", ")})`;
        }
        return `${indent}${scope.constants.has(node.name) ? `const ${typed(node.name, scope)}` : variable(node.name)} = ${value};`;
      }
      if (node.type === "assign") return `${indent}${variable(node.name)} = ${emit(node.value)};`;
      if (node.type === "assignTarget" && check) return `${indent}${checkWrite(node.target, emit(node.value), scope, depth)};`;
      // Rebuilding a string assigns its binding; mutating an object property does not.
      if (node.type === "assignTarget") return `${indent}${reference(node.target, scope, depth)}.set(${emit(node.value)});`;
      if (node.type === "print") {
        return `${indent}console.log(${node.value.type === "spread" ? spread(node.value, scope, depth) : emit(node.value)});`;
      }
      if (node.type === "return") return `${indent}return${node.value ? " " + emit(node.value) : ""};`;
      if (node.type === "expression") return `${indent}(${emit(node.value)});`;
      if (node.type === "destructure") {
        // Destructuring a pair directly keeps the type of each of its positions.
        const value = check ? emit(node.value) : `__prose_each(${emit(node.value)}, ${node.line})`;
        return `${indent}([${node.names.map(variable).join(", ")}] = ${value});`;
      }
      if (node.type === "skip") return `${indent}continue;`;
      if (node.type === "stop") return `${indent}break;`;
      if (node.type === "fail") return `${indent}throw __prose_error(${emit(node.value)});`;
      if (node.type === "try") {
        const caught = node.name ? mapped(node.handler, `${indent}  ${variable(node.name)} = __error;\n`) : "";
        // Anything can be thrown; the checking output trusts the handler to know what it caught.
        const error = check ? "__error: any" : "__error";
        return `${indent}try {\n${emitBlock(node.body, scope, depth + 1)}\n${mapped(node.handler, `${indent}} catch (${error}) {`)}\n${caught}${emitBlock(node.handler, scope, depth + 1)}\n${indent}}`;
      }
      if (node.type === "if") {
        const branches = node.branches.map((branch, index) =>
          `${mapped(branch, `${indent}${index ? "else if" : "if"} (${emit(branch.condition)}) {`)}\n${emitBlock(branch.body, scope, depth + 1)}\n${indent}}`
        ).join(" ");
        return branches + (node.otherwise.length
          ? `${mapped(node.otherwise, " else {")}\n${emitBlock(node.otherwise, scope, depth + 1)}\n${indent}}` : "");
      }
      if (node.type === "while") {
        return `${indent}while (${emit(node.condition)}) {\n${emitBlock(node.body, scope, depth + 1)}\n${indent}}`;
      }
      if (node.type === "foreach") {
        const names = node.names.map(variable);
        const target = names.length === 1 ? names[0] : `[${names.join(", ")}]`;
        return `${indent}for (${target} of __prose_each(${emit(node.iterable)}, ${node.line})) {\n${emitBlock(node.body, scope, depth + 1)}\n${indent}}`;
      }
      const limit = `_limit${loopId++}`;
      const counter = variable(node.name);
      return `${indent}{\n${indent}  const ${limit} = ${emit(node.end)};\n${indent}  for (${counter} = ${emit(node.start)}; ${counter} <= ${limit}; ${counter}++) {\n${emitBlock(node.body, scope, depth + 2)}\n${indent}  }\n${indent}}`;
    };
    return nodes.filter(node => node.type !== "use" && node.type !== "typeDeclaration")
      .map(node => mapped(node, statement(node))).join("\n");
  }

  function emitScope(nodes, scope, depth) {
    // In the checking output, a variable assigned once is declared const where it's assigned.
    // The rest are declared bare up front, so TypeScript follows each value assigned to them.
    scope.constants = check ? new Set([...singleAssignments(nodes)].filter(name => scope.locals.has(name))) : new Set();
    scope.types = check ? declaredTypes(nodes) : new Map();
    const locals = [...scope.locals.keys()].filter(name => !scope.constants.has(name));
    const declarations = locals.length ? `${pad(depth)}let ${locals.map(name => typed(name, scope)).join(", ")};\n` : "";
    return unmapped(declarations) + emitBlock(nodes, scope, depth);
  }

  const checkedParameter = (type, optional) => mapped(type, parameterType(optional && type?.kind === "maybe" ? type.of : type));
  const checkedType = (type, optional) => mapped(type, typeText(optional && type?.kind === "maybe" ? type.of : type));
  const typed = (name, scope) => scope.types.has(name) ? `${variable(name)}: ${checkedType(scope.types.get(name))}` : variable(name);

  const body = emitScope(program, programScope, 0);
  const exported = exports.size ? `export { ${[...exports].map(([name, local]) => `${local} as ${name}`).join(", ")} };` : "";
  if (check) {
    const checkCode = [
      checkPrelude,
      ...program.filter(node => node.type === "use" && node.typeOnly).map(node =>
        mapped(node, `import type { ${node.names.join(", ")} } from ${JSON.stringify(node.source)};`)),
      ...imports.map(node =>
        mapped(node, `import { ${node.names.map(name => `${camel(name)} as ${variable(name)}`).join(", ")} } from ${JSON.stringify(node.source)};`)),
      ...program.filter(node => node.type === "typeDeclaration").map(node => mapped(node, typeDeclarationLines(node, checkedType, mapped).join("\n"))),
      body,
      exported || "export {};"
    ].join("\n") + "\n";
    const { code, map } = mapper ? mapper.finish(checkCode) : { code: checkCode, map: null };
    return { code: options.sourceMap === "inline" ? code + inlineSourceMap(map) + "\n" : code, map, module: true, declarations: declarationsFor(program), ...(hasMarkup ? { jsx: true } : {}) };
  }
  const module = moduleSyntax ||
    program.some(node => node.typeOnly || (node.type === "typeDeclaration" && node.exported));
  const markedCode = [
    module ? "" : '"use strict";',
    options.runtime ? `import { ${runtimeHelpers.join(", ")} } from ${JSON.stringify(options.runtime)};` : "",
    hasMarkup ? 'import { createElement as __prose_element, Fragment as __prose_fragment } from "react";' : '',
    ...imports.map(node =>
      mapped(node, `import { ${node.names.map(name => `${camel(name)} as ${variable(name)}`).join(", ")} } from ${JSON.stringify(node.source)};`)),
    options.runtime ? "" : runtimeSource,
    body,
    exported
  ].filter(Boolean).join("\n") + "\n";
  const { code, map } = mapper ? mapper.finish(markedCode) : { code: markedCode, map: null };
  return { code: options.sourceMap === "inline" ? code + inlineSourceMap(map) + "\n" : code, map, module, declarations: declarationsFor(program), ...(hasMarkup ? { jsx: true } : {}) };
}

