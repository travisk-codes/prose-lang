// TypeScript spelling and generated declaration helpers.
import { camel, variable } from "./names.js";
import { eachStatement } from "./scope.js";
import { fail } from "./errors.js";
import { awaits } from "./awaits.js";

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

export {
  declarationsFor, declaredTypes, docComment, generic, genericParametersFor,
  laterProperties, literalType, parameterList, parameterName, parameterType,
  returnType, singleAssignments, typeDeclarationLines, typeText, typeVariables,
  validateGenericParameters
};
