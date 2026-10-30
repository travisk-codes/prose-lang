import { runtimeHelpers, runtimeSource } from "./runtime.js";
import { checkPrelude } from "./check.js";
import { inlineSourceMap, sourceMapBuilder } from "./source-map.js";
import { callScopeKey, inferCallArities } from "./call-arity.js";
import { explainLayoutError } from "./layout-diagnostics.js";

const reserved = new Set([
  "if", "else", "for", "is", "to", "print", "and", "or", "not",
  "true", "false", "null", "remainder", "function", "return", "while",
  "async", "await", "takes", "run", "mod", "object", "array",
  "with", "new", "each", "in", "then", "use", "export", "unset", "otherwise", "maybe",
  "as", "giving", "are", "skip", "stop", "try", "fail", "xor"
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
  "requestAnimationFrame", "sessionStorage", "window", "Buffer", "process",
  "AggregateError", "DOMException", "Element", "HTMLButtonElement", "HTMLCanvasElement", "HTMLElement",
  "HTMLImageElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "KeyboardEvent",
  "MouseEvent", "Node", "PointerEvent"
]);

// Prose names are snake_case and JavaScript's are camelCase, so a name of lowercase words joined
// by underscores (same_tag_name, to_locale_lower_case) is camelCase wherever JavaScript sees it.
const snakeName = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const plainCamel = name => name.replace(/_([a-z0-9])/g, (all, letter) => letter.toUpperCase());
// JavaScript's own names that capitalize a whole acronym, by how their words would otherwise join.
const acronymNames = new Map([
  "randomUUID", "toISOString", "toUTCString", "getUTCFullYear", "getUTCMonth", "getUTCDate",
  "getUTCDay", "getUTCHours", "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds",
  "setUTCFullYear", "setUTCMonth", "setUTCDate", "setUTCHours", "setUTCMinutes", "setUTCSeconds",
  "setUTCMilliseconds", "innerHTML", "outerHTML", "insertAdjacentHTML", "createObjectURL",
  "revokeObjectURL", "readAsDataURL", "toDataURL", "encodeURI", "decodeURI", "encodeURIComponent",
  "decodeURIComponent", "toJSON", "baseURI", "documentURI", "responseURL", "responseXML", "indexedDB"
].map(name => [plainCamel(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase()), name]));

export function camel(name) {
  if (!snakeName.test(name)) return name;
  const plain = plainCamel(name);
  return acronymNames.get(plain) ?? plain;
}

// The kinds of value `is a` can test for, besides classes such as Error.
const typeTests = {
  text: value => `typeof ${value} === "string"`,
  number: value => `typeof ${value} === "number"`,
  boolean: value => `typeof ${value} === "boolean"`,
  function: value => `typeof ${value} === "function"`,
  list: value => `Array.isArray(${value})`,
  object: value => `__prose_is_object(${value})`
};

function fail(line, message, details) {
  const error = new SyntaxError(`Line ${line}: ${message}`);
  error.line = line;
  if (details) Object.assign(error, details);
  throw error;
}

const isWord = (token, value) => token?.type === "word" && token.value === value;

// Locations are metadata, excluded from syntax comparisons used by the formatter.
function located(node, token) {
  if (token?.source) Object.defineProperty(node, "location", { value: token.source, configurable: true });
  return node;
}

// Prose's words for TypeScript's basic types.
const builtinTypes = {
  text: "string", number: "number", boolean: "boolean", any: "any", unknown: "unknown",
  nothing: "void", unset: "undefined", null: "null", true: "true", false: "false"
};

function tokenize(text, line, locations = false) {
  const tokens = [];
  let pos = 0;
  while (pos < text.length) {
    if (/\s/.test(text[pos])) { pos++; continue; }
    // Spacing only matters to tell `f -1` (a negative argument) from `f - 1`.
    const spaced = pos > 0 && /\s/.test(text[pos - 1]);
    const tokenStart = pos;
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
      if (isWord(tokens.at(-1), "pattern")) {
        // After `pattern` the text is a regular expression, kept as typed except that \" is a quote.
        const pattern = tokens.at(-1);
        tokens[tokens.length - 1] = { type: "pattern", value: text.slice(start + 1, pos - 1).replace(/\\(.)/g, (all, char) => char === '"' ? '"' : all) };
        if (locations) tokens.at(-1).source = { raw: `pattern ${text.slice(start, pos)}`, line, start: pattern.source.start };
        continue;
      }
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
    if (locations) tokens.at(-1).source = { raw: text.slice(tokenStart, pos), line, start: tokenStart };
  }
  return tokens;
}

const precedence = {
  or: 10, otherwise: 10, and: 20,
  "=": 30, "!=": 30, "<": 30, ">": 30, "<=": 30, ">=": 30,
  "+": 40, "-": 40, "*": 50, "/": 50, "%": 50, mod: 50, xor: 50
};

class Expression {
  constructor(tokens, line, functions = new Map(), callAnalysis = null, callScope = null, loose = true) {
    this.tokens = tokens; this.line = line; this.functions = functions; this.pos = 0;
    this.callAnalysis = callAnalysis; this.callScope = callScope; this.loose = loose;
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
    if (this.shiftAt()) return false;
    const next = this.peek();
    if (isWord(next, "if") && this.trailingIf()) return false;
    if (next.type === "symbol" && next.value === "-" && next.spaced && this.tokens[this.pos + 1] && !this.tokens[this.pos + 1].spaced) {
      if (!this.loose) fail(this.line, "'-' here could start a negative argument or subtract. Write with before a negative argument (items:at with -1), or put spaces around a minus that subtracts.");
      return true;
    }
    if (next.type === "number" || next.type === "string") return true;
    if (next.type === "symbol") return next.value === "(";
    if (next.type === "pattern") return true;
    return !reserved.has(next.value) ||
      ["function", "if", "new", "not", "maybe", "array", "object", "unset", "true", "false", "null", "each"].includes(next.value);
  }
  // An inline object's entries: `name is value`, a bare name, or `like other`. Like a call, it takes every comma.
  objectEntries() {
    const depth = this.argumentDepth;
    const adjacent = this.adjacentValues;
    this.argumentDepth = depth + 1;
    this.adjacentValues = 0;
    const properties = [this.objectEntry()];
    while (this.at(",")) {
      this.take(",");
      properties.push(this.objectEntry());
    }
    this.argumentDepth = depth;
    this.adjacentValues = adjacent;
    return properties;
  }
  objectEntry() {
    const named = isWord(this.tokens[this.pos + 1], "is");
    if (this.at("like") && !named) {
      this.take("like");
      return { spread: true, value: this.parse(60), line: this.line };
    }
    if (named) {
      const name = this.propertyName();
      this.take("is");
      return { name, value: this.parse() };
    }
    if (this.peek()?.type !== "word") fail(this.line, "Expected an object entry: name is value, a name, or like another object.");
    const name = this.variableName();
    return { name, value: { type: "name", value: name, line: this.line } };
  }
  // Whether `object` is followed by entries on its line, rather than ending or leading into other syntax.
  startsObjectEntries() {
    const next = this.peek();
    return next?.type === "word" &&
      (next.value === "like" || !reserved.has(next.value) || isWord(this.tokens[this.pos + 1], "is"));
  }
  peek() { return this.tokens[this.pos]; }
  at(value) {
    const token = this.peek();
    return token?.value === value && (token.type === "word" || token.type === "symbol");
  }
  // `f if ready then a else b` passes a prefix conditional to f. Without a
  // top-level `then`, `f value if ready else b` selects the whole call's result.
  trailingIf() {
    if (!this.at("if")) return false;
    let depth = 0;
    for (let pos = this.pos + 1; pos < this.tokens.length; pos++) {
      const token = this.tokens[pos];
      if (token.type === "symbol" && token.value === "(") { depth++; continue; }
      if (token.type === "symbol" && token.value === ")") {
        if (!depth) break;
        depth--;
        continue;
      }
      if (depth || token.type !== "word" || [".", ":"].includes(this.tokens[pos - 1]?.value)) continue;
      if (token.value === "then") return false;
      if (token.value === "else") break;
    }
    return true;
  }
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
    if (token?.type !== "word") fail(this.line, "Expected a property name after an accessor, or before 'is' in an object body.");
    return token.value;
  }
  // Bare words after a dot can index a list or text using a numeric variable.
  // Their spelling stays literal on other receivers.
  dotStep(object) {
    if (this.at("(")) {
      this.take("(");
      const key = this.inParentheses(() => this.parse());
      this.take(")");
      return { type: "property", object, key, contextual: true, line: this.line };
    }
    if (this.peek()?.type === "word") {
      return { type: "property", object, name: this.propertyName(), contextual: true, line: this.line };
    }
    return { type: "index", object, index: this.index(), line: this.line };
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
  arguments(explicit = true) {
    const first = this.peek();
    const nested = this.argumentDepth > 0;
    this.argumentDepth++;
    const args = [this.parse(60)];
    if (!explicit && this.at(",") && !this.loose) {
      fail(this.tokens[this.pos].source?.line ?? this.line,
        "This call's parameter count is unknown, so the comma could separate arguments or array elements. Use with for arguments, or close the call in parentheses before the comma.",
        { code: "PROSE_CALL_BOUNDARY", callBoundary: first?.source && { line: first.source.line, column: first.source.start, text: "with " } });
    }
    while (this.at(",")) { this.take(","); args.push(this.parse(60)); }
    this.argumentDepth--;
    if (nested && args.length > 1 && !this.loose) {
      fail(this.line, "Inside another call's arguments, a call with several arguments needs parentheses: (f a, b).");
    }
    if (explicit) this.noArithmeticAfterArguments();
    return args;
  }
  // Readers split `f a, b + 1` both ways, so neither reading is chosen silently.
  noArithmeticAfterArguments() {
    if (this.loose) return;
    const next = this.peek();
    if ((next?.type === "symbol" && "+-*/%".includes(next.value)) || isWord(next, "mod") || isWord(next, "xor") || this.shiftAt()) {
      fail(this.line, `'${next.value}' right after a call's arguments is ambiguous. Put the last argument in parentheses to include it, or the whole call to use its result.`);
    }
  }
  call(name, signature = this.functions.get(name), callee = null) {
    const { params, builtin } = signature;
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
      // One argument reads naturally (length items + 1); after several, `f a, b + 1` is split both ways.
      if (params.length > 1) this.noArithmeticAfterArguments();
    }
    if (args.some(arg => arg.type === "spread")) {
      fail(this.line, `'${name}' takes a fixed number of arguments, so 'each of' can't spread a list into it.`);
    }
    return callee ? { type: "invoke", callee, args, line: this.line } : { type: "call", name, args, builtin, line: this.line };
  }
  calleeArity(node) {
    if (node.type === "name") return this.callScope?.lookup(node.value) ?? this.functions.get(node.value)?.params.length ?? null;
    if (node.type === "lambda") return node.params.length;
    if (node.type === "conditional") {
      const left = this.calleeArity(node.then), right = this.calleeArity(node.otherwise);
      return left === right ? left : null;
    }
    return null;
  }
  startsArguments() {
    const next = this.peek();
    if (!next) return false;
    if (this.at("if") && this.trailingIf()) return false;
    return ["number", "string", "pattern"].includes(next.type) || next.type === "symbol" && ["(", "-"].includes(next.value) ||
      next.type === "word" && (!reserved.has(next.value) || ["function", "if", "new", "not", "maybe", "array", "object", "unset", "true", "false", "null", "each"].includes(next.value));
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
    const token = this.peek();
    const options = [this.singleType()];
    while (this.at("or")) { this.take("or"); options.push(this.singleType()); }
    return located(options.length === 1 ? options[0] : { kind: "union", options }, token);
  }
  singleType() {
    const token = this.tokens[this.pos++];
    if (!token) fail(this.line, "Expected a type.");
    if (token.type === "string" || token.type === "number") return { kind: "literal", value: token.value };
    if (token.value === "(") {
      const inner = this.typeExpression();
      // Commas make a tuple, like Prose's own lists: (text, number) is [string, number].
      if (this.at(",")) {
        const items = [inner];
        while (this.at(",")) { this.take(","); items.push(this.typeExpression()); }
        this.take(")");
        return { kind: "tuple", items };
      }
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
      // A type inside a namespace, such as Intl.DateTimeFormatOptions.
      let name = word;
      while (this.at(":") || this.at(".")) {
        this.pos++;
        name += "." + this.propertyName();
      }
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
      return { kind: "named", name, args };
    }
    if (reserved.has(word)) fail(this.line, `Expected a type, not '${word}'.`);
    // Other lowercase names are type variables, like T in TypeScript.
    return { kind: "variable", name: word };
  }
  // `pattern "..."` with optional flag words; the pattern is checked now, so mistakes report their line.
  pattern(source) {
    let flags = "u";
    while (true) {
      if (this.at("everywhere")) { this.take("everywhere"); flags += "g"; }
      else if (this.at("ignoring") && isWord(this.tokens[this.pos + 1], "case")) { this.pos += 2; flags += "i"; }
      else if (this.at("by") && isWord(this.tokens[this.pos + 1], "line")) { this.pos += 2; flags += "m"; }
      else break;
    }
    let regex;
    try {
      regex = new RegExp(source, flags);
    } catch (error) {
      fail(this.line, `This pattern isn't a valid regular expression: ${error.message}`);
    }
    return { type: "pattern", literal: `/${regex.source}/${regex.flags}` };
  }
  lambda(token) {
    const { names, types, returns } = this.parameters();
    const node = { type: "lambda", params: names, types, returns, line: this.line };
    Object.defineProperty(node, "callScopeKey", { value: callScopeKey(token) });
    if (this.at("return")) {
      this.take("return");
      // A function's result is its own expression, even inside a Prose call's arguments.
      const adjacent = this.adjacentValues;
      const scope = this.callScope;
      this.callScope = this.callAnalysis?.scopes.get(node.callScopeKey) ?? null;
      this.adjacentValues = 0;
      node.value = this.parse();
      this.adjacentValues = adjacent;
      this.callScope = scope;
    } else {
      node.body = [];
      this.blockFunctions.push(node);
    }
    return node;
  }
  // `shifted left by` and `shifted right by`, as the JavaScript operator each one is.
  shiftAt() {
    if (!this.at("shifted") || !isWord(this.tokens[this.pos + 2], "by")) return null;
    const direction = this.tokens[this.pos + 1];
    return isWord(direction, "left") ? "<<" : isWord(direction, "right") ? ">>>" : null;
  }
  // `value is a text`, `value is not a list`, `reason is an Error`.
  startsTypeTest() {
    if (!this.at("is")) return false;
    const next = this.tokens[this.pos + 1];
    const article = isWord(next, "not") ? this.tokens[this.pos + 2] : next;
    return isWord(article, "a") || isWord(article, "an");
  }
  typeTest(value) {
    this.take("is");
    const negated = this.at("not");
    if (negated) this.take("not");
    const article = this.tokens[this.pos++].value;
    const token = this.tokens[this.pos++];
    if (token?.type === "word" && Object.hasOwn(typeTests, token.value)) {
      return { type: "typeTest", value, kind: token.value, negated, line: this.line };
    }
    if (token?.type !== "word" || !/^[A-Z]/.test(token.value)) {
      fail(this.line, `Expected a kind of value after '${article}': text, number, boolean, function, list, object, or a class such as Error.`);
    }
    let kind = { type: "name", value: token.value, line: this.line };
    while (this.at(":") || this.at(".")) {
      this.pos++;
      kind = { type: "property", object: kind, name: this.propertyName(), line: this.line };
    }
    return { type: "typeTest", value, kind, negated, line: this.line };
  }
  parse(min = 0) {
    const token = this.peek();
    return located(this.parseValue(min), token);
  }
  parseValue(min = 0) {
    const token = this.tokens[this.pos++];
    if (!token) fail(this.line, "Expected an expression.");
    let left;
    if (token.type === "number" || token.type === "string") {
      left = { type: "literal", value: token.value };
    } else if (token.type === "pattern") {
      left = this.pattern(token.value);
    } else if (token.value === "(") {
      left = this.inParentheses(() => this.list(true));
      this.take(")");
      left.grouped = true;
    } else if (token.value === "array") {
      left = { type: "array", elements: [] };
    } else if (token.value === "object") {
      left = { type: "object", properties: [] };
      if (this.startsObjectEntries()) {
        left.properties = this.objectEntries();
        left.inline = true;
      }
    } else if (token.value === "each") {
      this.take("of");
      left = { type: "spread", value: this.parse(60), line: this.line };
    } else if (token.value === "unset") {
      left = { type: "unset" };
    } else if (token.value === "maybe") {
      left = this.parse(70);
      markMaybe(left);
    } else if (token.value === "function") {
      left = this.lambda(token);
    } else if (token.value === "if") {
      const condition = this.parse();
      this.take("then");
      const then = this.parse();
      this.take("else");
      left = { type: "conditional", condition, then, otherwise: this.parse() };
    } else if (token.value === "new") {
      let callee = { type: "name", value: this.name(), line: this.line };
      while (this.at(":") || this.at(".")) {
        const dot = this.at(".");
        this.pos++;
        callee = dot ? this.dotStep(callee)
          : { type: "property", object: callee, name: this.propertyName(), line: this.line };
      }
      const args = [];
      if (this.at("with")) {
        const count = this.calleeArity(callee);
        if (count === null) { this.take("with"); args.push(...this.arguments()); }
        else args.push(...this.call(callee.value ?? "constructor", { params: new Array(count) }, callee).args);
      } else if (this.peek() && this.callsByAdjacency({ type: "name" })) {
        const count = this.calleeArity(callee);
        args.push(...(count === null ? this.arguments(false) : this.call(callee.value ?? "constructor", { params: new Array(count) }, callee).args));
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
    } else if (isWord(token, "wait") && this.at("for")) {
      // `wait for` waits for a promise; the function it's in becomes asynchronous.
      this.take("for");
      left = { type: "await", value: this.parse(60), line: this.line };
    } else if (token.type === "word" && !reserved.has(token.value)) {
      left = located({ type: "name", value: token.value, line: this.line }, token);
      const count = this.calleeArity(left);
      if (count !== null && (this.functions.get(token.value)?.builtin || this.at("with") || this.at("run") || count > 0 && this.startsArguments())) {
        left = this.functions.has(token.value) ? this.call(token.value)
          : this.call(token.value, { params: new Array(count) }, left);
      }
    } else {
      fail(this.line, `Unexpected token ${JSON.stringify(token.value)} in expression.`);
    }
    while (this.peek()) {
      // A trailing conditional binds below calls, arithmetic, and logic. An
      // argument reader leaves it for the surrounding call to consume.
      if (this.trailingIf()) {
        if (min > 5) break;
        if (left.type === "conditional" && left.postfix && !left.grouped) {
          fail(this.line, "Nested trailing if expressions need parentheses.");
        }
        this.take("if");
        const condition = this.parse(6);
        this.take("else");
        left = { type: "conditional", condition, then: left, otherwise: this.parse(6), postfix: true };
        continue;
      }
      if (this.at(":") && min <= 70) {
        this.take(":");
        if (this.at("(")) {
          // A computed property: settings:(name) is the property named by name's value.
          this.take("(");
          const key = this.inParentheses(() => this.parse());
          this.take(")");
          left = { type: "property", object: left, key, line: this.line };
        } else {
          left = { type: "property", object: left, name: this.propertyName(), line: this.line };
        }
        continue;
      }
      if (this.at(".") && min <= 70) {
        this.take(".");
        left = this.dotStep(left);
        continue;
      }
      if (this.at("with") && min <= 70) {
        const count = this.calleeArity(left);
        if (count === null) {
          this.take("with");
          left = { type: "invoke", callee: left, args: this.arguments(), line: this.line };
        } else left = this.call(left.value ?? "function", { params: new Array(count) }, left);
        continue;
      }
      if (this.at("run") && min <= 70) {
        const count = this.calleeArity(left);
        if (count !== null && count > 0) fail(this.line, `This function takes ${count} argument${count === 1 ? "" : "s"}; run supplies none.`);
        this.take("run");
        left = { type: "invoke", callee: left, args: [], line: this.line };
        continue;
      }
      if (min <= 70 && this.callsByAdjacency(left)) {
        this.adjacentCall = true;
        const count = this.calleeArity(left);
        left = count === null ? { type: "invoke", callee: left, args: this.arguments(false), line: this.line }
          : this.call(left.value ?? "function", { params: new Array(count) }, left);
        continue;
      }
      // Type tests rank with comparisons, and shifts with multiplication.
      if (min <= 30 && this.startsTypeTest()) {
        left = this.typeTest(left);
        continue;
      }
      const shift = this.shiftAt();
      if (shift && min <= 50) {
        this.pos += 3;
        left = { type: "binary", op: shift, left, right: this.parse(51), line: this.line };
        continue;
      }
      const next = this.peek();
      const operator = (next.type === "word" || next.type === "symbol") && Object.hasOwn(precedence, next.value);
      const priority = operator ? precedence[next.value] : undefined;
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

// Endings that carry a line on to the next, more indented one: a comma or an operator.
const continuingSymbols = new Set([",", "+", "-", "*", "/", "%", "=", "!=", "<", ">", "<=", ">="]);
const continuingWords = new Set(["and", "or", "otherwise", "mod", "xor", "is", "are", "with", "giving", "of", "by", "return", "takes"]);

export function continues(tokens) {
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "symbol" && token.value === "(") depth++;
    else if (token.type === "symbol" && token.value === ")") depth--;
  }
  const last = tokens.at(-1);
  const conditionalEnd = last.type === "word" && ["if", "else"].includes(last.value) && tokens.length > 1 &&
    ![".", ":"].includes(tokens.at(-2)?.value);
  return depth > 0 || (last.type === "symbol" && continuingSymbols.has(last.value)) ||
    (last.type === "word" && continuingWords.has(last.value)) || conditionalEnd;
}

// Exclude object/type fields named `if` or `while` from conditional headers.
function conditionStart(tokens) {
  const start = isWord(tokens[0], "if") || isWord(tokens[0], "while") ? 1
    : isWord(tokens[0], "else") && isWord(tokens[1], "if") ? 2 : 0;
  return !start || ["is", "as"].some(word => isWord(tokens[start], word)) ? 0 : start;
}

// Once function argument counts are known, make sure no inline body has started.
function conditionOnly(line, functions, analysis, scope, loose) {
  const start = conditionStart(line.tokens);
  if (!start) return false;
  const expr = new Expression(line.tokens.slice(start), line.line, functions, analysis, scope, loose);
  expr.parse();
  return !expr.peek() && !expr.blockFunctions.length;
}

// Locate the value in an expression statement, assignment, return, or print.
// Block headers must retain their indented bodies, including nested if blocks.
const blockHeaders = new Set(["if", "else", "while", "for", "function", "type", "use", "try", "on", "skip", "stop"]);
function valueStart(tokens) {
  const start = isWord(tokens[0], "export") ? 1 : 0;
  const field = isWord(tokens[start + 1], "is") || isWord(tokens[start + 1], "as");
  if (!field && blockHeaders.has(tokens[start]?.value)) return -1;
  if (!field && ["return", "print", "fail"].some(word => isWord(tokens[start], word))) {
    return start + 1 < tokens.length ? start + 1 : -1;
  }
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].type === "symbol" && tokens[i].value === "(") depth++;
    else if (tokens[i].type === "symbol" && tokens[i].value === ")") depth--;
    else if (!depth && isWord(tokens[i], "is") && ![".", ":"].includes(tokens[i - 1]?.value)) return i + 1;
  }
  return start;
}

function valueOnly(line, functions, analysis, scope, loose) {
  const start = valueStart(line.tokens);
  if (start < 0 || start >= line.tokens.length) return false;
  const expr = new Expression(line.tokens.slice(start), line.line, functions, analysis, scope, loose);
  const value = expr.list();
  const objectBody = value.type === "object" && !value.inline && !value.grouped;
  return !expr.peek() && !expr.blockFunctions.length && !objectBody;
}

// Before signatures are known, recognize pending lambda bodies conservatively.
function canWrapValue(line) {
  try { return valueOnly(line); }
  catch {
    const start = valueStart(line.tokens);
    return start >= 0 && !line.tokens.slice(start).some(token => isWord(token, "function"));
  }
}

function pendingConditional(tokens) {
  const start = valueStart(tokens);
  if (start < 0) return false;
  let pending = 0;
  for (let i = start; i < tokens.length; i++) {
    // Properties called if/else are names, including inline object entries.
    if ([".", ":"].includes(tokens[i - 1]?.value) || ["is", "as"].some(word => isWord(tokens[i + 1], word))) continue;
    if (isWord(tokens[i], "if")) pending++;
    else if (isWord(tokens[i], "else")) pending--;
  }
  return pending > 0;
}

// The source's lines with their indentation. A line with a parenthesis still open, or that ends in
// a comma or an operator, continues on the lines after it that are indented more.
// Conditions also accept leading and/or at the header's indentation or deeper.
// Indented if/else may continue a conditional value without opening a block.
export function sourceLines(source, { locations = false } = {}) {
  const lines = [];
  let open = null;
  source.replace(/^﻿/, "").split(/\r?\n/).forEach((text, index) => {
    if (!text.trim()) return;
    const prefix = /^\s*/.exec(text)[0];
    const indent = prefix.replace(/\t/g, "    ").length;
    const tokens = tokenize(text.slice(prefix.length), index + 1, locations);
    if (locations) for (const token of tokens) token.source.start += prefix.length + (index === 0 && source.startsWith("\uFEFF") ? 1 : 0);
    // A header's parameters can each take a line, with its giving line back at the header's
    // indentation, like a closing bracket.
    const closes = indent === open?.indent && isWord(tokens[0], "giving");
    const previous = lines.at(-1);
    const deeper = previous && indent > previous.indent;
    const pending = deeper && pendingConditional(previous.tokens);
    const startsValue = deeper && isWord(tokens[0], "if") &&
      !["is", "as"].some(word => isWord(tokens[1], word)) && canWrapValue(previous);
    const endsValue = pending && isWord(tokens[0], "else") &&
      !["is", "as"].some(word => isWord(tokens[1], word));
    const leading = previous && indent >= previous.indent &&
      (isWord(tokens[0], "and") || isWord(tokens[0], "or")) && (conditionStart(previous.tokens) || pending);
    if (open && (indent > open.indent || closes)) {
      open.tokens.push(...tokens);
    } else if (startsValue || endsValue || leading) {
      const wasOpen = Boolean(open);
      open = previous;
      if (startsValue) {
        if (!open.conditionalValues) Object.defineProperty(open, "conditionalValues", { value: [] });
        open.conditionalValues.push({ at: open.tokens.length, line: index + 1 });
      } else if (leading && conditionStart(open.tokens) && !wasOpen) {
        if (!open.leading) Object.defineProperty(open, "leading", { value: [] });
        open.leading.push({ at: open.tokens.length, line: index + 1 });
      }
      open.tokens.push(...tokens);
    } else {
      open = { line: index + 1, indent, tokens };
      lines.push(open);
    }
    if (!continues(open.tokens)) open = null;
  });
  return lines;
}

// The functions (with their parameters) and variables a Prose module exports, from its export lines.
function exportsOf(source) {
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
  const { analysis } = discoverCallArities(source, {}, false);
  return { functions, values, valueArities: new Map([...values].map(name => [name, analysis.root.lookup(name)])) };
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
    this.lineScopes = new Map(); this.valueArities = new Map();
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
      const exported = readImports && use.source.endsWith(".prose") ? readExports(use, options.readModule) : null;
      for (const name of use.names) {
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
    return new Expression(tokens, line.line, this.functions, this.callAnalysis, this.callScope, this.loose);
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
          if (expr.at("(")) {
            expr.take("(");
            const key = expr.inParentheses(() => expr.parse());
            expr.take(")");
            target = { type: "property", object: target, key, line: expr.line };
          } else {
            target = { type: "property", object: target, name: expr.propertyName(), line: expr.line };
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
    const params = type.params.map((param, index) => `arg${index + 1}: ${typeText(param)}`).join(", ");
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

const generic = variables => variables.length ? `<${variables.join(", ")}>` : "";
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
    if (index < optionalFrom) return type ? `${nameOf(name)}: ${typeOf(type, false)}` : untyped(nameOf(name));
    return `${nameOf(name)}?: ${typeOf(type, true)}`;
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
    return [...docComment(node.doc), `${prefix}type ${node.name}${generic(typeVariables([node.value]))} = ${typeOf(node.value)};`];
  }
  const lines = [...docComment(node.doc), `${prefix}interface ${node.name}${generic(typeVariables(node.fields.map(field => field.type)))} {`];
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
  for (const use of program.filter(node => node.type === "use" && node.typeOnly)) {
    lines.push(`import type { ${use.names.join(", ")} } from ${JSON.stringify(use.source)};`);
  }
  for (const node of program) {
    if (node.type === "function" && node.exported) {
      const params = parameterList(node, name => parameterName(camel(name)), name => `${name}: any`);
      const variables = typeVariables([...node.types, node.returns]);
      lines.push(...docComment(node.doc),
        `export function ${camel(node.name)}${generic(variables)}(${params}): ${returnType(node)};`);
    } else if (node.type === "assign" && node.exported) {
      lines.push(...docComment(node.doc),
        `export let ${camel(node.name)}: ${node.declaredType ? typeText(node.declaredType) : literalType(node.value)};`);
    } else if (node.type === "typeDeclaration") {
      lines.push(...typeDeclarationLines(node));
    }
  }
  return lines.join("\n") + "\n";
}

/** Parse a program, also used to verify that formatting preserves its meaning. */
export function parse(source, options = {}) {
  const modules = new Map();
  const settings = { ...options, readModule: options.readModule && (specifier => {
    if (!modules.has(specifier)) modules.set(specifier, options.readModule(specifier));
    return modules.get(specifier);
  }) };
  try {
    const { analysis } = discoverCallArities(source, settings);
    const final = new Parser(source, settings, analysis, false);
    const result = final.program();
    final.validateContinuations();
    return result;
  } catch (error) {
    throw explainLayoutError(error, source, () => sourceLines(source, { locations: true }), continues);
  }
}

function discoverCallArities(source, settings, readImports = true) {
  const discovery = new Parser(source, settings, null, true, readImports);
  let analysis = inferCallArities(discovery.program(), discovery.functions, discovery.valueArities);
  const invalidated = new Set();
  for (let iteration = 0; iteration < 64; iteration++) {
    const parser = new Parser(source, settings, analysis, true, readImports);
    const program = parser.program();
    let next = inferCallArities(program, parser.functions, parser.valueArities, invalidated);
    for (const [key, before] of analysis.scopes) for (const [name, count] of before.bindings) {
      if (count !== null && next.scopes.get(key)?.bindings.get(name) !== count) invalidated.add(`${key}/${name}`);
    }
    next = inferCallArities(program, parser.functions, parser.valueArities, invalidated);
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
  const mapper = options.sourceMap ? sourceMapBuilder(source, options.filename ?? "program.prose") : null;
  const mapped = (node, code) => mapper && node?.location
    ? mapper.mark(node.location, code, ["name", "call", "function"].includes(node.type) ? (node.value ?? node.name) : undefined) : code;
  const unmapped = code => mapper ? mapper.mark(null, code) : code;
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
      inner.ownTypeVariables = new Set([...typeVariables([...(node.types ?? []), node.returns])].filter(name => !inherited.has(name)));
      inner.typeVariables = new Set([...inherited, ...inner.ownTypeVariables]);
      scopes.set(node, inner);
    }
    return scopes.get(node);
  }
  const later = check ? laterProperties(program, programScope, innerScope) : new Map();

  function expression(node, scope, depth, filterPredicate = false) {
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
      const params = node.params.map((name, index) => node.types?.[index]
        ? `${variable(name)}: ${mapped(node.types[index], parameterType(node.types[index]))}` : variable(name)).join(", ");
      const predicate = checkedPredicate(node, inner, filterPredicate);
      const returns = node.returns ? `: ${mapped(node.returns, returnType(node))}` : predicate ? `: ${unmapped(predicate)}` : "";
      const async = awaits(node.body ?? node.value) ? "async " : "";
      const variables = generic([...inner.ownTypeVariables]);
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
      ? `...${expression(property.value, scope, depth)}` : `${camel(property.name)}: ${value(property.value)}`);
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
      if (node.body) return `(${async}(${params}) => {\n${emitScope(node.body, inner, depth + 1)}\n${pad(depth)}})`;
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
          ? `${generic(typeVariables([...node.types, node.returns]))}(${parameterList(node, variable, undefined, checkedParameter)})${node.returns ? `: ${mapped(node.returns, returnType(node))}` : ""}`
          : `(${node.params.map(variable).join(", ")})`;
        const documentation = check && node.doc ? docComment(node.doc, indent).join("\n") + "\n" : "";
        return `${documentation}${indent}${awaits(node.body) ? "async " : ""}function ${variable(node.name)}${signature} {\n${emitScope(node.body, inner, depth + 1)}\n${indent}}`;
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
    return { code: options.sourceMap === "inline" ? code + inlineSourceMap(map) + "\n" : code, map, module: true, declarations: declarationsFor(program) };
  }
  const module = Boolean(options.runtime) || imports.length > 0 || exports.size > 0 ||
    program.some(node => node.typeOnly || (node.type === "typeDeclaration" && node.exported));
  const markedCode = [
    module ? "" : '"use strict";',
    options.runtime ? `import { ${runtimeHelpers.join(", ")} } from ${JSON.stringify(options.runtime)};` : "",
    ...imports.map(node =>
      mapped(node, `import { ${node.names.map(name => `${camel(name)} as ${variable(name)}`).join(", ")} } from ${JSON.stringify(node.source)};`)),
    options.runtime ? "" : runtimeSource,
    body,
    exported
  ].filter(Boolean).join("\n") + "\n";
  const { code, map } = mapper ? mapper.finish(markedCode) : { code: markedCode, map: null };
  return { code: options.sourceMap === "inline" ? code + inlineSourceMap(map) + "\n" : code, map, module, declarations: declarationsFor(program) };
}

/**
 * Compile the supported Prose subset into JavaScript. Pass `runtime` (a module path) to import
 * the runtime helpers instead of embedding them, and `readModule(path)` to return the source of
 * an imported `.prose` file so its functions can be called like local ones.
 */
export function transpile(source, options = {}) {
  return compile(source, options).code;
}
