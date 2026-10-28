import { runtimeHelpers, runtimeSource } from "./runtime.js";

const reserved = new Set([
  "if", "else", "for", "is", "to", "print", "and", "or", "not",
  "true", "false", "null", "remainder", "function", "return", "while",
  "async", "await", "takes", "run", "mod", "object", "array",
  "with", "new", "each", "in", "then", "use", "export", "unset", "otherwise", "maybe"
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

function tokenize(text, line) {
  const tokens = [];
  let pos = 0;
  while (pos < text.length) {
    if (/\s/.test(text[pos])) { pos++; continue; }
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
  }
  // Parentheses end any surrounding argument list, so commas inside them are unambiguous.
  inParentheses(parse) {
    const depth = this.argumentDepth;
    this.argumentDepth = 0;
    const value = parse();
    this.argumentDepth = depth;
    return value;
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
      fail(this.line, "Inside another call's arguments, a call with several arguments after 'with' needs parentheses: (f with a, b).");
    }
    // Readers split `f with a, b + 1` both ways, so neither reading is chosen silently.
    const next = this.peek();
    if ((next?.type === "symbol" && "+-*/%".includes(next.value)) || isWord(next, "mod")) {
      fail(this.line, `'${next.value}' right after 'with' arguments is ambiguous. Put the last argument in parentheses to include it, or the whole call to use its result.`);
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
      for (let index = 0; index < params.length; index++) {
        if (index) this.take(",");
        // Calls bind before arithmetic; compound arguments require parentheses.
        args.push(this.parse(60));
      }
      this.argumentDepth--;
    }
    return { type: "call", name, args, builtin, line: this.line };
  }
  lambda() {
    const node = { type: "lambda", params: [], line: this.line };
    if (this.at("takes")) {
      this.take("takes");
      node.params = this.names("parameter");
    }
    if (this.at("return")) {
      this.take("return");
      node.value = this.parse();
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
      if (this.at("with")) { this.take("with"); args.push(...this.arguments()); }
      left = { type: "new", callee, args, line: this.line };
    } else if (token.value === "not" || token.value === "-") {
      left = { type: "unary", op: token.value, operand: this.parse(token.value === "not" ? 25 : 60) };
    } else if (token.value === "remainder") {
      left = { type: "binary", op: "%", left: this.parse(60), right: this.parse(60) };
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
  const params = [];
  if (expr.at("takes")) {
    expr.take("takes");
    params.push(expr.name());
    while (expr.at(",")) { expr.take(","); params.push(expr.name()); }
  }
  expr.end();
  if (new Set(params).size !== params.length) fail(line, "Duplicate parameter name.");
  return { name, params };
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
  const names = expr.names("imported");
  if (!expr.at("from")) fail(line, "Expected 'from' and a quoted module path.");
  expr.take("from");
  const source = expr.tokens[expr.pos++];
  if (source?.type !== "string") fail(line, "Expected a quoted module path after 'from'.");
  expr.end();
  return { type: "use", names, source: source.value, line };
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
    } else if (tokens[1]?.type === "word" && isWord(tokens[2], "is")) {
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
  // Reads the indented lines after a line: an object literal's properties or a function's body.
  indentedValue(expr, value, line) {
    const functions = expr.blockFunctions;
    if (functions.length > 1 || (functions.length && value?.type === "object")) {
      fail(line.line, "Only one indented body can follow a line.");
    }
    if (functions.length) functions[0].body = this.body(line, true);
    else if (value?.type === "object") this.objectBody(value, line);
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
      while (expr.at(":") || expr.at(".")) {
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
        ? { type: "assign", name, value }
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
        if (!topLevel) fail(line.line, "Only top-level functions and variables can be exported.");
        expr.take("export");
      }
      if (expr.at("function")) {
        if (!topLevel) fail(line.line, "Functions must be declared at the top level.");
        const header = functionHeader(line.tokens, line.line);
        result.push({ type: "function", ...header, exported, line: line.line, body: this.body(line, true) });
      } else if (exported) {
        const node = this.simple(expr, inFunction, line);
        if (node.type !== "assign") fail(line.line, "Only functions and variables can be exported.");
        result.push({ ...node, exported });
      } else if (expr.at("use")) {
        if (!topLevel) fail(line.line, "'use' is only allowed at the top level.");
        result.push(useStatement(line.tokens, line.line));
      } else if (expr.at("if")) {
        expr.take("if");
        const condition = this.condition(expr);
        const branches = [{ condition, body: this.conditionalBody(expr, line, inFunction) }];
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
            branches.push({ condition, body: this.conditionalBody(tail, next, inFunction) });
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

/** Compile Prose to JavaScript: a script, or an ES module if it uses modules or imports its runtime. */
export function compile(source, options = {}) {
  const program = new Parser(source, options).block();
  const imports = program.filter(node => node.type === "use");
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
  for (const node of program.filter(node => node.exported)) {
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
    return nodes.filter(node => node.type !== "use").map(node => {
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
  const module = Boolean(options.runtime) || imports.length > 0 || exports.size > 0;
  const code = [
    module ? "" : '"use strict";',
    options.runtime ? `import { ${runtimeHelpers.join(", ")} } from ${JSON.stringify(options.runtime)};` : "",
    ...imports.map(node =>
      `import { ${node.names.map(name => `${name} as ${variable(name)}`).join(", ")} } from ${JSON.stringify(node.source)};`),
    options.runtime ? "" : runtimeSource,
    body,
    exports.size ? `export { ${[...exports].map(([name, local]) => `${local} as ${name}`).join(", ")} };` : ""
  ].filter(Boolean).join("\n") + "\n";
  return { code, module };
}

/**
 * Compile the supported Prose subset into JavaScript. Pass `runtime` (a module path) to import
 * the runtime helpers instead of embedding them, and `readModule(path)` to return the source of
 * an imported `.prose` file so its functions can be called like local ones.
 */
export function transpile(source, options = {}) {
  return compile(source, options).code;
}
