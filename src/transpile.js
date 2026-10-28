import { runtimeHelpers, runtimeSource } from "./runtime.js";

const reserved = new Set([
  "if", "else", "for", "is", "to", "print", "and", "or", "not",
  "true", "false", "null", "remainder", "function", "return", "while",
  "async", "await", "takes", "run", "mod", "object", "array",
  "with", "new", "each", "in", "then", "use", "export", "unset", "otherwise", "maybe",
  "as", "giving"
]);

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
  "requestAnimationFrame", "sessionStorage", "window", "Buffer", "process"
]);

function fail(line, message) {
  const error = new SyntaxError(`Line ${line}: ${message}`);
  error.line = line;
  throw error;
}

const isWord = (token, value) => token?.type === "word" && token.value === value;

// Prose's words for TypeScript's basic types.
const builtinTypes = {
  text: "string", number: "number", boolean: "boolean", any: "any", nothing: "void",
  unset: "undefined", null: "null", true: "true", false: "false"
};

function tokenize(text, line) {
  const tokens = [];
  let pos = 0;
  while (pos < text.length) {
    if (/\s/.test(text[pos])) { pos++; continue; }
    // Spacing only matters to tell `f -1` (a negative argument) from `f - 1`.
    const spaced = pos > 0 && /\s/.test(text[pos - 1]);
    const rest = text.slice(pos);
    const number = /^(?:\d+(?:\.\d+)?)/.exec(rest);
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
    if (number) {
      if (!Number.isFinite(Number(number[0]))) fail(line, "Number is too large.");
      tokens.push({ type: "number", value: Number(number[0]) });
      pos += number[0].length;
    } else if (word) {
      tokens.push({ type: "word", value: word[0] });
      pos += word[0].length;
    } else if (text[pos] === '"') {
      const start = pos++;
      let closed = false;
      while (pos < text.length) {
        const char = text[pos++];
        if (char === "\\") pos++;
        else if (char === '"') { closed = true; break; }
      }
      if (!closed) fail(line, "Unterminated string.");
      try {
        tokens.push({ type: "string", value: JSON.parse(text.slice(start, pos)) });
      } catch {
        fail(line, "Invalid string escape.");
      }
    } else {
      const operator = /^(?:<=|>=|!=|[=<>+*/%().,:-])/.exec(rest);
      if (!operator) fail(line, `Unexpected character ${JSON.stringify(text[pos])}.`);
      tokens.push({ type: "symbol", value: operator[0] });
      pos += operator[0].length;
    }
    tokens.at(-1).spaced = spaced;
  }
  return tokens;
}

const precedence = {
  or: 10, otherwise: 10, and: 20,
  "=": 30, "!=": 30, "<": 30, ">": 30, "<=": 30, ">=": 30,
  "+": 40, "-": 40, "*": 50, "/": 50, "%": 50, mod: 50
};

class Expression {
  constructor(tokens, line, functions = new Map()) {
    this.tokens = tokens; this.line = line; this.functions = functions; this.pos = 0;
    // Functions on this line whose bodies are the indented lines after it.
    this.blockFunctions = [];
    // How many call argument lists the parser is inside, outside parentheses.
    this.argumentDepth = 0;
    // Above zero where values sit side by side without being calls, as in `remainder a b`.
    this.adjacentValues = 0;
    // Whether a call by adjacency appeared, for explaining errors on if lines.
    this.adjacentCall = false;
  }
  // Parentheses end any surrounding argument list, so commas inside them are unambiguous.
  inParentheses(parse) {
    const depth = this.argumentDepth;
    const adjacent = this.adjacentValues;
    this.argumentDepth = 0;
    this.adjacentValues = 0;
    const value = parse();
    this.argumentDepth = depth;
    this.adjacentValues = adjacent;
    return value;
  }
  // A name, property, position, or parenthesized value directly followed by a value is called with it.
  callsByAdjacency(left) {
    if (this.adjacentValues || !(left.grouped || ["name", "property", "index"].includes(left.type))) return false;
    const next = this.peek();
    if (next.type === "symbol" && next.value === "-" && next.spaced && this.tokens[this.pos + 1] && !this.tokens[this.pos + 1].spaced) {
      fail(this.line, "'-' here could start a negative argument or subtract. Write with before a negative argument (items:at with -1), or put spaces around a minus that subtracts.");
    }
    if (next.type === "number" || next.type === "string") return true;
    if (next.type === "symbol") return next.value === "(";
    return !reserved.has(next.value) ||
      ["function", "new", "not", "maybe", "array", "object", "unset", "true", "false", "null"].includes(next.value);
  }
  peek() { return this.tokens[this.pos]; }
  at(value) { return this.peek()?.value === value && this.peek()?.type !== "string"; }
  take(value) {
    if (!this.at(value)) fail(this.line, `Expected '${value}'.`);
    return this.tokens[this.pos++];
  }
  name() {
    const token = this.tokens[this.pos++];
    if (token?.type !== "word" || reserved.has(token.value)) {
      fail(this.line, "Expected a variable name.");
    }
    return token.value;
  }
  variableName() {
    const name = this.name();
    if (this.functions.has(name)) fail(this.line, `Variable '${name}' conflicts with a function name.`);
    return name;
  }
  names(kind) {
    const names = [this.variableName()];
    while (this.at(",")) { this.take(","); names.push(this.variableName()); }
    if (new Set(names).size !== names.length) fail(this.line, `Duplicate ${kind} name.`);
    return names;
  }
  propertyName() {
    const token = this.tokens[this.pos++];
    if (token?.type !== "word") fail(this.line, "Expected a property name after ':', or before 'is' in an object body.");
    return token.value;
  }
  end() {
    if (this.peek()) fail(this.line, `Unexpected token ${JSON.stringify(this.peek().value)}.`);
  }
  index() {
    if (this.at("(")) {
      this.take("(");
      const index = this.inParentheses(() => this.parse());
      this.take(")");
      return index;
    }
    const token = this.peek();
    if (token?.type === "number") {
      this.pos++;
      return { type: "literal", value: token.value };
    }
    if (token?.type === "word" && !reserved.has(token.value) && !this.functions.has(token.value)) {
      this.pos++;
      return { type: "name", value: token.value, line: this.line };
    }
    fail(this.line, "Expected an index: a number, variable, or parenthesized expression.");
  }
  list(allowTrailing = false) {
    const first = this.parse();
    if (!this.at(",")) return first;
    const elements = [first];
    while (this.at(",")) {
      this.take(",");
      if (allowTrailing && this.at(")")) break;
      elements.push(this.parse());
    }
    return { type: "array", elements };
  }
  // The arguments after `with`: every comma-separated value up to the end of the list.
  arguments() {
    const nested = this.argumentDepth > 0;
    this.argumentDepth++;
    const args = [this.parse(60)];
    while (this.at(",")) { this.take(","); args.push(this.parse(60)); }
    this.argumentDepth--;
    if (nested && args.length > 1) {
      fail(this.line, "Inside another call's arguments, a call with several arguments needs parentheses: (f a, b).");
    }
    // Readers split `f a, b + 1` both ways, so neither reading is chosen silently.
    const next = this.peek();
    if ((next?.type === "symbol" && "+-*/%".includes(next.value)) || isWord(next, "mod")) {
      fail(this.line, `'${next.value}' right after a call's arguments is ambiguous. Put the last argument in parentheses to include it, or the whole call to use its result.`);
    }
    return args;
  }
  call(name) {
    const { params, builtin } = this.functions.get(name);
    const args = [];
    if (this.at("with")) {
      this.take("with");
      args.push(...this.arguments());
      if (args.length > params.length || (builtin && args.length < params.length)) {
        fail(this.line, `'${name}' takes ${params.length} argument${params.length === 1 ? "" : "s"}.`);
      }
    } else {
      if (!params.length) this.take("run");
      this.argumentDepth++;
      this.adjacentValues++;
      for (let index = 0; index < params.length; index++) {
        if (index) this.take(",");
        // Calls bind before arithmetic; compound arguments, including calls, require parentheses.
        args.push(this.parse(60));
      }
      this.adjacentValues--;
      this.argumentDepth--;
    }
    return { type: "call", name, args, builtin, line: this.line };
  }
  // `takes` names, each optionally followed by `as` and a type, then an optional `giving` type.
  parameters() {
    const names = [];
    const types = [];
    if (this.at("takes")) {
      this.take("takes");
      while (true) {
        names.push(this.variableName());
        types.push(this.optionalType());
        if (!this.at(",")) break;
        this.take(",");
        if (this.at("giving")) break;
      }
    }
    if (new Set(names).size !== names.length) fail(this.line, "Duplicate parameter name.");
    let returns;
    if (this.at("giving")) {
      this.take("giving");
      returns = this.typeExpression();
    }
    return { names, types, returns };
  }
  optionalType() {
    if (!this.at("as")) return undefined;
    this.take("as");
    return this.typeExpression();
  }
  typeExpression() {
    const options = [this.singleType()];
    while (this.at("or")) { this.take("or"); options.push(this.singleType()); }
    return options.length === 1 ? options[0] : { kind: "union", options };
  }
  singleType() {
    const token = this.tokens[this.pos++];
    if (!token) fail(this.line, "Expected a type.");
    if (token.type === "string" || token.type === "number") return { kind: "literal", value: token.value };
    if (token.value === "(") {
      const inner = this.typeExpression();
      this.take(")");
      return { kind: "group", of: inner };
    }
    const word = token.type === "word" ? token.value : fail(this.line, `Unexpected ${JSON.stringify(token.value)} in a type.`);
    if (word === "maybe") return { kind: "maybe", of: this.singleType() };
    if (word === "list" || word === "set") {
      this.take("of");
      return { kind: word, of: this.singleType() };
    }
    if (word === "map") {
      this.take("from");
      const from = this.singleType();
      this.take("to");
      return { kind: "map", from, to: this.singleType() };
    }
    if (word === "function") {
      const params = [];
      if (this.at("taking")) {
        this.take("taking");
        params.push(this.singleType());
        while (this.at("and")) { this.take("and"); params.push(this.singleType()); }
      }
      let returns;
      if (this.at("giving")) { this.take("giving"); returns = this.singleType(); }
      return { kind: "function", params, returns };
    }
    if (word === "object") return { kind: "object" };
    if (Object.hasOwn(builtinTypes, word)) return { kind: "builtin", name: builtinTypes[word] };
    if (/^[A-Z]/.test(word)) {
      const args = [];
      if (this.at("of")) {
        this.take("of");
        args.push(this.singleType());
      } else if (this.at("from")) {
        this.take("from");
        args.push(this.singleType());
        this.take("to");
        args.push(this.singleType());
      }
      return { kind: "named", name: word, args };
    }
    if (reserved.has(word)) fail(this.line, `Expected a type, not '${word}'.`);
    // Other lowercase names are type variables, like T in TypeScript.
    return { kind: "variable", name: word };
  }
  lambda() {
    const { names, types, returns } = this.parameters();
    const node = { type: "lambda", params: names, types, returns, line: this.line };
    if (this.at("return")) {
      this.take("return");
      // A function's result is its own expression, even inside a Prose call's arguments.
      const adjacent = this.adjacentValues;
      this.adjacentValues = 0;
      node.value = this.parse();
      this.adjacentValues = adjacent;
    } else {
      node.body = [];
      this.blockFunctions.push(node);
    }
    return node;
  }
  parse(min = 0) {
    const token = this.tokens[this.pos++];
    if (!token) fail(this.line, "Expected an expression.");
    let left;
    if (token.type === "number" || token.type === "string") {
      left = { type: "literal", value: token.value };
    } else if (token.value === "(") {
      left = this.inParentheses(() => this.list(true));
      this.take(")");
      left.grouped = true;
    } else if (token.value === "array") {
      left = { type: "array", elements: [] };
    } else if (token.value === "object") {
      left = { type: "object", properties: [] };
    } else if (token.value === "unset") {
      left = { type: "unset" };
    } else if (token.value === "maybe") {
      left = this.parse(70);
      markMaybe(left);
    } else if (token.value === "function") {
      left = this.lambda();
    } else if (token.value === "if") {
      const condition = this.parse();
      this.take("then");
      const then = this.parse();
      this.take("else");
      left = { type: "conditional", condition, then, otherwise: this.parse() };
    } else if (token.value === "new") {
      let callee = { type: "name", value: this.name(), line: this.line };
      while (this.at(":")) {
        this.take(":");
        callee = { type: "property", object: callee, name: this.propertyName(), line: this.line };
      }
      const args = [];
      if (this.at("with")) {
        this.take("with");
        args.push(...this.arguments());
      } else if (this.peek() && this.callsByAdjacency({ type: "name" })) {
        args.push(...this.arguments());
      }
      left = { type: "new", callee, args, line: this.line };
    } else if (token.value === "not" || token.value === "-") {
      left = { type: "unary", op: token.value, operand: this.parse(token.value === "not" ? 25 : 60) };
    } else if (token.value === "remainder") {
      this.adjacentValues++;
      left = { type: "binary", op: "%", left: this.parse(60), right: this.parse(60) };
      this.adjacentValues--;
    } else if (["true", "false", "null"].includes(token.value)) {
      left = { type: "literal", value: { true: true, false: false, null: null }[token.value] };
    } else if (token.type === "word" && !reserved.has(token.value)) {
      left = this.functions.has(token.value)
        ? this.call(token.value)
        : { type: "name", value: token.value, line: this.line };
    } else {
      fail(this.line, `Unexpected token ${JSON.stringify(token.value)} in expression.`);
    }
    while (this.peek()) {
      if (this.at(":") && min <= 70) {
        this.take(":");
        left = { type: "property", object: left, name: this.propertyName(), line: this.line };
        continue;
      }
      if (this.at(".") && min <= 70) {
        this.take(".");
        left = { type: "index", object: left, index: this.index(), line: this.line };
        continue;
      }
      if (this.at("with") && min <= 70) {
        this.take("with");
        left = { type: "invoke", callee: left, args: this.arguments(), line: this.line };
        continue;
      }
      if (this.at("run") && min <= 70) {
        this.take("run");
        left = { type: "invoke", callee: left, args: [], line: this.line };
        continue;
      }
      if (min <= 70 && this.callsByAdjacency(left)) {
        this.adjacentCall = true;
        left = { type: "invoke", callee: left, args: this.arguments(), line: this.line };
        continue;
      }
      const next = this.peek();
      const priority = next.type === "string" || !Object.hasOwn(precedence, next.value) ? undefined : precedence[next.value];
      if (priority === undefined || priority < min) break;
      this.pos++;
      left = { type: "binary", op: next.value, left, right: this.parse(priority + 1), line: this.line };
    }
    return left;
  }
}

function functionHeader(tokens, line) {
  const expr = new Expression(tokens, line);
  if (expr.at("export")) expr.take("export");
  expr.take("function");
  const name = expr.name();
  const { names: params, types, returns } = expr.parameters();
  expr.end();
  return { name, params, types, returns };
}

const startsFunction = tokens => isWord(tokens[isWord(tokens[0], "export") ? 1 : 0], "function");

// After `maybe`, every property, position, and call step gives unset when its value is unset or null.
function markMaybe(node) {
  if (node.grouped) return;
  if (node.type === "property" || node.type === "index") {
    node.maybe = true;
    markMaybe(node.object);
  } else if (node.type === "invoke") {
    node.maybe = true;
    markMaybe(node.callee.type === "property" ? node.callee.object : node.callee);
  }
}

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

// The functions (with their parameters) and variables a Prose module exports, from its export lines.
function exportsOf(source) {
  const functions = new Map();
  const values = new Set();
  source.replace(/^﻿/, "").split(/\r?\n/).forEach((text, index) => {
    if (!/^export\b/.test(text)) return;
    const tokens = tokenize(text, index + 1);
    if (isWord(tokens[1], "function")) {
      const header = functionHeader(tokens, index + 1);
      functions.set(header.name, header);
    } else if (tokens[1]?.type === "word" && (isWord(tokens[2], "is") || isWord(tokens[2], "as"))) {
      values.add(tokens[1].value);
    }
  });
  return { functions, values };
}

function readExports(use, readModule) {
  if (!readModule) {
    fail(use.line, `To import "${use.source}", compile with a readModule option; the CLI and Vite plugin provide one.`);
  }
  let source;
  try {
    source = readModule(use.source);
  } catch (error) {
    fail(use.line, `Can't read "${use.source}": ${error.message}`);
  }
  try {
    return exportsOf(source);
  } catch (error) {
    fail(use.line, `In "${use.source}", ${error.message}`);
  }
}

class Parser {
  constructor(source, options = {}) {
    this.pos = 0;
    this.lines = source.replace(/^﻿/, "").split(/\r?\n/).flatMap((text, index) => {
      if (!text.trim()) return [];
      const prefix = /^\s*/.exec(text)[0];
      return [{
        line: index + 1,
        indent: prefix.replace(/\t/g, "    ").length,
        tokens: tokenize(text.slice(prefix.length), index + 1)
      }];
    });
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
      const exported = use.source.endsWith(".prose") ? readExports(use, options.readModule) : null;
      for (const name of use.names) {
        const header = exported?.functions.get(name);
        if (header) {
          if (this.functions.has(name)) fail(use.line, `Duplicate function '${name}'.`);
          this.functions.set(name, { ...header, line: use.line });
        } else if (exported && !exported.values.has(name)) {
          fail(use.line, `"${use.source}" doesn't export '${name}'.`);
        } else {
          values.push([name, use.line]);
        }
      }
    }
    for (const header of headers) {
      for (const param of header.params) this.checkVariable(param, header.line);
    }
    for (const [name, line] of values) this.checkVariable(name, line);
  }
  expression(line, tokens = line.tokens) {
    return new Expression(tokens, line.line, this.functions);
  }
  checkVariable(name, line) {
    if (this.functions.has(name)) fail(line, `Variable '${name}' conflicts with a function name.`);
  }
  body(parent, inFunction) {
    const next = this.lines[this.pos];
    if (!next || next.indent <= parent.indent) fail(parent.line, "Expected an indented body.");
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
    if (functions.length > 1 || (functions.length && value?.type === "object")) {
      fail(line.line, "Only one indented body can follow a line.");
    }
    if (functions.length) functions[0].body = this.body(line, true);
    else if (value?.type === "object") this.objectBody(value, line);
  }
  typeDeclaration(expr, line, exported, doc) {
    expr.take("type");
    const name = expr.name();
    if (!/^[A-Z]/.test(name)) fail(line.line, "Type names start with a capital letter, like StreakRun.");
    expr.take("is");
    const value = expr.typeExpression();
    expr.end();
    const fields = value.kind === "object" ? this.typeFields(line) : null;
    return { type: "typeDeclaration", name, exported, doc, value, fields, line: line.line };
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
      if (line.indent > next.indent) fail(line.line, "Unexpected indentation in a type.");
      this.pos++;
      if (line.tokens.length === 1 && line.tokens[0].type === "string") {
        doc = line.tokens[0].value;
        continue;
      }
      const expr = this.expression(line);
      const name = expr.propertyName();
      if (!expr.at("as")) fail(line.line, "Object types contain only fields written as name as type.");
      expr.take("as");
      fields.push({ name, type: expr.typeExpression(), doc });
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
      if (line.indent > indent) fail(line.line, "Unexpected indentation in object body.");
      this.pos++;
      if (line.tokens.length === 1 && line.tokens[0].type === "string") continue;
      const expr = this.expression(line);
      const name = expr.propertyName();
      if (!expr.at("is")) fail(line.line, "Object bodies contain only property definitions: name is value.");
      expr.take("is");
      const value = expr.peek() ? expr.list() : { type: "unset" };
      expr.end();
      this.indentedValue(expr, value, line);
      object.properties.push({ name, value });
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
    } else if (first?.type === "word" &&
        expr.tokens.some((token, index) => index > expr.pos && token.type === "word" &&
          token.value === "is" && expr.tokens[index - 1]?.value !== ":")) {
      const name = expr.variableName();
      let target = { type: "name", value: name, line: expr.line };
      const declaredType = expr.optionalType();
      while (!declaredType && (expr.at(":") || expr.at("."))) {
        if (expr.at(":")) {
          expr.take(":");
          target = { type: "property", object: target, name: expr.propertyName(), line: expr.line };
        } else {
          expr.take(".");
          target = { type: "index", object: target, index: expr.index(), line: expr.line };
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
      if (!["call", "invoke", "new"].includes(value?.type)) {
        fail(expr.line, "Expected assignment, print, return, a string expression, or a function call; this syntax is not supported yet.");
      }
      node = { type: "expression", value };
    }
    expr.end();
    node.line = expr.line;
    const indented = expr.blockFunctions.length ||
      (node.value?.type === "object" && ["assign", "assignTarget", "return"].includes(node.type));
    if (indented && !parent) {
      if (expr.blockFunctions.length) fail(expr.line, "A function with an indented body needs a line of its own, not an inline if.");
    } else if (indented) {
      this.indentedValue(expr, node.value, parent);
    }
    return node;
  }
  block(indent = 0, inFunction = false) {
    const result = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line.line, "Unexpected indentation.");
      this.pos++;
      const expr = this.expression(line);
      const topLevel = indent === 0 && !inFunction;
      const exported = expr.at("export");
      if (exported) {
        if (!topLevel) fail(line.line, "Only top-level functions, variables, and types can be exported.");
        expr.take("export");
      }
      // A quoted comment on the line just above a declaration documents it in generated declarations.
      const previous = result.at(-1);
      const doc = previous?.type === "expression" && previous.line === line.line - 1 &&
        previous.value.type === "literal" && typeof previous.value.value === "string" ? previous.value.value : undefined;
      const declaresType = isWord(expr.peek(), "type") && expr.tokens[expr.pos + 1]?.type === "word" &&
        !isWord(expr.tokens[expr.pos + 1], "is");
      if (expr.at("function")) {
        if (!topLevel) fail(line.line, "Functions must be declared at the top level.");
        const header = functionHeader(line.tokens, line.line);
        result.push({ type: "function", ...header, exported, doc, line: line.line, body: this.body(line, true) });
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
        const branches = [{ condition, body: this.ifBody(expr, line, inFunction) }];
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
            branches.push({ condition, body: this.ifBody(tail, next, inFunction) });
          } else {
            otherwise = this.conditionalBody(tail, next, inFunction);
            break;
          }
        }
        result.push({ type: "if", branches, otherwise });
      } else if (expr.at("while")) {
        expr.take("while");
        const condition = this.condition(expr);
        expr.end();
        result.push({ type: "while", condition, body: this.body(line, inFunction) });
      } else if (expr.at("for")) {
        expr.take("for");
        if (expr.at("each")) {
          expr.take("each");
          const names = expr.names("loop variable");
          expr.take("in");
          const iterable = this.condition(expr, true);
          expr.end();
          result.push({ type: "foreach", names, iterable, line: line.line, body: this.body(line, inFunction) });
        } else {
          const name = expr.variableName();
          expr.take("is");
          const start = this.condition(expr);
          expr.take("to");
          const end = this.condition(expr);
          expr.end();
          result.push({ type: "for", name, start, end, line: line.line, body: this.body(line, inFunction) });
        }
      } else {
        result.push(this.simple(expr, inFunction, line));
      }
    }
    return result;
  }
}

const variable = name => `_prose_${name}`;
const pad = depth => "  ".repeat(depth);

// The variables a body assigns, with the line of each one's first assignment. Nested functions have their own.
function assignedNames(nodes, names = new Map()) {
  for (const node of nodes) {
    const assigned = node.type === "assign" || node.type === "for" ? [node.name] : node.type === "foreach" ? node.names : [];
    for (const name of assigned) if (!names.has(name)) names.set(name, node.line);
    if (node.type === "if") {
      for (const branch of node.branches) assignedNames(branch.body, names);
      assignedNames(node.otherwise, names);
    } else if (node.body && node.type !== "function") {
      assignedNames(node.body, names);
    }
  }
  return names;
}

function createScope(params, body, parent) {
  const locals = assignedNames(body);
  for (const param of params) locals.delete(param);
  return { parent, locals, names: new Set([...params, ...locals.keys()]), imports: new Set() };
}

function resolve(node, scope) {
  for (let current = scope; current; current = current.parent) {
    if (current.names.has(node.value)) return variable(node.value);
  }
  if (javascriptGlobals.has(node.value)) return node.value;
  fail(node.line, `Unknown name '${node.value}'. Assign it before using it, or check the spelling.`);
}

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
  if (type.kind === "union") return type.options.map(inner).join(" | ");
  if (type.kind === "maybe") return `${inner(type.of)} | undefined`;
  if (type.kind === "list") {
    return ["union", "maybe", "function"].includes(type.of.kind) ? `(${typeText(type.of)})[]` : `${typeText(type.of)}[]`;
  }
  if (type.kind === "set") return `Set<${typeText(type.of)}>`;
  if (type.kind === "map") return `Map<${typeText(type.from)}, ${typeText(type.to)}>`;
  if (type.kind === "function") {
    const params = type.params.map((param, index) => `arg${index + 1}: ${typeText(param)}`).join(", ");
    return `(${params}) => ${type.returns ? typeText(type.returns) : "void"}`;
  }
  return type.args.length ? `${type.name}<${type.args.map(typeText).join(", ")}>` : type.name;
}

// The type variables in some types, in order of first appearance, for a generic signature.
function typeVariables(types, found = []) {
  for (const type of types.filter(Boolean)) {
    if (type.kind === "variable" && !found.includes(type.name)) found.push(type.name);
    typeVariables([type.of, type.from, type.to, type.returns, ...(type.options ?? []), ...(type.params ?? []), ...(type.args ?? [])], found);
  }
  return found;
}

const generic = variables => variables.length ? `<${variables.join(", ")}>` : "";
const docComment = (doc, indent = "") => doc ? [`${indent}/** ${doc.replace(/\*\//g, "*\\/")} */`] : [];
// Parameter names only document a declaration, so JavaScript's reserved words get a suffix.
const parameterName = name => /^(?:break|case|catch|class|const|continue|debugger|default|delete|do|enum|extends|finally|implements|import|instanceof|interface|let|package|private|protected|public|static|super|switch|this|throw|try|typeof|var|void|yield)$/.test(name) ? `${name}_` : name;

function literalType(value) {
  if (value?.type !== "literal") return "any";
  return value.value === null ? "null" : typeof value.value;
}

// A TypeScript declaration file for a module's exports, or null when it exports nothing.
function declarationsFor(program) {
  if (!program.some(node => node.exported)) return null;
  const lines = ["// Generated by Prose from the .prose file of the same name. Edit that file instead."];
  for (const use of program.filter(node => node.type === "use" && node.typeOnly)) {
    lines.push(`import type { ${use.names.join(", ")} } from ${JSON.stringify(use.source)};`);
  }
  for (const node of program) {
    if (node.type === "function" && node.exported) {
      // Trailing parameters that are untyped or maybe can be left out, as Prose's with calls allow.
      let optionalFrom = node.params.length;
      while (optionalFrom > 0 && (!node.types[optionalFrom - 1] || node.types[optionalFrom - 1].kind === "maybe")) optionalFrom--;
      const params = node.params.map((name, index) => {
        const type = node.types[index];
        if (index < optionalFrom) return `${parameterName(name)}: ${typeText(type)}`;
        return `${parameterName(name)}?: ${typeText(type?.kind === "maybe" ? type.of : type)}`;
      });
      const variables = typeVariables([...node.types, node.returns]);
      lines.push(...docComment(node.doc),
        `export function ${node.name}${generic(variables)}(${params.join(", ")}): ${typeText(node.returns)};`);
    } else if (node.type === "assign" && node.exported) {
      lines.push(...docComment(node.doc),
        `export let ${node.name}: ${node.declaredType ? typeText(node.declaredType) : literalType(node.value)};`);
    } else if (node.type === "typeDeclaration") {
      const prefix = node.exported ? "export " : "";
      if (node.fields) {
        lines.push(...docComment(node.doc), `${prefix}interface ${node.name}${generic(typeVariables(node.fields.map(field => field.type)))} {`);
        for (const field of node.fields) {
          const optional = field.type.kind === "maybe";
          lines.push(...docComment(field.doc, "  "), `  ${field.name}${optional ? "?" : ""}: ${typeText(optional ? field.type.of : field.type)};`);
        }
        lines.push("}");
      } else {
        lines.push(...docComment(node.doc), `${prefix}type ${node.name}${generic(typeVariables([node.value]))} = ${typeText(node.value)};`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Compile Prose to JavaScript: a script, or an ES module if it uses modules or imports its runtime.
 * `declarations` is a TypeScript declaration file for the module's exports, or null.
 */
export function compile(source, options = {}) {
  const program = new Parser(source, options).block();
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
    if (exports.has(node.name)) fail(node.line, `'${node.name}' is already exported.`);
    exports.set(node.name, variable(node.name));
  }
  let loopId = 0;

  function expression(node, scope, depth) {
    const emit = child => expression(child, scope, depth);
    const list = nodes => `[${nodes.map(emit).join(", ")}]`;
    if (node.type === "literal") return JSON.stringify(node.value);
    if (node.type === "unset") return "undefined";
    if (node.type === "name") return resolve(node, scope);
    if (node.type === "array") return list(node.elements);
    if (node.type === "object") {
      return `({${node.properties.map(property => `[${JSON.stringify(property.name)}]: ${emit(property.value)}`).join(", ")}})`;
    }
    if (node.type === "property") {
      if (node.maybe) return `__prose_maybe_property(${emit(node.object)}, ${JSON.stringify(node.name)})`;
      return `__prose_property(${emit(node.object)}, ${JSON.stringify(node.name)}, ${node.line})`;
    }
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
        return `${helper}method(${emit(node.callee.object)}, ${JSON.stringify(node.callee.name)}, ${args}, ${node.line})`;
      }
      return `${helper}call(${emit(node.callee)}, ${args}, ${node.line})`;
    }
    if (node.type === "new") return `__prose_new(${emit(node.callee)}, ${list(node.args)}, ${node.line})`;
    if (node.type === "conditional") return `(${emit(node.condition)} ? ${emit(node.then)} : ${emit(node.otherwise)})`;
    if (node.type === "lambda") {
      const inner = createScope(node.params, node.body ?? [], scope);
      const params = node.params.map(variable).join(", ");
      if (node.body) return `((${params}) => {\n${emitScope(node.body, inner, depth + 1)}\n${pad(depth)}})`;
      return `((${params}) => ${expression(node.value, inner, depth)})`;
    }
    if (node.type === "unary") {
      return `(${node.op === "not" ? "!" : "-"}${emit(node.operand)})`;
    }
    if (node.op === "mod") return `__prose_mod(${emit(node.left)}, ${emit(node.right)}, ${node.line})`;
    const op = { "=": "===", "!=": "!==", and: "&&", or: "||", otherwise: "??" }[node.op] ?? node.op;
    return `(${emit(node.left)} ${op} ${emit(node.right)})`;
  }

  function reference(target, scope, depth) {
    if (target.type === "name") {
      const name = rebindable(target, scope);
      return `({get: () => ${name}, set: __value => { ${name} = __value; }})`;
    }
    if (target.type === "property") {
      return `__prose_property_ref(${expression(target.object, scope, depth)}, ${JSON.stringify(target.name)}, ${target.line})`;
    }
    return `__prose_index_ref(${reference(target.object, scope, depth)}, () => ${expression(target.index, scope, depth)}, ${target.line})`;
  }

  function emitBlock(nodes, scope, depth) {
    const indent = pad(depth);
    const emit = node => expression(node, scope, depth);
    return nodes.filter(node => node.type !== "use" && node.type !== "typeDeclaration").map(node => {
      if (node.type === "function") {
        const inner = createScope(node.params, node.body, scope);
        return `${indent}function ${variable(node.name)}(${node.params.map(variable).join(", ")}) {\n${emitScope(node.body, inner, depth + 1)}\n${indent}}`;
      }
      if (node.type === "assign") return `${indent}${variable(node.name)} = ${emit(node.value)};`;
      // Rebuilding a string assigns its binding; mutating an object property does not.
      if (node.type === "assignTarget") return `${indent}${reference(node.target, scope, depth)}.set(${emit(node.value)});`;
      if (node.type === "print") return `${indent}console.log(${emit(node.value)});`;
      if (node.type === "return") return `${indent}return${node.value ? " " + emit(node.value) : ""};`;
      if (node.type === "expression") return `${indent}(${emit(node.value)});`;
      if (node.type === "if") {
        const branches = node.branches.map((branch, index) =>
          `${indent}${index ? "else if" : "if"} (${emit(branch.condition)}) {\n${emitBlock(branch.body, scope, depth + 1)}\n${indent}}`
        ).join(" ");
        return branches + (node.otherwise.length
          ? ` else {\n${emitBlock(node.otherwise, scope, depth + 1)}\n${indent}}` : "");
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
    }).join("\n");
  }

  function emitScope(nodes, scope, depth) {
    const locals = [...scope.locals.keys()];
    const declarations = locals.length ? `${pad(depth)}let ${locals.map(variable).join(", ")};\n` : "";
    return declarations + emitBlock(nodes, scope, depth);
  }

  const body = emitScope(program, programScope, 0);
  const module = Boolean(options.runtime) || imports.length > 0 || exports.size > 0 ||
    program.some(node => node.typeOnly || (node.type === "typeDeclaration" && node.exported));
  const code = [
    module ? "" : '"use strict";',
    options.runtime ? `import { ${runtimeHelpers.join(", ")} } from ${JSON.stringify(options.runtime)};` : "",
    ...imports.map(node =>
      `import { ${node.names.map(name => `${name} as ${variable(name)}`).join(", ")} } from ${JSON.stringify(node.source)};`),
    options.runtime ? "" : runtimeSource,
    body,
    exports.size ? `export { ${[...exports].map(([name, local]) => `${local} as ${name}`).join(", ")} };` : ""
  ].filter(Boolean).join("\n") + "\n";
  return { code, module, declarations: declarationsFor(program) };
}

/**
 * Compile the supported Prose subset into JavaScript. Pass `runtime` (a module path) to import
 * the runtime helpers instead of embedding them, and `readModule(path)` to return the source of
 * an imported `.prose` file so its functions can be called like local ones.
 */
export function transpile(source, options = {}) {
  return compile(source, options).code;
}
