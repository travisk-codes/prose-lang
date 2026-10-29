import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import textmate from "vscode-textmate";
import oniguruma from "vscode-oniguruma";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const rules = manifest.contributes.configurationDefaults["editor.tokenColorCustomizations"].textMateRules;
const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const registry = new textmate.Registry({
  theme: { settings: [{ settings: { foreground: "#D4D4D4", background: "#1F1F1F" } }, ...rules] },
  onigLib: Promise.resolve({
    createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
    createOnigString: value => new oniguruma.OnigString(value)
  }),
  loadGrammar: async scope => {
    if (scope === "source.js") return {
      scopeName: "source.js", patterns: [{ match: "\\bif\\b", name: "keyword.control.js" }]
    };
    if (scope !== "source.prose") return null;
    const path = new URL("syntaxes/prose.tmLanguage.json", root);
    return textmate.parseRawGrammar(readFileSync(path, "utf8"), fileURLToPath(path));
  }
});
const grammar = await registry.loadGrammar("source.prose");
after(() => registry.dispose());

function colorAt(line, fragment, language = grammar) {
  const position = line.indexOf(fragment);
  assert.notEqual(position, -1);
  const tokens = language.tokenizeLine2(line, textmate.INITIAL).tokens;
  for (let i = 0; i < tokens.length; i += 2) {
    const end = i + 2 < tokens.length ? tokens[i + 2] : line.length;
    if (position >= tokens[i] && position < end) {
      return registry.getColorMap()[(tokens[i + 1] >>> 15) & 511];
    }
  }
  assert.fail("Token not found: " + fragment);
}

test("the palette resolves distinct function, parameter, property, string and number colors", () => {
  const declaration = "function double takes value";
  assert.equal(colorAt(declaration, "function"), "#F5E07B");
  assert.equal(colorAt(declaration, "double"), "#F5E07B");
  assert.equal(colorAt(declaration, "value"), "#B7E16E");
  assert.equal(colorAt('print person:name + 12', "name"), "#64D6C7");
  assert.equal(colorAt('print person:name + 12', "12"), "#F5AA6C");
  assert.equal(colorAt('result is "hello"', "hello"), "#7CDA9E");
  assert.equal(colorAt('"A quoted comment"', "quoted"), "#979FB8");
});

test("bindings and loop iterators receive their own colors without changing expression variables", () => {
  assert.equal(colorAt('result is "hello"', "result"), "#85B7F4");
  assert.equal(colorAt("for index is 1 to 3", "index"), "#B7E16E");
  assert.equal(colorAt("print result", "result"), "#C5D9F5");
});

test("for each colors its keywords as control flow and only its variables as loop iterators", () => {
  const loop = "for each name, score in scores";
  assert.equal(colorAt(loop, "each"), "#F58C8F");
  assert.equal(colorAt(loop, "name"), "#B7E16E");
  assert.equal(colorAt(loop, "score in"), "#B7E16E");
  assert.equal(colorAt(loop, "in scores"), "#F58C8F");
  assert.equal(colorAt(loop, "scores"), "#C5D9F5");
  assert.equal(colorAt("values:map with function takes value", "function"), "#F5E07B");
  assert.equal(colorAt("values:map with function takes value", "with"), "#C79EF4");
});

test("the palette spans the spectrum: each kind of code word has its own hue", () => {
  const line = 'export count as number is length (names:filter function takes n return n != "" and true) + 1';
  const colors = ["export", "count", "number", "length", "names", "filter", "function", "takes n", "!=", '""', "true", "1"]
    .map(fragment => colorAt(line, fragment));
  assert.deepEqual(colors, [
    "#C79EF4", "#85B7F4", "#F392A2", "#66D6E9", "#C5D9F5", "#64D6C7", "#F5E07B", "#C79EF4",
    "#EC93C4", "#6AD5AB", "#F3C962", "#F5AA6C"
  ]);
  const hues = new Set(rules.map(rule => rule.settings.foreground));
  assert.ok(hues.size >= 16, `expected at least 16 distinct colors, got ${hues.size}`);
});

test("formatter updates retain dim dots and underscores while keeping the words bright", () => {
  assert.equal(colorAt("print person.first_name", "."), "#6D7182");
  assert.equal(colorAt("print person.first_name", "_"), "#6D7182");
  assert.equal(colorAt("print person.first_name", "first"), "#64D6C7");
  assert.equal(colorAt("first_name is 1", "_"), "#6D7182");
  assert.equal(colorAt("first_name is 1", "first"), "#85B7F4");
});

test("palette defaults do not recolor another language or select a workbench theme", async () => {
  const javascript = await registry.loadGrammar("source.js");
  assert.equal(colorAt("if", "if", javascript), "#D4D4D4");
  assert.equal(manifest.contributes.configurationDefaults["workbench.colorTheme"], undefined);
  for (const rule of rules) {
    for (const scope of rule.scope) assert.ok(scope.startsWith("source.prose "));
  }
});

