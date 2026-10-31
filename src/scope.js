// Scopes, name resolution, and contextual dot access.
import { camel, variable } from "./names.js";
import { fail } from "./errors.js";

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


export { assignedNames, createScope, dotKey, dotName, eachStatement, rebindable, resolve };
