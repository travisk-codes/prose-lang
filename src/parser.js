// Statement parsing, export/import signature discovery, and call-arity inference.
import { Expression } from "./expression.js";
import { located, memberLocated } from "./ast.js";
import { fail } from "./errors.js";
import { isWord, reserved } from "./syntax.js";
import { callScopeKey, inferCallArities } from "./call-arity.js";
import { camel } from "./names.js";
import { conditionOnly, sourceLines, valueOnly } from "./layout.js";

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

export { Parser, discoverCallArities };
