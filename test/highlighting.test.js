import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import textmate from "vscode-textmate";
import oniguruma from "vscode-oniguruma";

const require = createRequire(import.meta.url);
const extension = new URL("../editors/vscode/", import.meta.url);
const grammarPath = new URL("syntaxes/prose.tmLanguage.json", extension);
const manifest = JSON.parse(readFileSync(new URL("package.json", extension), "utf8"));
const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const registry = new textmate.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
    createOnigString: value => new oniguruma.OnigString(value)
  }),
  loadGrammar: async scope => scope === "source.prose"
    ? textmate.parseRawGrammar(readFileSync(grammarPath, "utf8"), fileURLToPath(grammarPath))
    : null
});
const grammar = await registry.loadGrammar("source.prose");
after(() => registry.dispose());

function tokenize(source) {
  let stack = textmate.INITIAL;
  return source.split(/\r?\n/).map(line => {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    return result.tokens.map(token => ({
      text: line.slice(token.startIndex, token.endIndex),
      start: token.startIndex, end: token.endIndex, scopes: token.scopes
    }));
  });
}
function scopesAt(line, fragment) {
  const index = line.indexOf(fragment);
  assert.notEqual(index, -1);
  return tokenize(line)[0].find(token => token.start <= index && token.end > index).scopes;
}
function hasScope(line, fragment, scope) {
  assert.ok(scopesAt(line, fragment).includes(scope), `${JSON.stringify(fragment)} should have ${scope}`);
}

test("the extension registers .prose and a resolvable grammar and configuration", () => {
  assert.ok(manifest.contributes.languages.some(language =>
    language.id === "prose" && language.extensions.includes(".prose")));
  assert.equal(manifest.contributes.grammars[0].scopeName, "source.prose");
  assert.equal(manifest.main, "./extension.cjs");
  assert.ok(readFileSync(new URL(manifest.main, extension), "utf8").length > 0);
  const config = JSON.parse(readFileSync(new URL("language-configuration.json", extension), "utf8"));
  assert.deepEqual(config.brackets, [["(", ")"]]);
});

test("function declarations, parameters, and standard-library calls have theme scopes", () => {
  const line = "function cipher takes string, rotate";
  hasScope(line, "function", "storage.type.function.prose");
  hasScope(line, "cipher", "entity.name.function.prose");
  hasScope(line, "takes", "keyword.other.prose");
  hasScope(line, "string", "variable.parameter.prose");
  hasScope(line, "rotate", "variable.parameter.prose");
  hasScope("count is length text", "length", "support.function.prose");
  hasScope("code is char_to_number text.i", "char_to_number", "support.function.prose");
  hasScope("text.i is number_to_char code", "number_to_char", "support.function.prose");
});

test("standalone strings are comments; expression strings retain string coloring", () => {
  const comment = '    "if for function 123 \\"quoted\\"!"';
  hasScope(comment, "if", "comment.line.string.prose");
  assert.ok(!scopesAt(comment, "if").includes("keyword.control.prose"));
  hasScope('print "if for 123"', "if", "string.quoted.double.prose");
  hasScope('text is "hello"', "hello", "string.quoted.double.prose");
  hasScope('"hello" + "world"', "hello", "string.quoted.double.prose");
});

test("valid escapes, invalid escapes, and unterminated strings are isolated", () => {
  hasScope('print "a\\n\\u0041"', "\\n", "constant.character.escape.prose");
  hasScope('print "a\\q"', "\\q", "invalid.illegal.escape.prose");
  const lines = tokenize('print "unterminated\nif true\n    print 2');
  assert.ok(lines[1].find(token => token.text === "if").scopes.includes("keyword.control.prose"));
  assert.ok(!lines[1].some(token => token.scopes.includes("string.quoted.double.prose")));
});

test("operators, booleans, decimals, and dot indexes use distinct scopes", () => {
  hasScope("if not remainder number 15", "not", "keyword.operator.word.prose");
  hasScope("value is -1 mod 26", "mod", "keyword.operator.word.prose");
  hasScope("if true and false", "true", "constant.language.prose");
  hasScope("value is null", "null", "constant.language.prose");
  hasScope("number is 1.5", "1.5", "constant.numeric.prose");
  hasScope("word.i is word.(i + 1)", ".", "punctuation.accessor.prose");
  hasScope("if value >= 2", ">=", "keyword.operator.prose");
  hasScope("word.1", "1", "constant.numeric.prose");
});

test("keyword fragments in ordinary identifiers are not keywords", () => {
  for (const word of ["modulus", "andromeda", "island", "return_value", "lengthened"]) {
    const scopes = scopesAt(`print ${word}`, word);
    assert.ok(scopes.includes("variable.other.readwrite.prose"));
    assert.ok(!scopes.some(scope => scope.startsWith("keyword.") || scope.startsWith("support.function")));
  }
});

test("all example files tokenize without leaking multiline scopes", () => {
  const examples = new URL("../examples/", import.meta.url);
  for (const file of readdirSync(examples).filter(file => file.endsWith(".prose"))) {
    const source = readFileSync(new URL(file, examples), "utf8");
    const lines = tokenize(source + "\nprint 123");
    const final = lines.at(-1);
    assert.ok(final.find(token => token.text === "print").scopes.includes("keyword.other.prose"), file);
    assert.ok(final.find(token => token.text === "123").scopes.includes("constant.numeric.prose"), file);
  }
});

test("object construction and colon properties have distinct scopes, including keyword names", () => {
  hasScope("person is object", "object", "storage.type.object.prose");
  hasScope("print person:address:city", ":", "punctuation.accessor.object.prose");
  hasScope("print person:address:city", "city", "variable.other.property.prose");
  hasScope("print person:if", "if", "variable.other.property.prose");
  hasScope("print person:length", "length", "variable.other.property.prose");
  hasScope("word.i", ".", "punctuation.accessor.prose");
});

test("module, call, and function-value words have syntax scopes", () => {
  const imports = 'use addDays, dateFromKey from "../dates"';
  hasScope(imports, "use", "keyword.other.prose");
  hasScope(imports, "from", "keyword.other.prose");
  hasScope("print from + 1", "from", "variable.other.readwrite.prose");
  hasScope("export function pluralize takes count", "export", "keyword.other.prose");
  hasScope("export function pluralize takes count", "pluralize", "entity.name.function.prose");
  hasScope("export limit is 3", "export", "keyword.other.prose");
  hasScope("export limit is 3", "limit", "variable.other.binding.prose");
  hasScope('print words:join with ", "', "with", "keyword.other.prose");
  hasScope('print words:join with ", "', "join", "variable.other.property.prose");
  hasScope("seen is new Set with items", "new", "keyword.other.prose");
  const lambda = "doubled is values:map with function takes value return value * 2";
  hasScope(lambda, "function", "storage.type.function.prose");
  assert.ok(!scopesAt(lambda, "takes").includes("entity.name.function.prose"));
  hasScope(lambda, "value return", "variable.parameter.prose");
  hasScope(lambda, "return", "keyword.control.prose");
  hasScope(lambda, "value * 2", "variable.other.readwrite.prose");
  hasScope("labels is shelf:map with function takes book", "book", "variable.parameter.prose");
  hasScope("seven is function return 7", "return", "keyword.control.prose");
});

test("for each loops, inline if, unset, and otherwise have syntax scopes", () => {
  const loop = "for each name, score in scores";
  hasScope(loop, "each", "keyword.control.prose");
  hasScope(loop, "name", "variable.other.iterator.prose");
  hasScope(loop, "score in", "variable.other.iterator.prose");
  hasScope(loop, "in scores", "keyword.control.prose");
  hasScope(loop, "scores", "variable.other.readwrite.prose");
  hasScope("for index is 1 to 3", "index", "variable.other.iterator.prose");
  const choice = 'label is if count = 1 then "one" else "many"';
  hasScope(choice, "then", "keyword.control.prose");
  hasScope("value is unset otherwise 0", "unset", "constant.language.prose");
  hasScope("value is unset otherwise 0", "otherwise", "keyword.operator.word.prose");
  hasScope("city is maybe person:address:city", "maybe", "keyword.operator.word.prose");
  for (const word of ["thenceforth", "eachother", "inside", "newest", "withdraw", "user", "exported", "unsettled", "maybelline"]) {
    assert.ok(scopesAt(`print ${word}`, word).includes("variable.other.readwrite.prose"), word);
  }
});

test("type annotations, type declarations, and type imports have type scopes only where types are written", () => {
  const header = "export function groupBy takes items as Iterable of item, keyOf as function taking item giving key, giving map from key to list of item";
  hasScope(header, "items", "variable.parameter.prose");
  hasScope(header, "as Iterable", "keyword.other.prose");
  hasScope(header, "Iterable", "entity.name.type.prose");
  hasScope(header, "of item", "keyword.other.prose");
  hasScope(header, "item,", "entity.name.type.parameter.prose");
  hasScope(header, "keyOf", "variable.parameter.prose");
  hasScope(header, "taking", "keyword.other.prose");
  hasScope(header, "giving map", "keyword.other.prose");
  hasScope("plural as maybe text, giving text", "text", "support.type.prose");
  hasScope("plural as maybe text, giving text", "maybe", "keyword.other.prose");
  hasScope("export limit as number is 3", "limit", "variable.other.binding.prose");
  hasScope("export limit as number is 3", "number", "support.type.prose");
  hasScope("export limit as number is 3", "3", "constant.numeric.prose");
  hasScope("double is function takes n as number giving number return n * 2", "n * 2", "variable.other.readwrite.prose");
  hasScope("double is function takes n as number giving number return n * 2", "return", "keyword.control.prose");
  const declaration = 'export type Period is "day" or "week"';
  hasScope(declaration, "type", "storage.type.prose");
  hasScope(declaration, "Period", "entity.name.type.prose");
  hasScope(declaration, "day", "string.quoted.double.prose");
  hasScope("    start as text", "start", "variable.other.binding.prose");
  hasScope("    start as text", "text", "support.type.prose");
  hasScope('use type Datum from "../types"', "type", "keyword.other.prose");
  hasScope('use type Datum from "../types"', "Datum", "support.class.prose");
  hasScope("seen is new Set items", "Set", "support.class.prose");
  hasScope("print Math:max 4, 9", "Math", "support.class.prose");
  hasScope("print Math:max 4, 9", "max", "variable.other.property.prose");
  hasScope("print total", "total", "variable.other.readwrite.prose");
  hasScope("for number is 1 to 10", "number", "variable.other.iterator.prose");
  hasScope("print text + number", "number", "variable.other.readwrite.prose");
  hasScope('type is "plain"', "type", "variable.other.binding.prose");
});

test("patterns, inline objects, spreads, destructuring, and loop control have scopes", () => {
  const replace = 'clean is name:replace (pattern "\\s*\\([^()]*\\)$" everywhere ignoring case), ""';
  hasScope(replace, "pattern", "keyword.other.prose");
  hasScope(replace, "\\s*", "string.regexp.prose");
  hasScope(replace, "\\s*", "constant.character.escape.prose");
  hasScope(replace, "[^()]", "string.regexp.prose");
  assert.ok(!scopesAt(replace, "[^()]").includes("string.quoted.double.prose"));
  hasScope(replace, "everywhere", "keyword.other.prose");
  hasScope(replace, "ignoring case", "keyword.other.prose");
  hasScope('print text:match pattern "^\\d{4}$" by line', "by line", "keyword.other.prose");
  hasScope('label is "a pattern of light"', "pattern", "string.quoted.double.prose");
  hasScope("print pattern_count", "pattern_count", "variable.other.readwrite.prose");
  hasScope("return object like datum, tags", "like", "keyword.other.prose");
  hasScope("return object like datum, tags", "datum", "variable.other.readwrite.prose");
  hasScope("print Math:max each of counts", "each", "keyword.control.prose");
  hasScope("print Math:max each of counts", "of", "keyword.control.prose");
  hasScope("r, g, b are colors", "are", "keyword.other.prose");
  hasScope("    if blank skip", "skip", "keyword.control.prose");
  hasScope("    if done stop", "stop", "keyword.control.prose");
  hasScope("print offset", "of", "variable.other.readwrite.prose");
});

test("type tests, errors, waiting, and bit operators have keyword scopes", () => {
  hasScope("if value is a text", "is a", "keyword.other.prose");
  hasScope("if value is a text", "text", "support.type.prose");
  hasScope("if value is not an object", "is not an", "keyword.other.prose");
  hasScope("if reason is an Error", "Error", "support.class.prose");
  hasScope("print a", "a", "variable.other.readwrite.prose");
  hasScope("try", "try", "keyword.control.prose");
  hasScope("on error problem", "on error", "keyword.control.prose");
  hasScope('    fail "Choose a date."', "fail", "keyword.control.prose");
  hasScope("result is wait for response:json run", "wait for", "keyword.control.prose");
  hasScope("hash is hash xor 5", "xor", "keyword.operator.word.prose");
  hasScope("high is hash shifted right by 16", "shifted right by", "keyword.operator.word.prose");
  hasScope("print left", "left", "variable.other.readwrite.prose");
});

test("array keywords and comma lists have syntax scopes without turning literals into comments", () => {
  hasScope("items is array", "array", "storage.type.array.prose");
  hasScope('names is "Ada", "Grace"', "Ada", "string.quoted.double.prose");
  hasScope('("Ada",)', ",", "punctuation.separator.arguments.prose");
  hasScope("person:array", "array", "variable.other.property.prose");
  assert.ok(!scopesAt('"Ada", "Grace"', "Ada").includes("comment.line.string.prose"));
});
