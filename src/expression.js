import { fail } from "./errors.js";
import { callScopeKey } from "./call-arity.js";
import { camel } from "./names.js";
import { located, memberLocated } from "./ast.js";
import { reserved, typeTests, isWord } from "./syntax.js";
import { markupPosition } from "./markup.js";

const precedence = {
  or: 10, otherwise: 10, and: 20,
  "=": 30, "!=": 30, "<": 30, ">": 30, "<=": 30, ">=": 30,
  "+": 40, "-": 40, "*": 50, "/": 50, "%": 50, mod: 50, xor: 50
};


// Prose's words for TypeScript's basic types.
const builtinTypes = {
  text: "string", number: "number", boolean: "boolean", any: "any", unknown: "unknown",
  nothing: "void", unset: "undefined", null: "null", true: "true", false: "false"
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
    if (next.type === "number" || next.type === "string" || next.type === 'markup') return true;
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
      const token = this.peek();
      const name = this.propertyName();
      this.take("is");
      return located({ name, value: this.parse() }, token);
    }
    if (this.peek()?.type !== "word") fail(this.line, "Expected an object entry: name is value, a name, or like another object.");
    const token = this.peek(), name = this.variableName();
    return located({ name, value: located({ type: "name", value: name, line: this.line }, token) }, token);
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
    const token = this.peek();
    if (this.at("(")) {
      this.take("(");
      const key = this.inParentheses(() => this.parse());
      this.take(")");
      return memberLocated({ type: "property", object, key, contextual: true, line: this.line }, token);
    }
    if (this.peek()?.type === "word") {
      return memberLocated({ type: "property", object, name: this.propertyName(), contextual: true, line: this.line }, token);
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
    const separators = [];
    while (this.at(",")) {
      separators.push(this.take(",").source);
      if (allowTrailing && this.at(")")) break;
      elements.push(this.parse());
    }
    const array = { type: "array", elements };
    Object.defineProperty(array, "separators", { value: separators });
    return array;
  }
  // The arguments after `with`: every comma-separated value up to the end of the list.
  arguments(explicit = true, callStart) {
    const first = this.peek();
    const nested = this.argumentDepth > 0;
    this.argumentDepth++;
    const args = [this.parse(60)];
    if (!explicit && this.at(",") && !this.loose) {
      const comma = this.peek().source;
      const point = source => source && { line: source.line, column: source.start + 1 };
      fail(this.tokens[this.pos].source?.line ?? this.line,
        "This call's parameter count is unknown, so the comma could separate arguments or array elements. Use with for arguments, or close the call in parentheses before the comma.",
        { code: "PROSE_CALL_BOUNDARY", ...(comma ? { column: comma.start + 1 } : {}),
          callBoundary: first?.source && { line: first.source.line, column: first.source.start, text: "with " },
          ...(callStart && first?.source && comma ? { callBoundaryInfo: { start: point(callStart), argument: point(first.source), comma: point(comma) } } : {}) });
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
        // Only editor analysis may complete a call after its unique cursor probe.
        // Normal parsing, formatting, checking, and executable output stay strict.
        if (index && this.signatureProbe && (!this.peek() || this.at(")")) &&
            this.tokens.slice(0, this.pos).some(token => token.type === "string" && token.value === this.signatureProbe)) {
          args.push({ type: "unset", signaturePadding: true }); continue;
        }
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
    // The shallow export scan has no transitive import signatures. In that
    // partial parse, retain loose method calls so an imported argument call
    // such as `map.get make_key item` can still be read for export metadata.
    if (node.type === "property") return this.callAnalysis?.partialImports ? null : this.callScope?.methodArity(node) ?? null;
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
    return ["number", "string", "pattern", "markup"].includes(next.type) || next.type === "symbol" && ["(", "-"].includes(next.value) ||
      next.type === "word" && (!reserved.has(next.value) || ["function", "if", "new", "not", "maybe", "array", "object", "unset", "true", "false", "null", "each"].includes(next.value));
  }
  // Explicit type parameters live beside the declaration, with optional bounds.
  genericParameters() {
    const parameters = [];
    if (!this.at('of')) return parameters;
    this.take('of');
    while (true) {
      const token = this.peek(), name = this.name();
      if (!/^[a-z][A-Za-z_0-9]*$/.test(name) || Object.hasOwn(builtinTypes, name) || ['list', 'set', 'map', 'of', 'from', 'to'].includes(name)) {
        fail(this.line, 'Type parameter names are lowercase placeholders, like item or choice.');
      }
      if (parameters.some(parameter => parameter.name === name)) fail(this.line, `Duplicate type parameter '${name}'.`);
      const bound = this.optionalType();
      parameters.push(located({ name, ...(bound ? { bound } : {}) }, token));
      if (!this.at(',')) break;
      this.take(',');
      if (['takes', 'giving', 'is', 'return'].some(word => this.at(word))) break;
    }
    return parameters;
  }
  // `takes` names, each optionally followed by `as` and a type, then an optional `giving` type.
  parameters() {
    const typeParams = this.genericParameters();
    const names = [];
    Object.defineProperty(names, "locations", { value: [] });
    const types = [];
    if (this.at("takes")) {
      this.take("takes");
      while (true) {
        names.locations.push(this.peek()?.source);
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
    return { names, types, returns, ...(typeParams.length ? { typeParams } : {}) };
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
    const { names, types, returns, typeParams } = this.parameters();
    const node = { type: "lambda", params: names, types, returns, ...(typeParams ? { typeParams } : {}), line: this.line };
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
  parse(min = 0, callStart) {
    const token = this.peek();
    const previous = this.callStart;
    this.callStart = callStart;
    try { return located(this.parseValue(min), token); }
    finally { this.callStart = previous; }
  }
  parseValue(min = 0) {
    const token = this.tokens[this.pos++];
    if (!token) fail(this.line, "Expected an expression.");
    const callStart = this.callStart ?? token.source;
    let left;
    if (token.type === 'markup') {
      left = this.markup(token);
    } else if (token.type === "number" || token.type === "string") {
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
      left = this.parse(70, callStart);
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
        const member = this.peek();
        callee = dot ? this.dotStep(callee)
          : memberLocated({ type: "property", object: callee, name: this.propertyName(), line: this.line }, member);
      }
      const args = [];
      if (this.at("with")) {
        const count = this.calleeArity(callee);
        if (count === null) { this.take("with"); args.push(...this.arguments()); }
        else args.push(...this.call(callee.value ?? "constructor", { params: new Array(count) }, callee).args);
      } else if (this.peek() && this.callsByAdjacency({ type: "name" })) {
        const count = this.calleeArity(callee);
        args.push(...(count === null ? this.arguments(false, callStart) : this.call(callee.value ?? "constructor", { params: new Array(count) }, callee).args));
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
        const member = this.peek();
        if (this.at("(")) {
          // A computed property: settings:(name) is the property named by name's value.
          this.take("(");
          const key = this.inParentheses(() => this.parse());
          this.take(")");
          left = memberLocated({ type: "property", object: left, key, line: this.line }, member);
        } else {
          left = memberLocated({ type: "property", object: left, name: this.propertyName(), line: this.line }, member);
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
        left = count === null ? { type: "invoke", callee: left, args: this.arguments(false, callStart), line: this.line }
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

  markup(token) {
    const at = node => ({ source: { ...markupPosition(token.markupSource, node.start), raw: node.name ?? '' } });
    const expression = node => {
      if (node.kind === 'literal') return located({ type: 'literal', value: node.value }, at(node));
      if (node.kind === 'element') return element(node);
      if (!node.tokens.length) return null;
      const parser = new Expression(node.tokens, node.tokens[0].source.line, this.functions, this.callAnalysis, this.callScope, this.loose);
      parser.signatureProbe = this.signatureProbe;
      const value = parser.list(); parser.end();
      if (parser.blockFunctions.length) fail(parser.line, 'Define a multiline callback before the markup and pass its name in braces.');
      return value;
    };
    const element = node => {
      const component = tag => {
        const [first, ...rest] = tag.name.split('.');
        let value = located({ type: 'name', value: first, line: at(tag).source.line }, at({ ...tag, name: first }));
        let start = tag.start + first.length + 1;
        for (const name of rest) {
          value = located({ type: 'property', object: value, name, line: value.line }, at({ start, name }));
          start += name.length + 1;
        }
        return value;
      };
      let tag = null;
      if (node.tag.name) {
        if (/^[a-z]/.test(node.tag.name)) tag = located({ type: 'literal', value: node.tag.name }, at(node.tag));
        else {
          tag = component(node.tag);
        }
      }
      const seen = new Set();
      const attributes = node.attributes.map(attribute => {
        if (attribute.spread) {
          const value = expression(attribute.value);
          if (!value) fail(at(attribute).source.line, 'A spread attribute needs an object expression.');
          return located({ spread: true, value }, at(attribute));
        }
        const name = camel(attribute.name);
        if (seen.has(name)) fail(at(attribute).source.line, `Duplicate React property '${name}'.`);
        seen.add(name);
        const value = expression(attribute.value);
        if (!value) fail(at(attribute).source.line, 'An attribute expression cannot be empty.');
        return located({ name, value }, at(attribute));
      });
      const value = located({ type: 'element', tag, attributes, children: node.children.map(expression).filter(Boolean), line: at(node).source.line }, at(node));
      if (tag?.type !== 'literal' && node.closingTag?.name) Object.defineProperty(value, 'closingTag', { value: component(node.closingTag) });
      return value;
    };
    return element(token.tree);
  }
}


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


export { Expression };
