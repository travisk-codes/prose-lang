import { runtimeSource } from "./runtime.js";

const reserved = new Set([
  "if", "else", "for", "is", "to", "print", "and", "or", "not",
  "true", "false", "null", "remainder", "function", "return", "while",
  "async", "await", "takes", "run", "mod", "object", "array"
]);

function fail(line, message) {
  throw new SyntaxError(`Line ${line}: ${message}`);
}

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
  or: 10, and: 20,
  "=": 30, "!=": 30, "<": 30, ">": 30, "<=": 30, ">=": 30,
  "+": 40, "-": 40, "*": 50, "/": 50, "%": 50, mod: 50
};

class Expression {
  constructor(tokens, line, functions = new Map()) {
    this.tokens = tokens; this.line = line; this.functions = functions; this.pos = 0;
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
      const index = this.parse();
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
      return { type: "name", value: token.value };
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
  parse(min = 0) {
    const token = this.tokens[this.pos++];
    if (!token) fail(this.line, "Expected an expression.");
    let left;
    if (token.type === "number" || token.type === "string") {
      left = { type: "literal", value: token.value };
    } else if (token.value === "(") {
      left = this.list(true);
      this.take(")");
      left.grouped = true;
    } else if (token.value === "array") {
      left = { type: "array", elements: [] };
    } else if (token.value === "object") {
      left = { type: "object", properties: [] };
    } else if (token.value === "not" || token.value === "-") {
      left = { type: "unary", op: token.value, operand: this.parse(token.value === "not" ? 25 : 60) };
    } else if (token.value === "remainder") {
      left = { type: "binary", op: "%", left: this.parse(60), right: this.parse(60) };
    } else if (["true", "false", "null"].includes(token.value)) {
      left = { type: "literal", value: { true: true, false: false, null: null }[token.value] };
    } else if (token.type === "word" && !reserved.has(token.value)) {
      if (this.functions.has(token.value)) {
        const arity = this.functions.get(token.value).params.length;
        const args = [];
        if (arity === 0) this.take("run");
        for (let index = 0; index < arity; index++) {
          if (index) this.take(",");
          // Calls bind before arithmetic; compound arguments require parentheses.
          args.push(this.parse(60));
        }
        left = { type: "call", name: token.value, args, builtin: this.functions.get(token.value).builtin, line: this.line };
      } else {
        left = { type: "name", value: token.value };
      }
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
      const next = this.peek();
      const priority = next.type === "string" || !Object.hasOwn(precedence, next.value) ? undefined : precedence[next.value];
      if (priority === undefined || priority < min) break;
      this.pos++;
      left = { type: "binary", op: next.value, left, right: this.parse(priority + 1), line: this.line };
    }
    return left;
  }
}

function functionHeader(line) {
  const expr = new Expression(line.tokens, line.line);
  expr.take("function");
  const name = expr.name();
  const params = [];
  if (expr.at("takes")) {
    expr.take("takes");
    params.push(expr.name());
    while (expr.at(",")) { expr.take(","); params.push(expr.name()); }
  }
  expr.end();
  if (new Set(params).size !== params.length) fail(line.line, "Duplicate parameter name.");
  return { name, params };
}

class Parser {
  constructor(source) {
    this.pos = 0;
    this.lines = source.replace(/^\uFEFF/, "").split(/\r?\n/).flatMap((text, index) => {
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
    for (const line of this.lines) {
      if (line.indent !== 0 || line.tokens[0]?.type !== "word" || line.tokens[0].value !== "function") continue;
      const header = functionHeader(line);
      if (this.functions.has(header.name)) fail(line.line, `Duplicate function '${header.name}'.`);
      this.functions.set(header.name, header);
    }
    for (const line of this.lines) {
      const header = this.functions.get(line.tokens[1]?.value);
      if (line.indent === 0 && line.tokens[0]?.value === "function" && header) {
        for (const param of header.params) this.checkVariable(param, line.line);
      }
    }
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
  conditionalBody(expr, line, inFunction) {
    return expr.peek() ? [this.simple(expr, inFunction)] : this.body(line, inFunction);
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
      if (value.type === "object") this.objectBody(value, line);
      object.properties.push({ name, value });
    }
  }
  simple(expr, inFunction, parent = null) {
    let node;
    if (expr.at("print")) {
      expr.take("print");
      node = { type: "print", value: expr.list() };
    } else if (expr.at("return")) {
      if (!inFunction) fail(expr.line, "'return' is only allowed inside a function.");
      expr.take("return");
      node = { type: "return", value: expr.peek() ? expr.list() : null };
    } else if (expr.peek()?.type === "word" &&
        expr.tokens.some((token, index) => index > expr.pos && token.type === "word" &&
          token.value === "is" && expr.tokens[index - 1]?.value !== ":")) {
      const name = expr.name();
      this.checkVariable(name, expr.line);
      let target = { type: "name", value: name };
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
    } else if (expr.peek()?.type === "word" && this.functions.has(expr.peek().value)) {
      const value = expr.parse();
      node = { type: "expression", value };
    } else if (expr.peek()?.type === "string") {
      node = { type: "expression", value: expr.list() };
    } else if (expr.peek()?.type === "word" && expr.pos + 1 === expr.tokens.length) {
      const name = expr.name();
      this.checkVariable(name, expr.line);
      node = { type: "assign", name, value: { type: "unset" } };
    } else {
      fail(expr.line, "Expected assignment, print, return, a string expression, or a function call; this syntax is not supported yet.");
    }
    expr.end();
    if (parent && node.value?.type === "object" &&
        ["assign", "assignTarget", "return"].includes(node.type)) {
      this.objectBody(node.value, parent);
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
      if (expr.at("function")) {
        if (indent !== 0 || inFunction) fail(line.line, "Functions must be declared at the top level.");
        const header = functionHeader(line);
        result.push({ type: "function", ...header, body: this.body(line, true) });
      } else if (expr.at("if")) {
        expr.take("if");
        const condition = expr.parse();
        const branches = [{ condition, body: this.conditionalBody(expr, line, inFunction) }];
        let otherwise = [];
        while (this.pos < this.lines.length) {
          const next = this.lines[this.pos];
          if (next.indent !== indent || next.tokens[0].type !== "word" || next.tokens[0].value !== "else") break;
          this.pos++;
          const tail = this.expression(next);
          tail.take("else");
          if (tail.at("if")) {
            tail.take("if");
            const condition = tail.parse();
            branches.push({ condition, body: this.conditionalBody(tail, next, inFunction) });
          } else {
            otherwise = this.conditionalBody(tail, next, inFunction);
            break;
          }
        }
        result.push({ type: "if", branches, otherwise });
      } else if (expr.at("while")) {
        expr.take("while");
        const condition = expr.parse();
        expr.end();
        result.push({ type: "while", condition, body: this.body(line, inFunction) });
      } else if (expr.at("for")) {
        expr.take("for");
        const name = expr.name();
        this.checkVariable(name, line.line);
        expr.take("is");
        const start = expr.parse();
        expr.take("to");
        const end = expr.parse();
        expr.end();
        result.push({ type: "for", name, start, end, body: this.body(line, inFunction) });
      } else {
        result.push(this.simple(expr, inFunction, line));
      }
    }
    return result;
  }
}

const variable = name => `_prose_${name}`;
function emitExpression(node) {
  if (node.type === "literal") return JSON.stringify(node.value);
  if (node.type === "unset") return "undefined";
  if (node.type === "name") return variable(node.value);
  if (node.type === "array") return `[${node.elements.map(element => `__prose_copy_array(${emitExpression(element)})`).join(", ")}]`;
  if (node.type === "object") {
    return `({${node.properties.map(property => `[${JSON.stringify(property.name)}]: __prose_copy_array(${emitExpression(property.value)})`).join(", ")}})`;
  }
  if (node.type === "property") return `__prose_property(${emitExpression(node.object)}, ${JSON.stringify(node.name)}, ${node.line})`;
  if (node.type === "index") return `__prose_get(${emitExpression(node.object)}, ${emitExpression(node.index)}, ${node.line})`;
  if (node.type === "call") {
    const args = node.args.map(argument => node.builtin ? emitExpression(argument) : `__prose_copy_array(${emitExpression(argument)})`);
    if (node.builtin) args.push(String(node.line));
    return `${node.builtin ? "__prose_" + node.name : variable(node.name)}(${args.join(", ")})`;
  }
  if (node.type === "unary") {
    return `(${node.op === "not" ? "!" : "-"}${emitExpression(node.operand)})`;
  }
  if (node.op === "mod") return `__prose_mod(${emitExpression(node.left)}, ${emitExpression(node.right)}, ${node.line})`;
  const op = { "=": "===", "!=": "!==", and: "&&", or: "||" }[node.op] ?? node.op;
  return `(${emitExpression(node.left)} ${op} ${emitExpression(node.right)})`;
}

function emitReference(target) {
  if (target.type === "name") {
    const name = variable(target.value);
    return `({get: () => ${name}, set: __value => { ${name} = __value; }})`;
  }
  if (target.type === "property") {
    return `__prose_property_ref(${emitExpression(target.object)}, ${JSON.stringify(target.name)}, ${target.line})`;
  }
  return `__prose_index_ref(${emitReference(target.object)}, () => ${emitExpression(target.index)}, ${target.line})`;
}

/** Compile the supported Prose subset into a standalone JavaScript script. */
export function transpile(source) {
  const program = new Parser(source).block();
  let loopId = 0;
  function emitScope(nodes, params = [], depth = 0) {
    const names = new Set();
    function emitBlock(nodes, depth) {
      const pad = "  ".repeat(depth);
      return nodes.map(node => {
        if (node.type === "function") {
          return `${pad}function ${variable(node.name)}(${node.params.map(variable).join(", ")}) {\n${emitScope(node.body, node.params, depth + 1)}\n${pad}}`;
        }
        if (node.type === "assign") {
          names.add(node.name);
          return `${pad}${variable(node.name)} = __prose_copy_array(${emitExpression(node.value)});`;
        }
        if (node.type === "assignTarget") {
          // Rebuilding a string assigns its binding; mutating an object property does not.
          let root = node.target;
          while (root.type === "index") root = root.object;
          if (root.type === "name") names.add(root.value);
          return `${pad}${emitReference(node.target)}.set(${emitExpression(node.value)});`;
        }
        if (node.type === "print") return `${pad}console.log(${emitExpression(node.value)});`;
        if (node.type === "return") return `${pad}return${node.value ? " " + emitExpression(node.value) : ""};`;
        if (node.type === "expression") return `${pad}(${emitExpression(node.value)});`;
        if (node.type === "if") {
          const branches = node.branches.map((branch, index) =>
            `${pad}${index ? "else if" : "if"} (${emitExpression(branch.condition)}) {\n${emitBlock(branch.body, depth + 1)}\n${pad}}`
          ).join(" ");
          return branches + (node.otherwise.length
            ? ` else {\n${emitBlock(node.otherwise, depth + 1)}\n${pad}}` : "");
        }
        if (node.type === "while") {
          return `${pad}while (${emitExpression(node.condition)}) {\n${emitBlock(node.body, depth + 1)}\n${pad}}`;
        }
        names.add(node.name);
        const limit = `_limit${loopId++}`;
        return `${pad}{\n${pad}  const ${limit} = ${emitExpression(node.end)};\n${pad}  for (${variable(node.name)} = ${emitExpression(node.start)}; ${variable(node.name)} <= ${limit}; ${variable(node.name)}++) {\n${emitBlock(node.body, depth + 2)}\n${pad}  }\n${pad}}`;
      }).join("\n");
    }
    const body = emitBlock(nodes, depth);
    const locals = [...names].filter(name => !params.includes(name));
    const declarations = locals.length ? `${"  ".repeat(depth)}let ${locals.map(variable).join(", ")};\n` : "";
    return declarations + body;
  }
  return `"use strict";\n${runtimeSource}\n${emitScope(program)}\n`;
}
