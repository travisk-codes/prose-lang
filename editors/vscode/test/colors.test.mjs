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
  assert.equal(colorAt(declaration, "function"), "#C6A0F6");
  assert.equal(colorAt(declaration, "double"), "#F9E2AF");
  assert.equal(colorAt(declaration, "value"), "#F6C177");
  assert.equal(colorAt('print person:name + 12', "name"), "#5EEAD4");
  assert.equal(colorAt('print person:name + 12', "12"), "#FAB387");
  assert.equal(colorAt('result is "hello"', "hello"), "#A6E3A1");
  assert.equal(colorAt('"A quoted comment"', "quoted"), "#8B96B5");
});

test("bindings and loop iterators receive their own colors without changing expression variables", () => {
  assert.equal(colorAt('result is "hello"', "result"), "#9BC5FF");
  assert.equal(colorAt("for index is 1 to 3", "index"), "#F6C177");
  assert.equal(colorAt("print result", "result"), "#BCD0F1");
});

test("for each colors its keywords as control flow and only its variables as loop iterators", () => {
  const loop = "for each name, score in scores";
  assert.equal(colorAt(loop, "each"), "#C6A0F6");
  assert.equal(colorAt(loop, "name"), "#F6C177");
  assert.equal(colorAt(loop, "score in"), "#F6C177");
  assert.equal(colorAt(loop, "in scores"), "#C6A0F6");
  assert.equal(colorAt(loop, "scores"), "#BCD0F1");
  assert.equal(colorAt("values:map with function takes value", "function"), "#C6A0F6");
  assert.equal(colorAt("values:map with function takes value", "with"), "#F5A9D0");
});

test("palette defaults do not recolor another language or select a workbench theme", async () => {
  const javascript = await registry.loadGrammar("source.js");
  assert.equal(colorAt("if", "if", javascript), "#D4D4D4");
  assert.equal(manifest.contributes.configurationDefaults["workbench.colorTheme"], undefined);
  for (const rule of rules) {
    for (const scope of rule.scope) assert.ok(scope.startsWith("source.prose "));
  }
});

