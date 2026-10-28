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
  assert.equal(colorAt(declaration, "function"), "#FDE047");
  assert.equal(colorAt(declaration, "double"), "#FDE047");
  assert.equal(colorAt(declaration, "value"), "#A3E635");
  assert.equal(colorAt('print person:name + 12', "name"), "#2DD4BF");
  assert.equal(colorAt('print person:name + 12', "12"), "#FB923C");
  assert.equal(colorAt('result is "hello"', "hello"), "#4ADE80");
  assert.equal(colorAt('"A quoted comment"', "quoted"), "#8B96B5");
});

test("bindings and loop iterators receive their own colors without changing expression variables", () => {
  assert.equal(colorAt('result is "hello"', "result"), "#60A5FA");
  assert.equal(colorAt("for index is 1 to 3", "index"), "#A3E635");
  assert.equal(colorAt("print result", "result"), "#BFDBFE");
});

test("for each colors its keywords as control flow and only its variables as loop iterators", () => {
  const loop = "for each name, score in scores";
  assert.equal(colorAt(loop, "each"), "#F87171");
  assert.equal(colorAt(loop, "name"), "#A3E635");
  assert.equal(colorAt(loop, "score in"), "#A3E635");
  assert.equal(colorAt(loop, "in scores"), "#F87171");
  assert.equal(colorAt(loop, "scores"), "#BFDBFE");
  assert.equal(colorAt("values:map with function takes value", "function"), "#FDE047");
  assert.equal(colorAt("values:map with function takes value", "with"), "#C084FC");
});

test("the palette spans the spectrum: each kind of code word has its own hue", () => {
  const line = 'export count as number is length (names:filter function takes n return n != "" and true) + 1';
  const colors = ["export", "count", "number", "length", "names", "filter", "function", "takes n", "!=", '""', "true", "1"]
    .map(fragment => colorAt(line, fragment));
  assert.deepEqual(colors, [
    "#C084FC", "#60A5FA", "#FB7185", "#22D3EE", "#BFDBFE", "#2DD4BF", "#FDE047", "#C084FC",
    "#F472B6", "#34D399", "#FBBF24", "#FB923C"
  ]);
  const hues = new Set(rules.map(rule => rule.settings.foreground));
  assert.ok(hues.size >= 16, `expected at least 16 distinct colors, got ${hues.size}`);
});

test("palette defaults do not recolor another language or select a workbench theme", async () => {
  const javascript = await registry.loadGrammar("source.js");
  assert.equal(colorAt("if", "if", javascript), "#D4D4D4");
  assert.equal(manifest.contributes.configurationDefaults["workbench.colorTheme"], undefined);
  for (const rule of rules) {
    for (const scope of rule.scope) assert.ok(scope.startsWith("source.prose "));
  }
});

