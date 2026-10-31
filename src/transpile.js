import { runtimeHelpers, runtimeSource } from "./runtime.js";
import { checkPrelude } from "./check.js";
import { inlineSourceMap, sourceMapBuilder } from "./source-map.js";
import { callScopeKey, inferCallArities } from "./call-arity.js";
import { explainLayoutError } from "./layout-diagnostics.js";
import { fail } from "./errors.js";
import { camel } from "./names.js";
import { located, memberLocated } from "./ast.js";
import { reserved, typeTests, isWord } from "./syntax.js";
import { Expression } from "./expression.js";
import { conditionOnly, continues, sourceLines, valueOnly } from "./layout.js";

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

function functionHeader(tokens, line) {
  const expr = new Expression(tokens, line);
  if (expr.at("export")) expr.take("export");
  expr.take("function");
  const name = expr.name();
  const { names: params, types, returns, typeParams } = expr.parameters();
  expr.end();
  return { name, params, types, returns, ...(typeParams ? { typeParams } : {}) };
}

const startsFunction = tokens => isWord(tokens[isWord(tokens[0], "export") ? 1 : 0], "function");

function useStatement(tokens, line) {
  const expr = new Expression(tokens, line);
  expr.take("use");
  // `use type A from "path"` imports TypeScript types for declarations; it emits no JavaScript.
  const typeOnly = isWord(expr.peek(), "type") && expr.tokens[expr.pos + 1]?.type === "word" &&
    !isWord(expr.tokens[expr.pos + 1], "from");
  if (typeOnly) expr.take("type");
  const names = expr.names("imported");
  if (!expr.at("from")) fail(line, "Expected 'from' and a quoted module path.");
  expr.take("from");
  const source = expr.tokens[expr.pos++];
  if (source?.type !== "string") fail(line, "Expected a quoted module path after 'from'.");
  expr.end();
  return { type: "use", names, source: source.value, typeOnly, line };
}

// Endings that carry a line on to the next, more indented one: a comma or an operator.
// The functions (with their parameters) and variables a Prose module exports, from its export lines.
function exportsOf(source, options = {}) {
  const functions = new Map();
  const values = new Set();
  for (const { line, indent, tokens } of sourceLines(source)) {
    if (indent || !isWord(tokens[0], "export")) continue;
    if (isWord(tokens[1], "function")) {
      const header = functionHeader(tokens, line);
      functions.set(header.name, header);
    } else if (tokens[1]?.type === "word" && (isWord(tokens[2], "is") || isWord(tokens[2], "as"))) {
      values.add(tokens[1].value);
    }
  }
  // Publish names before resolving forwarded values so cycles can return an
  // unknown signature instead of recursing or inventing a parameter count.
  const exported = { functions, values, valueArities: new Map([...values].map(name => [name, null])),
    valueSignatures: new Map([...values, ...functions.keys()].map(name => [name, [{ kind: "unknown" }]])) };
  options.exportCache?.set(options.modulePath, exported);
  const { analysis } = discoverCallArities(source, options, false);
  exported.valueSignatures = analysis.valueSignatures([...values, ...functions.keys()]);
  for (const name of values) {
    const signatures = exported.valueSignatures.get(name).filter(value => value.kind !== "absent");
    const counts = new Set(signatures.map(value => value.kind === "function" ? value.arity : null));
    exported.valueArities.set(name, counts.size === 1 ? [...counts][0] : null);
  }
  return exported;
}

function exportCacheKey(specifier) {
  if (!/^\.{1,2}\//.test(specifier)) return specifier;
  const parts = [];
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return "./" + parts.join("/");
}

function importedModulePath(specifier, importer) {
  if (!importer || !/^\.{1,2}\//.test(specifier)) return exportCacheKey(specifier);
  const combined = importer.slice(0, importer.lastIndexOf("/") + 1) + specifier;
  if (/^\.{1,2}\//.test(combined)) return exportCacheKey(combined);
  // Absolute paths, URL specifiers, and package subpaths keep their prefix.
  const parts = [];
  for (const part of combined.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function readExports(use, options) {
  const { readModule, exportCache: cache } = options;
  const key = importedModulePath(use.source, options.modulePath);
  if (cache?.has(key)) return cache.get(key);
  if (!readModule) {
    fail(use.line, `To import "${use.source}", compile with a readModule option; the CLI and Vite plugin provide one.`);
  }
  let source;
  try {
    source = readModule(options.modulePath ? key : use.source);
  } catch (error) {
    fail(use.line, `Can't read "${use.source}": ${error.message}`);
  }
  try {
    if ((options.moduleDepth ?? 0) >= 128) fail(use.line, "Import signature discovery exceeded 128 modules in one chain.");
    const exported = exportsOf(source, { ...options, modulePath: key, moduleDepth: (options.moduleDepth ?? 0) + 1 });
    cache?.set(key, exported);
    return exported;
  } catch (error) {
    cache?.delete(key);
    fail(use.line, `In "${use.source}", ${error.message}`);
  }
}

// Whether the tokens from pos are an assignment target (a name, then any :property and .position steps)
// followed by is or as. Only this shape is an assignment, so `runs:push object start is key` is a call.
function assignsAt(tokens, pos) {
  if (tokens[pos]?.type !== "word") return false;
  pos++;
  while (tokens[pos]?.type === "symbol" && (tokens[pos].value === ":" || tokens[pos].value === ".")) {
    pos++;
    if (tokens[pos]?.type === "symbol" && tokens[pos].value === "(") {
      for (let depth = 0; pos < tokens.length; pos++) {
        if (tokens[pos].type !== "symbol") continue;
        if (tokens[pos].value === "(") depth++;
        else if (tokens[pos].value === ")" && --depth === 0) break;
      }
    }
    pos++;
  }
  return isWord(tokens[pos], "is") || isWord(tokens[pos], "as");
}

// Whether the tokens from pos are names separated by commas, then `are`.
function destructuresAt(tokens, pos) {
  while (tokens[pos]?.type === "word") {
    if (isWord(tokens[pos + 1], "are")) return true;
    if (tokens[pos + 1]?.type !== "symbol" || tokens[pos + 1].value !== ",") return false;
    pos += 2;
  }
  return false;
}

class Parser {
  constructor(source, options = {}, analysis = null, loose = true, readImports = true) {
    this.pos = 0;
    // How many loops enclose the line being parsed, within the current function.
    this.loopDepth = 0;
    this.lines = sourceLines(source, { locations: true });
    this.callAnalysis = analysis; this.callScope = analysis?.root ?? null; this.loose = loose;
    this.signatureProbe = options.signatureProbe;
    this.lineScopes = new Map(); this.valueArities = new Map(); this.valueSignatures = new Map();
    // Discover top-level signatures before parsing calls, supporting forward recursion.
    this.functions = new Map(["length", "char_to_number", "number_to_char"].map(name =>
      [name, { name, params: ["value"], builtin: true }]
    ));
    const headers = this.lines.filter(line => line.indent === 0 && startsFunction(line.tokens))
      .map(line => ({ ...functionHeader(line.tokens, line.line), line: line.line }));
    for (const header of headers) {
      if (this.functions.has(header.name)) fail(header.line, `Duplicate function '${header.name}'.`);
      this.functions.set(header.name, header);
    }
    // Functions imported from Prose files are called like this file's own; other imports are values.
    const values = [];
    for (const line of this.lines.filter(line => line.indent === 0 && isWord(line.tokens[0], "use"))) {
      const use = useStatement(line.tokens, line.line);
      if (use.typeOnly) continue;
      const exported = readImports && use.source.endsWith(".prose") ? readExports(use, options) : null;
      for (const name of use.names) {
        const supplied = result => {
          if (!result.functions.has(name) && !result.values.has(name)) fail(use.line, `"${use.source}" doesn't export '${name}'.`);
          return { values: result.valueSignatures.get(name) ?? [{ kind: "unknown" }], reference: { source: use.source, name: camel(name), steps: [] } };
        };
        if (exported) this.valueSignatures.set(name, supplied(exported));
        else if (!readImports && options.readModule && use.source.endsWith(".prose")) this.valueSignatures.set(name, () => supplied(readExports(use, options)));
        const header = exported?.functions.get(name);
        if (header) {
          if (this.functions.has(name)) fail(use.line, `Duplicate function '${name}'.`);
          this.functions.set(name, { ...header, line: use.line });
        } else if (exported && !exported.values.has(name)) {
          fail(use.line, `"${use.source}" doesn't export '${name}'.`);
        } else {
          values.push([name, use.line]);
          this.valueArities.set(name, exported?.valueArities.get(name) ?? null);
        }
      }
    }
    for (const header of headers) {
      for (const param of header.params) this.checkVariable(param, header.line);
    }
    for (const [name, line] of values) this.checkVariable(name, line);
  }
  validateContinuations() {
    // Recheck with declared/imported argument counts: a string after the last
    // argument can already be an inline body, rather than part of a call.
    for (const line of this.lines) for (const continuation of line.leading ?? []) {
      if (!conditionOnly({ ...line, tokens: line.tokens.slice(0, continuation.at) }, this.functions, this.callAnalysis, this.lineScopes.get(line), this.loose)) {
        fail(continuation.line, "A leading 'and' or 'or' can only continue a condition before its body starts.", { layout: { kind: "leading-condition", start: line.line } });
      }
    }
    for (const line of this.lines) for (const continuation of line.conditionalValues ?? []) {
      if (!valueOnly({ ...line, tokens: line.tokens.slice(0, continuation.at) }, this.functions, this.callAnalysis, this.lineScopes.get(line), this.loose)) {
        fail(continuation.line, "An indented trailing 'if' must follow a complete value, not a block header.", { layout: { kind: "conditional-value", start: line.line } });
      }
    }
  }
  expression(line, tokens = line.tokens) {
    this.lineScopes.set(line, this.callScope);
    const expression = new Expression(tokens, line.line, this.functions, this.callAnalysis, this.callScope, this.loose);
    expression.signatureProbe = this.signatureProbe;
    return expression;
  }
  program() {
    try { return this.block(); }
    catch (error) {
      // A malformed continuation can make a later body look misindented.
      // Prefer the diagnostic at the continuation that caused it.
      this.validateContinuations();
      throw error;
    }
  }
  checkVariable(name, line) {
    if (this.functions.has(name)) fail(line, `Variable '${name}' conflicts with a function name.`);
  }
  body(parent, inFunction) {
    const next = this.lines[this.pos];
    if (!next || next.indent <= parent.indent) fail(parent.line, "Expected an indented body.", { layout: { kind: "body", start: parent.line } });
    return this.block(next.indent, inFunction);
  }
  condition(expr, allowList = false) {
    const value = allowList ? expr.list() : expr.parse();
    if (expr.blockFunctions.length) {
      fail(expr.line, "A function with an indented body can't be part of an if, while, or for line.");
    }
    return value;
  }
  conditionalBody(expr, line, inFunction) {
    return expr.peek() ? [this.simple(expr, inFunction)] : this.body(line, inFunction);
  }
  // An if line's body: the rest of the line, optionally after then, or the indented lines below it.
  ifBody(expr, line, inFunction) {
    if (expr.at("then")) {
      expr.take("then");
      return this.conditionalBody(expr, line, inFunction);
    }
    // In `if ready count is 5`, `ready count` reads as a call, so the body needs then.
    const next = this.lines[this.pos];
    if (expr.adjacentCall && (expr.at("is") || (!expr.peek() && !(next?.indent > line.indent)))) {
      fail(line.line, "This if line's condition ends in a call, so a body that starts with a name needs then before it: if ready then count is 5.");
    }
    return this.conditionalBody(expr, line, inFunction);
  }
  // Reads the indented lines after a line: an object literal's properties or a function's body.
  indentedValue(expr, value, line) {
    const functions = expr.blockFunctions;
    if (functions.length > 1 || (functions.length && value?.type === "object" && !value.inline)) {
      fail(line.line, "Only one indented body can follow a line.");
    }
    if (functions.length) functions[0].body = this.functionBody(line, functions[0]);
    else if (value?.type === "object" && !value.inline) this.objectBody(value, line);
  }
  // A function's body starts outside any loop, so skip and stop can't reach a loop around the function.
  functionBody(line, fn) {
    const loops = this.loopDepth;
    const scope = this.callScope;
    this.loopDepth = 0;
    this.callScope = this.callAnalysis?.scopes.get(fn ? callScopeKey(fn) : callScopeKey(line.tokens[0])) ?? null;
    try { return this.body(line, true); }
    finally { this.loopDepth = loops; this.callScope = scope; }
  }
  loopBody(line, inFunction) {
    this.loopDepth++;
    const body = this.body(line, inFunction);
    this.loopDepth--;
    return body;
  }
  typeDeclaration(expr, line, exported, doc) {
    expr.take("type");
    const name = expr.name();
    if (!/^[A-Z]/.test(name)) fail(line.line, "Type names start with a capital letter, like StreakRun.");
    const typeParams = expr.genericParameters();
    expr.take("is");
    const value = expr.typeExpression();
    expr.end();
    const fields = value.kind === "object" ? this.typeFields(line) : null;
    return { type: "typeDeclaration", name, exported, doc, value, fields, ...(typeParams.length ? { typeParams } : {}), line: line.line };
  }
  // The indented `name as type` lines of an object type; a quoted line documents the next field.
  typeFields(parent) {
    const fields = [];
    const next = this.lines[this.pos];
    if (!next || next.indent <= parent.indent) return fields;
    let doc;
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent < next.indent) break;
      if (line.indent > next.indent) fail(line.line, "Unexpected indentation in a type.", { layout: { kind: "type", start: parent.line } });
      this.pos++;
      if (line.tokens.length === 1 && line.tokens[0].type === "string") {
        doc = doc === undefined ? line.tokens[0].value : `${doc} ${line.tokens[0].value}`;
        continue;
      }
      const expr = this.expression(line);
      const name = expr.propertyName();
      if (!expr.at("as")) fail(line.line, "Object types contain only fields written as name as type.");
      expr.take("as");
      fields.push(located({ name, type: expr.typeExpression(), doc }, line.tokens[0]));
      expr.end();
      doc = undefined;
    }
    return fields;
  }
  objectBody(object, parent) {
    const next = this.lines[this.pos];
    if (!next || next.indent <= parent.indent) return;
    const indent = next.indent;
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line.line, "Unexpected indentation in object body.", { layout: { kind: "object", start: parent.line } });
      this.pos++;
      if (line.tokens.length === 1 && line.tokens[0].type === "string") continue;
      const expr = this.expression(line);
      if (expr.at("like") && !isWord(line.tokens[1], "is")) {
        expr.take("like");
        object.properties.push({ spread: true, value: expr.parse(), line: line.line });
        expr.end();
        continue;
      }
      const name = expr.propertyName();
      if (!expr.at("is")) fail(line.line, "Object bodies contain only property definitions: name is value.");
      expr.take("is");
      const value = expr.peek() ? expr.list() : { type: "unset" };
      expr.end();
      this.indentedValue(expr, value, line);
      object.properties.push(located({ name, value }, line.tokens[0]));
    }
  }
  simple(expr, inFunction, parent = null) {
    let node;
    const first = expr.peek();
    if (expr.at("print")) {
      expr.take("print");
      node = { type: "print", value: expr.list() };
    } else if (expr.at("return")) {
      if (!inFunction) fail(expr.line, "'return' is only allowed inside a function.");
      expr.take("return");
      node = { type: "return", value: expr.peek() ? expr.list() : null };
    } else if (expr.at("skip") || expr.at("stop")) {
      const word = expr.take(first.value).value;
      if (expr.peek()) fail(expr.line, `'${word}' is a word for loops, so it can't be used as a name.`);
      if (!this.loopDepth) fail(expr.line, `'${word}' only works inside a loop.`);
      node = { type: word };
    } else if (expr.at("fail")) {
      expr.take("fail");
      if (!expr.peek()) fail(expr.line, "Expected a message after 'fail': fail \"Choose a date.\"");
      node = { type: "fail", value: expr.parse() };
    } else if (destructuresAt(expr.tokens, expr.pos)) {
      const names = expr.names("variable");
      expr.take("are");
      if (!expr.peek()) fail(expr.line, "Expected a list after 'are'.");
      node = { type: "destructure", names, value: expr.list() };
    } else if (assignsAt(expr.tokens, expr.pos)) {
      const name = expr.variableName();
      let target = { type: "name", value: name, line: expr.line };
      const declaredType = expr.optionalType();
      while (!declaredType && (expr.at(":") || expr.at("."))) {
        if (expr.at(":")) {
          expr.take(":");
          const member = expr.peek();
          if (expr.at("(")) {
            expr.take("(");
            const key = expr.inParentheses(() => expr.parse());
            expr.take(")");
            target = memberLocated({ type: "property", object: target, key, line: expr.line }, member);
          } else {
            target = memberLocated({ type: "property", object: target, name: expr.propertyName(), line: expr.line }, member);
          }
        } else {
          expr.take(".");
          target = expr.dotStep(target);
        }
      }
      expr.take("is");
      if (target.type === "index" && !expr.peek()) fail(expr.line, "Indexed assignment requires a value.");
      const value = expr.peek() ? expr.list() : { type: "unset" };
      node = target.type === "name"
        ? { type: "assign", name, value, declaredType }
        : { type: "assignTarget", target, value };
    } else if (first?.type === "string") {
      node = { type: "expression", value: expr.list() };
    } else if (first?.type === "word" && !this.functions.has(first.value) && expr.pos + 1 === expr.tokens.length) {
      node = { type: "assign", name: expr.variableName(), value: { type: "unset" } };
    } else {
      const startsCall = first?.value === "(" || isWord(first, "new") || isWord(first, "maybe") ||
        (first?.type === "word" && !reserved.has(first.value));
      const value = startsCall ? expr.parse() : null;
      if (!startsCall || !this.loose && !["call", "invoke", "new", "await"].includes(value?.type)) {
        fail(expr.line, "Expected assignment, print, return, a string expression, or a function call; this syntax is not supported yet.");
      }
      node = { type: "expression", value };
    }
    expr.end();
    node.line = expr.line;
    const indented = expr.blockFunctions.length ||
      (node.value?.type === "object" && !node.value.inline && ["assign", "assignTarget", "return"].includes(node.type));
    if (indented && !parent) {
      if (expr.blockFunctions.length) fail(expr.line, "A function with an indented body needs a line of its own, not an inline if.");
    } else if (indented) {
      this.indentedValue(expr, node.value, parent);
    }
    return located(node, first);
  }
  block(indent = 0, inFunction = false) {
    const result = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line.line, "Unexpected indentation.", { layout: { kind: "indent" } });
      this.pos++;
      const expr = this.expression(line);
      const topLevel = indent === 0 && !inFunction;
      const exported = expr.at("export");
      if (exported) {
        if (!topLevel) fail(line.line, "Only top-level functions, variables, and types can be exported.");
        expr.take("export");
      }
      // Quoted comment lines just above a declaration document it in generated declarations.
      const doc = docAbove(result, line.line);
      const declaresType = isWord(expr.peek(), "type") && expr.tokens[expr.pos + 1]?.type === "word" &&
        !isWord(expr.tokens[expr.pos + 1], "is");
      if (expr.at("function")) {
        if (!topLevel) fail(line.line, "Functions must be declared at the top level.");
        const header = functionHeader(line.tokens, line.line);
        result.push({ type: "function", ...header, exported, doc, line: line.line, body: this.functionBody(line) });
      } else if (declaresType) {
        if (!topLevel) fail(line.line, "Types must be declared at the top level.");
        result.push(this.typeDeclaration(expr, line, exported, doc));
      } else if (exported) {
        const node = this.simple(expr, inFunction, line);
        if (node.type !== "assign") fail(line.line, "Only functions, variables, and types can be exported.");
        result.push({ ...node, exported, doc });
      } else if (expr.at("use")) {
        if (!topLevel) fail(line.line, "'use' is only allowed at the top level.");
        result.push(useStatement(line.tokens, line.line));
      } else if (expr.at("if")) {
        expr.take("if");
        const condition = this.condition(expr);
        const branches = [located({ condition, body: this.ifBody(expr, line, inFunction) }, line.tokens[0])];
        let otherwise = [];
        while (this.pos < this.lines.length) {
          const next = this.lines[this.pos];
          if (next.indent !== indent || !isWord(next.tokens[0], "else")) break;
          this.pos++;
          const tail = this.expression(next);
          tail.take("else");
          if (tail.at("if")) {
            tail.take("if");
            const condition = this.condition(tail);
            branches.push(located({ condition, body: this.ifBody(tail, next, inFunction) }, next.tokens[0]));
          } else {
            otherwise = located(this.conditionalBody(tail, next, inFunction), next.tokens[0]);
            break;
          }
        }
        result.push({ type: "if", branches, otherwise });
      } else if (expr.at("try")) {
        expr.take("try");
        expr.end();
        const body = this.body(line, inFunction);
        const next = this.lines[this.pos];
        if (next?.indent !== indent || !isWord(next.tokens[0], "on") || !isWord(next.tokens[1], "error")) {
          fail(line.line, "A try block needs an on error block after it, for when something in it fails.");
        }
        this.pos++;
        const handler = this.expression(next);
        handler.take("on");
        handler.take("error");
        // `on error problem` names what failed, usually an Error with a message.
        const name = handler.peek() ? handler.variableName() : null;
        handler.end();
        result.push({ type: "try", body, name, handler: located(this.body(next, inFunction), next.tokens[0]), line: next.line });
      } else if (expr.at("while")) {
        expr.take("while");
        const condition = this.condition(expr);
        expr.end();
        result.push({ type: "while", condition, body: this.loopBody(line, inFunction) });
      } else if (expr.at("for")) {
        expr.take("for");
        if (expr.at("each")) {
          expr.take("each");
          const names = expr.names("loop variable");
          expr.take("in");
          const iterable = this.condition(expr, true);
          expr.end();
          result.push({ type: "foreach", names, iterable, line: line.line, body: this.loopBody(line, inFunction) });
        } else {
          const name = expr.variableName();
          expr.take("is");
          const start = this.condition(expr);
          expr.take("to");
          const end = this.condition(expr);
          expr.end();
          result.push({ type: "for", name, start, end, line: line.line, body: this.loopBody(line, inFunction) });
        }
      } else {
        result.push(this.simple(expr, inFunction, line));
      }
      located(result.at(-1), line.tokens[0]);
    }
    return result;
  }
}

// The comment lines in a row that end on the line before a declaration, joined as one paragraph.
function docAbove(nodes, line) {
  const parts = [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    const comment = node.type === "expression" && node.value.type === "literal" && typeof node.value.value === "string";
    if (!comment || node.line !== line - parts.length - 1) break;
    parts.unshift(node.value.value);
  }
  return parts.length ? parts.join(" ") : undefined;
}

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

function discoverCallArities(source, settings, readImports = true) {
  const discovery = new Parser(source, settings, null, true, readImports);
  const invalidated = new Set();
  const infer = (program, parser) => ({ ...inferCallArities(program, parser.functions, parser.valueArities, invalidated, camel, parser.valueSignatures, !readImports), partialImports: !readImports });
  let analysis = infer(discovery.program(), discovery);
  for (let iteration = 0; iteration < 64; iteration++) {
    const parser = new Parser(source, settings, analysis, true, readImports);
    const program = parser.program();
    let next = infer(program, parser);
    for (const [key, before] of analysis.scopes) for (const [name, count] of before.bindings) {
      if (count !== null && next.scopes.get(key)?.bindings.get(name) !== count) invalidated.add(`${key}/${name}`);
    }
    for (const [key, before] of analysis.scopes) for (const [name, kind] of before.kinds) {
      if (kind !== null && next.scopes.get(key)?.kinds.get(name) !== kind) invalidated.add(`kind:${key}/${name}`);
    }
    for (const [key, count] of analysis.propertyArities) {
      if (count !== null && next.propertyArities.get(key) !== count) invalidated.add(key);
    }
    next = infer(program, parser);
    if (next.fingerprint === analysis.fingerprint) {
      return { analysis: next };
    }
    analysis = next;
  }
  fail(1, "Call boundaries could not be inferred consistently. Use with to make the argument lists explicit.");
}

/**
 * Compile Prose to JavaScript: a script, or an ES module if it uses modules or imports its runtime.
 * `declarations` is a TypeScript declaration file for the module's exports, or null.
 * `sourceMap: true` returns a map; "inline" also embeds it. `filename` identifies the source.
 */
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
