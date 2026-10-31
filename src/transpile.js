import { runtimeHelpers, runtimeSource } from "./runtime.js";
import { checkPrelude } from "./check.js";
import { inlineSourceMap, sourceMapBuilder } from "./source-map.js";
import { explainLayoutError } from "./layout-diagnostics.js";
import { fail } from "./errors.js";
import { camel } from "./names.js";
import { typeTests } from "./syntax.js";
import { continues, sourceLines } from "./layout.js";
import { Parser, discoverCallArities } from "./parser.js";

export { camel };
export { continues, sourceLines };
export { markupExpressionAt } from "./lexer.js";

// JavaScript's own values, which a name refers to when no Prose variable has that name.
const javascriptGlobals = new Set([
  "Array", "ArrayBuffer", "BigInt", "Boolean", "DataView", "Date", "Error", "EvalError",
  "Float32Array", "Float64Array", "Function", "Infinity", "Int8Array", "Int16Array", "Int32Array",
  "Intl", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError",
  "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError", "TypeError",
  "URIError", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "WeakMap",
  "WeakRef", "WeakSet", "globalThis", "isFinite", "isNaN", "parseFloat", "parseInt",
  "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent", "structuredClone",
  "queueMicrotask", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "console",
  "AbortController", "Blob", "BroadcastChannel", "CustomEvent", "Event", "File", "FileReader",
  "FormData", "Headers", "IntersectionObserver", "MutationObserver", "Notification", "Request",
  "ResizeObserver", "Response", "TextDecoder", "TextEncoder", "URL", "URLSearchParams",
  "alert", "cancelAnimationFrame", "confirm", "crypto", "document", "fetch", "getComputedStyle",
  "history", "indexedDB", "localStorage", "location", "matchMedia", "navigator", "performance",
  "requestAnimationFrame", "sessionStorage", "window", "Buffer", "process",
  "AggregateError", "DOMException", "Element", "HTMLButtonElement", "HTMLCanvasElement", "HTMLElement",
  "HTMLImageElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "KeyboardEvent",
  "MouseEvent", "Node", "PointerEvent"
]);

const variable = name => `_prose_${name}`;
const pad = depth => "  ".repeat(depth);

// Visits a body's statements, including those in its branches, loops, and handlers, but not
// those of the functions declared in it, which have their own variables.
function eachStatement(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    if (node.type === "try") eachStatement(node.handler, visit);
    if (node.type === "if") {
      for (const branch of node.branches) eachStatement(branch.body, visit);
      eachStatement(node.otherwise, visit);
    } else if (node.body && node.type !== "function") {
      eachStatement(node.body, visit);
    }
  }
}

// The variables a body assigns, with the line of each one's first assignment.
function assignedNames(nodes) {
  const names = new Map();
  eachStatement(nodes, node => {
    const assigned = node.type === "assign" || node.type === "for" ? [node.name]
      : node.type === "foreach" || node.type === "destructure" ? node.names
      : node.type === "try" && node.name ? [node.name] : [];
    for (const name of assigned) if (!names.has(name)) names.set(name, node.line);
  });
  return names;
}

// Whether a body waits for something itself (not just in functions inside it), which makes it asynchronous.
function awaits(node) {
  if (Array.isArray(node)) return node.some(awaits);
  if (!node || typeof node !== "object" || node.type === "lambda" || node.type === "function") return false;
  return node.type === "await" || Object.values(node).some(awaits);
}

// The first `wait for` outside a function or lambda. It needs module output, because
// JavaScript only allows a top-level await in a module.
function topLevelAwait(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = topLevelAwait(child);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || node.type === "lambda" || node.type === "function") return null;
  if (node.type === "await") return node;
  for (const value of Object.values(node)) {
    const found = topLevelAwait(value);
    if (found) return found;
  }
  return null;
}

function createScope(params, body, parent) {
  const locals = assignedNames(body);
  for (const param of params) locals.delete(param);
  return { parent, locals, names: new Set([...params, ...locals.keys(), ...body.filter(node => node.type === "function").map(node => node.name)]), imports: new Set() };
}

function resolve(node, scope) {
  for (let current = scope; current; current = current.parent) {
    if (current.names.has(node.value)) return variable(node.value);
  }
  if (javascriptGlobals.has(camel(node.value))) return camel(node.value);
  fail(node.line, `Unknown name '${node.value}'. Assign it before using it, or check the spelling.`);
}

function dotKey(node, scope, emit) {
  if (node.key) return emit(node.key);
  for (let current = scope; current; current = current.parent) {
    if (current.names.has(node.name)) {
      // Defer reading the variable until the receiver requires an index.
      return `() => ${variable(node.name)}`;
    }
  }
  return "undefined";
}

const dotName = node => node.key ? "undefined" : JSON.stringify(camel(node.name));

// Indexed writes rebuild strings, so the variable holding one must be assignable.
function rebindable(node, scope) {
  for (let current = scope; current; current = current.parent) {
    if (current.imports.has(node.value)) fail(node.line, `'${node.value}' is imported, so its positions can't be assigned.`);
    if (current.names.has(node.value)) return variable(node.value);
  }
  resolve(node, scope);
  fail(node.line, `'${node.value}' belongs to JavaScript, so its positions can't be assigned.`);
}

// A type as TypeScript writes it.
function typeText(type) {
  if (!type) return "any";
  // Function types inside unions, lists, and maybe need parentheses to keep their return type separate.
  const inner = child => child.kind === "function" ? `(${typeText(child)})` : typeText(child);
  if (type.kind === "builtin") return type.name;
  if (type.kind === "literal") return JSON.stringify(type.value);
  if (type.kind === "variable") return type.name;
  if (type.kind === "object") return "object";
  if (type.kind === "group") return `(${typeText(type.of)})`;
  if (type.kind === "tuple") return `[${type.items.map(typeText).join(", ")}]`;
  if (type.kind === "union") return type.options.map(inner).join(" | ");
  if (type.kind === "maybe") return `${inner(type.of)} | undefined`;
  if (type.kind === "list") {
    return ["union", "maybe", "function"].includes(type.of.kind) ? `(${typeText(type.of)})[]` : `${typeText(type.of)}[]`;
  }
  if (type.kind === "set") return `Set<${typeText(type.of)}>`;
  if (type.kind === "map") return `Map<${typeText(type.from)}, ${typeText(type.to)}>`;
  if (type.kind === "function") {
    let optionalFrom = type.params.length;
    while (optionalFrom && type.params[optionalFrom - 1].kind === "maybe") optionalFrom--;
    const params = type.params.map((param, index) => index >= optionalFrom
      ? `arg${index + 1}?: ${typeText(param.of)}`
      : `arg${index + 1}: ${typeText(param)}`).join(", ");
    return `(${params}) => ${type.returns ? typeText(type.returns) : "void"}`;
  }
  return type.args.length ? `${type.name}<${type.args.map(typeText).join(", ")}>` : type.name;
}

// The type variables in some types, in order of first appearance, for a generic signature.
function typeVariables(types, found = []) {
  for (const type of types.filter(Boolean)) {
    if (type.kind === "variable" && !found.includes(type.name)) found.push(type.name);
    typeVariables([type.of, type.from, type.to, type.returns, ...(type.options ?? []), ...(type.params ?? []), ...(type.args ?? []), ...(type.items ?? [])], found);
  }
  return found;
}

// Inferred parameters retain their existing order. An explicit list names every
// parameter owned by that declaration; nested functions may use outer types.
function genericParametersFor(node, inherited = new Set()) {
  const types = node.type === 'typeDeclaration' ? node.fields ? node.fields.map(field => field.type) : [node.value]
    : [...(node.types ?? []), node.returns];
  const inferred = typeVariables([...types, ...(node.typeParams ?? []).map(parameter => parameter.bound)]);
  if (!node.typeParams) return inferred.filter(name => !inherited.has(name)).map(name => ({ name }));
  const declared = new Set(node.typeParams.map(parameter => parameter.name));
  for (const name of inferred) if (!declared.has(name) && !inherited.has(name)) {
    fail(node.line, `Type parameter '${name}' is not declared. Include it in the of list.`);
  }
  return node.typeParams;
}

function validateGenericParameters(node, inherited = new Set()) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => validateGenericParameters(child, inherited)); return; }
  if (['function', 'lambda', 'typeDeclaration'].includes(node.type)) {
    const own = genericParametersFor(node, inherited);
    if (node.type !== 'typeDeclaration') validateGenericParameters(node.body ?? node.value, new Set([...inherited, ...own.map(parameter => parameter.name)]));
    return;
  }
  for (const child of Object.values(node)) if (child && typeof child === 'object') validateGenericParameters(child, inherited);
}

const generic = (parameters, typeOf = typeText, parameterOf = (parameter, code) => code) => parameters.length
  ? `<${parameters.map(parameter => typeof parameter === 'string' ? parameter
    : parameterOf(parameter, parameter.name + (parameter.bound ? ` extends ${typeOf(parameter.bound)}` : ''))).join(', ')}>` : '';
const docComment = (doc, indent = "") => doc ? [`${indent}/** ${doc.replace(/\*\//g, "*\\/")} */`] : [];
// Parameter names only document a declaration, so JavaScript's reserved words get a suffix.
const parameterName = name => /^(?:break|case|catch|class|const|continue|debugger|default|delete|do|enum|extends|finally|implements|import|instanceof|interface|let|package|private|protected|public|static|super|switch|this|throw|try|typeof|var|void|yield)$/.test(name) ? `${name}_` : name;

// List parameters are declared read-only, so TypeScript callers can pass read-only arrays too.
function parameterType(type) {
  if (type?.kind === "list") return `readonly ${typeText(type)}`;
  if (type?.kind === "maybe" && type.of.kind === "list") return `readonly ${typeText(type.of)} | undefined`;
  return typeText(type);
}

function literalType(value) {
  if (value?.type !== "literal") return "any";
  return value.value === null ? "null" : typeof value.value;
}

// A function's parameters as TypeScript writes them, from each name as it appears there.
// Trailing parameters that are untyped or maybe can be left out, as Prose's with calls allow.
function parameterList(node, nameOf, untyped = name => name,
  typeOf = (type, optional) => parameterType(optional && type?.kind === "maybe" ? type.of : type)) {
  const types = node.types ?? [];
  let optionalFrom = node.params.length;
  while (optionalFrom > 0 && (!types[optionalFrom - 1] || types[optionalFrom - 1].kind === "maybe")) optionalFrom--;
  return node.params.map((name, index) => {
    const type = types[index];
    if (index < optionalFrom) return type ? `${nameOf(name, index)}: ${typeOf(type, false)}` : untyped(nameOf(name, index));
    return `${nameOf(name, index)}?: ${typeOf(type, true)}`;
  }).join(", ");
}

// A function that waits for something gives a promise of its result.
function returnType(node) {
  const promised = node.returns?.kind === "named" && node.returns.name === "Promise";
  return awaits(node.body ?? node.value) && !promised ? `Promise<${typeText(node.returns)}>` : typeText(node.returns);
}

function typeDeclarationLines(node,
  typeOf = (type, optional) => typeText(optional && type?.kind === "maybe" ? type.of : type),
  fieldOf = (field, code) => code) {
  const prefix = node.exported ? "export " : "";
  if (!node.fields) {
    return [...docComment(node.doc), `${prefix}type ${node.name}${generic(genericParametersFor(node), typeOf, fieldOf)} = ${typeOf(node.value)};`];
  }
  const lines = [...docComment(node.doc), `${prefix}interface ${node.name}${generic(genericParametersFor(node), typeOf, fieldOf)} {`];
  for (const field of node.fields) {
    const optional = field.type.kind === "maybe";
    lines.push(...docComment(field.doc, "  "), fieldOf(field, `  ${camel(field.name)}${optional ? "?" : ""}: ${typeOf(field.type, optional)};`));
  }
  return [...lines, "}"];
}

// The types written on a body's variables (`count as number is 0`).
function declaredTypes(nodes) {
  const types = new Map();
  eachStatement(nodes, node => {
    if (node.type === "assign" && node.declaredType && !types.has(node.name)) types.set(node.name, node.declaredType);
  });
  return types;
}

// Variables a body assigns exactly once, directly (not in a branch, loop, or handler). The
// checking output declares them const there, which keeps literal types and narrowing.
function singleAssignments(nodes) {
  const counts = new Map();
  const count = (name, by) => counts.set(name, (counts.get(name) ?? 0) + by);
  eachStatement(nodes, node => {
    if (node.type === "assign") count(node.name, 1);
    // Loops, destructuring, and handlers assign as they run, so they rule const out.
    if (node.type === "for") count(node.name, 2);
    if (node.type === "foreach" || node.type === "destructure") for (const name of node.names) count(name, 2);
    if (node.type === "try" && node.name) count(node.name, 2);
  });
  return new Set(nodes.filter(node => node.type === "assign" && counts.get(node.name) === 1).map(node => node.name));
}

// Properties written onto variables after they're made (`stats:best is 3`), by variable name.
// Prose objects can gain properties; TypeScript's need them from the start.
function laterProperties(node, scope, innerScope, found = new Map()) {
  if (Array.isArray(node)) {
    for (const child of node) laterProperties(child, scope, innerScope, found);
  } else if (node && typeof node === "object") {
    if (node.type === "function" || node.type === "lambda") {
      return laterProperties(node.body ?? node.value, innerScope(node, scope), innerScope, found);
    }
    const target = node.type === "assignTarget" && node.target;
    if (target?.type === "property" && !target.key && target.object.type === "name") {
      const name = target.object.value;
      let binding = scope;
      while (binding && !binding.names.has(name)) binding = binding.parent;
      if (binding?.locals.has(name)) {
        if (!found.has(binding)) found.set(binding, new Map());
        const names = found.get(binding);
        if (!names.has(name)) names.set(name, new Set());
        names.get(name).add(target.name);
      }
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") laterProperties(child, scope, innerScope, found);
    }
  }
  return found;
}

// A TypeScript declaration file for a module's exports, or null when it exports nothing.
function declarationsFor(program) {
  if (!program.some(node => node.exported)) return null;
  const lines = ["// Generated by Prose from the .prose file of the same name. Edit that file instead."];
  const signatures = program.exportSignatures;
  const hasMethods = (values, seen = new Set()) => values?.some(value => {
    if (value.kind === "function") return true;
    if (value.kind !== "object" || seen.has(value)) return false;
    return [...value.properties.values()].some(parts => hasMethods(parts, new Set(seen).add(value)));
  });
  const signatureType = (values, seen = new Set()) => {
    const types = values.map(value => {
      if (seen.has(value)) return "any";
      const next = new Set(seen).add(value);
      if (value.reference) {
        let type = `typeof import(${JSON.stringify(value.reference.source)}).${value.reference.name}`;
        for (const step of value.reference.steps) type = step.returns ? `ReturnType<${type}>` : `(${type})[${JSON.stringify(step.property)}]`;
        return type;
      }
      if (value.kind === "function") {
        // A captured generic belongs to its declaring type or factory. Do not
        // invent a free type parameter in an inferred exported value.
        if (value.functionType) return typeVariables([value.functionType]).length ? "any" : typeText(value.functionType);
        if (!value.callable) return "any";
        const node = value.callable;
        return `${generic(genericParametersFor(node))}(${parameterList(node, name => parameterName(camel(name)), name => `${name}: any`)}) => ${returnType(node)}`;
      }
      if (value.kind === "object") {
        const fields = [...value.properties].map(([name, parts]) => `${JSON.stringify(name)}: ${signatureType(parts, next)};`);
        if (value.open) fields.push('[key: string]: any;');
        return `{ ${fields.join(" ")} }`;
      }
      return value.kind === "absent" ? "null | undefined" : "any";
    });
    if (types.includes("any")) return "any";
    const distinct = [...new Set(types)];
    return distinct.length === 1 ? distinct[0] : distinct.map(type => `(${type})`).join(" | ");
  };
  for (const use of program.filter(node => node.type === "use" && node.typeOnly)) {
    lines.push(`import type { ${use.names.join(", ")} } from ${JSON.stringify(use.source)};`);
  }
  for (const node of program) {
    if (node.type === "function" && node.exported) {
      const params = parameterList(node, name => parameterName(camel(name)), name => `${name}: any`);
      const variables = genericParametersFor(node);
      lines.push(...docComment(node.doc),
        `export function ${camel(node.name)}${generic(variables)}(${params}): ${returnType(node)};`);
    } else if (node.type === "assign" && node.exported) {
      const shape = signatures?.get(node.name);
      const inferred = node.declaredType ? typeText(node.declaredType)
        : hasMethods(shape) ? signatureType(shape) : literalType(node.value);
      lines.push(...docComment(node.doc),
        `export let ${camel(node.name)}: ${inferred};`);
    } else if (node.type === "typeDeclaration") {
      lines.push(...typeDeclarationLines(node));
    }
  }
  return lines.join("\n") + "\n";
}

/** Parse a program, also used to verify that formatting preserves its meaning. */
export function parse(source, options = {}) {
  const modules = new Map();
  const settings = { ...options, exportCache: new Map(), readModule: options.readModule && (specifier => {
    if (!modules.has(specifier)) modules.set(specifier, options.readModule(specifier));
    return modules.get(specifier);
  }) };
  try {
    const { analysis } = discoverCallArities(source, settings);
    const final = new Parser(source, settings, analysis, false);
    const result = final.program();
    final.validateContinuations();
    validateGenericParameters(result);
    const exportedValues = result.filter(node => node.type === "assign" && node.exported).map(node => node.name);
    if (exportedValues.length) Object.defineProperty(result, "exportSignatures", { value: analysis.valueSignatures(exportedValues) });
    return result;
  } catch (error) {
    throw explainLayoutError(error, source, () => sourceLines(source, { locations: true }), continues);
  }
}

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

/**
 * Compile the supported Prose subset into JavaScript. Pass `runtime` (a module path) to import
 * the runtime helpers instead of embedding them, and `readModule(path)` to return the source of
 * an imported `.prose` file so its functions can be called like local ones.
 */
export function transpile(source, options = {}) {
  return compile(source, options).code;
}
