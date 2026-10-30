// Builds the landing page (site/dist/index.html) from template.html. Prose uses the VS Code grammar;
// JavaScript and TypeScript use Prism with the same palette. Outputs and errors come from the real compiler.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inlineScript } from "./scripts.mjs";
import { syntaxSource, highlightCode } from "./syntax.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const here = new URL("./", import.meta.url);
const require = createRequire(repo + "package.json");
const textmate = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");
const { compile } = await import(pathToFileURL(repo + "src/transpile.js").href);

const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const manifest = JSON.parse(readFileSync(repo + "editors/vscode/package.json", "utf8"));
const rules = manifest.contributes.configurationDefaults["editor.tokenColorCustomizations"].textMateRules;
const grammarPath = repo + "editors/vscode/syntaxes/prose.tmLanguage.json";
const registry = new textmate.Registry({
  theme: { settings: [{ settings: { foreground: "#D4D4D4", background: "#1F1F1F" } }, ...rules] },
  onigLib: Promise.resolve({
    createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
    createOnigString: value => new oniguruma.OnigString(value)
  }),
  loadGrammar: async scope => scope === "source.prose" ? textmate.parseRawGrammar(readFileSync(grammarPath, "utf8"), grammarPath) : null
});
const grammar = await registry.loadGrammar("source.prose");
const colorMap = registry.getColorMap();

// Palette colors become class names, so the page's CSS tokens own the actual values.
const names = {
  "#F58C8F": "red", "#F5AA6C": "orange", "#F3C962": "amber", "#F5E07B": "yellow", "#B7E16E": "lime",
  "#7CDA9E": "green", "#6AD5AB": "emerald", "#64D6C7": "teal", "#89E5D7": "teal2", "#66D6E9": "cyan",
  "#85B7F4": "blue", "#C5D9F5": "pale", "#9CA3F0": "indigo", "#C79EF4": "purple", "#EC93C4": "pink",
  "#F392A2": "rose", "#E799F3": "magenta", "#979FB8": "comment", "#ADB5CC": "punct", "#F37086": "invalid", "#D4D4D4": "plain",
  "#6D7182": "separator"
};
const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function highlight(source) {
  let stack = textmate.INITIAL;
  return source.split("\n").map(line => {
    const { tokens, ruleStack } = grammar.tokenizeLine2(line, stack);
    stack = ruleStack;
    let html = "";
    for (let i = 0; i < tokens.length; i += 2) {
      const end = i + 2 < tokens.length ? tokens[i + 2] : line.length;
      const meta = tokens[i + 1];
      const color = colorMap[(meta >>> 15) & 511].toUpperCase();
      if (!names[color]) throw new Error(`No class for ${color}`);
      const style = (meta >>> 11) & 15;
      const classes = [`c-${names[color]}`, style & 1 ? "it" : "", style & 2 ? "bd" : ""].filter(Boolean).join(" ");
      html += `<span class="${classes}">${escape(line.slice(tokens[i], end))}</span>`;
    }
    return html;
  }).join("\n");
}

// Wraps the nth span whose text is exactly `token` in a proofreader's mark.
function mark(html, token, nth = 1) {
  let seen = 0;
  const marked = html.replace(new RegExp(`(<span class="[^"]*">)(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(</span>)`, "g"),
    (all, open, text, close) => ++seen === nth ? `${open}<mark class="erratum">${text}</mark>${close}` : all);
  if (!seen) throw new Error(`Token ${token} not found`);
  return marked;
}

function check(source, prefix = "") {
  compile(prefix + source);
  return source;
}
const body = code => code.split("\n").filter(line => !line.startsWith("import {")).join("\n").trim();
function errorOf(source) {
  try { compile(source); } catch (error) { return error.message; }
  throw new Error(`Expected an error: ${source}`);
}
function runtimeErrorOf(source) {
  try { runInNewContext(compile(source).code, { console: { log() {} } }); } catch (error) { return error.message; }
  throw new Error(`Expected a runtime error: ${source}`);
}
function outputOf(source) {
  const lines = [];
  runInNewContext(compile(source).code, { console: { log: value => lines.push(String(value)) } });
  return lines.join("\n");
}

const hero = readFileSync(new URL("hero.prose", here), "utf8").trim();
// The hero compares Prose with JavaScript as a person would write it, so both must print the same thing.
const heroJsPath = new URL("hero.js", here);
const heroJs = readFileSync(heroJsPath, "utf8").trim();
const heroJsOutput = execFileSync(process.execPath, [fileURLToPath(heroJsPath)], { encoding: "utf8" }).trim();
if (heroJsOutput !== outputOf(hero)) throw new Error(`hero.js prints:\n${heroJsOutput}\nbut the Prose prints:\n${outputOf(hero)}`);

const features = {
  words: check('label is if pages > 500 then "long" else "short"\nif count = 1 then print "one entry"', "pages is 1\ncount is 1\n"),
  loops: check('for each name, score in scores\n    print name + ": " + score', "scores is new Map\n"),
  functions: check('function pluralize takes count, word\n    return count + " " + (if count = 1 then word else word + "s")\n\nprint pluralize 3, "book"'),
  maybe: check('city is maybe person:address:city otherwise "unknown"', "person is null\n"),
  positions: check('word is "a😀z"\nprint word.2\nprint length word'),
  values: check("long_books is books:filter function takes book return book:pages > 500", "books is array\n")
};
const positionsOutput = outputOf(features.positions);

const interop = check([
  'use addDays, dateFromKey, localDateKey from "./dates.js"',
  "",
  '"The day after a YYYY-MM-DD key."',
  "export function nextDay takes key as text, giving text",
  "    return localDateKey (addDays with (dateFromKey key), 1)",
  "",
  'seen is new Set ("a", "b", "a")',
  'print Math:max with 4, 9, 2',
  'document:title is "Written in Prose"'
].join("\n"));

const typed = check([
  '"A run of consecutive days."',
  "export type StreakRun is object",
  '    "First and last day, as YYYY-MM-DD."',
  "    start as text",
  "    end as text",
  "    length as number",
  "",
  '"Every run, longest first."',
  "export function streakRuns takes days as list of text, giving list of StreakRun",
  "    return array"
].join("\n"));
const declarations = compile(typed).declarations.split("\n").slice(1).join("\n").trim();

const errata = [
  { source: "total is 3\nprint totl", token: "totl", message: errorOf("total is 3\nprint totl"),
    note: "Every name has to be assigned, imported, or part of JavaScript, so a typo stops the build." },
  { source: 'counts is new Map\ncount is 0\ncounts:set with "read", count + 1', token: "+", message: errorOf('counts is new Map\ncount is 0\ncounts:set with "read", count + 1'),
    note: "Does the 1 go to the count, or to the result? Prose asks instead of guessing." },
  { source: "ready is true\nif ready count is 5", token: "count", message: errorOf("ready is true\nif ready count is 5"),
    note: "The error message includes the fix." },
  { source: "person is null\nprint person:name", token: "name", message: runtimeErrorOf("person is null\nprint person:name"),
    note: "This one happens while the program runs, still with its line. Write maybe person:name when a value can be missing." }
];

// The compiler itself, for the playground: runtime and transpiler in one script, exporting compile.
const strip = file => readFileSync(repo + file, "utf8").split("\n").filter(line => !line.startsWith("import ")).join("\n").replace(/^export /gm, "");
const compiler = `const Prose = (() => {\n${strip("src/runtime.js")}\n${strip("src/check.js")}\n${strip("src/source-map.js")}\n${strip("src/call-arity.js")}\n${strip("src/layout-diagnostics.js")}\n${strip("src/transpile.js")}\nreturn { compile, inlineSourceMap, mapStackTrace };\n})();`;

const examples = [
  { name: "Reading list", source: readFileSync(new URL("play.prose", here), "utf8").trim() },
  { name: "FizzBuzz", source: readFileSync(repo + "examples/fizzbuzz.prose", "utf8").trim() },
  { name: "Caesar cipher", source: readFileSync(repo + "examples/caesar_cipher_demo.prose", "utf8").trim() },
  { name: "Pascal's triangle", source: readFileSync(repo + "examples/pascal_triangle.prose", "utf8").trim() }
];
for (const example of examples) {
  example.source = example.source.replace(/\r\n/g, "\n");
  compile(example.source);
}

// Production builds still require a green suite. An explicit local preview can
// render the site while compiler work is in progress, with an honest visible notice.
const preview = process.argv.includes("--preview");
if (process.argv.slice(2).some(arg => arg !== "--preview")) throw new Error("Usage: node site/build.mjs [--preview]");
const testRun = spawnSync(process.execPath, ["--test", "--test-reporter=spec"], { cwd: repo, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
if (testRun.error) throw testRun.error;
const testReport = testRun.stdout;
const pass = /^ℹ pass (\d+)$/m.exec(testReport);
const fail = /^ℹ fail (\d+)$/m.exec(testReport);
if (!pass || !fail) throw new Error("Could not read the test results.\n" + testReport + testRun.stderr);
const testCount = Number(pass[1]);
const failures = Number(fail[1]);
if (testRun.status !== 0 && !preview) {
  process.stderr.write(testReport + testRun.stderr);
  throw new Error("The test suite must pass before publishing. For local site work, run node site/build.mjs --preview.");
}
const play = examples[0].source;
const values = {
  play_source: escape(play),
  play_output: escape(outputOf(play)),
  play_js: highlightCode(body(compile(play, { runtime: "prose-runtime" }).code)),
  hero_prose: highlight(hero),
  hero_js: highlightCode(heroJs),
  hero_output: escape(outputOf(hero)),
  f_words: highlight(features.words),
  f_loops: highlight(features.loops),
  f_functions: highlight(features.functions),
  f_maybe: highlight(features.maybe),
  f_positions: highlight(features.positions),
  f_positions_output: escape(positionsOutput.replace(/\n/g, ", ")),
  f_values: highlight(features.values),
  interop_prose: highlight(interop),
  vite_config: highlightCode("import prose from 'prose-lang/vite'\n\nexport default defineConfig({\n  plugins: [prose({ declarations: true })],\n})", "typescript"),
  import_js: highlightCode("import { nextDay } from './next-day.prose'"),
  types_prose: highlight(typed),
  types_dts: highlightCode(declarations, "typescript"),
  errata: errata.map(({ source, token, message, note }) => {
    const [, line, text] = /^Line (\d+): (.*)$/.exec(message);
    return `<li class="erratum-entry">
          <pre class="code slab"><code>${mark(highlight(source), token)}</code></pre>
          <div class="note"><span class="note-line">Line ${line}</span><blockquote>${escape(text)}</blockquote><p>${escape(note)}</p></div>
        </li>`;
  }).join("\n        "),
  test_count: String(testCount),
  test_summary: failures ? `${testCount} passing tests; ${failures} checks in progress` : `${testCount} tests that keep all of it honest`,
  preview_notice: preview ? `<aside class="preview-notice">Local development preview · ${testCount} tests passing${failures ? ` · ${failures} checks still in progress` : ""}</aside>` : "",
  playground: inlineScript(readFileSync(new URL("playground.js", here), "utf8")),
  syntax: inlineScript(syntaxSource),
  compiler: inlineScript(compiler),
  examples: JSON.stringify(examples).replace(/<\//g, "<\\/")
};

let page = readFileSync(new URL("template.html", here), "utf8");
page = page.replace(/\{\{(\w+)\}\}/g, (all, key) => {
  if (!(key in values)) throw new Error(`Unknown placeholder ${key}`);
  return values[key];
});
mkdirSync(new URL("dist/", here), { recursive: true });
writeFileSync(new URL("dist/index.html", here), page);
console.log(`Wrote site/dist/index.html (${Math.round(page.length / 1024)} KB, ${testCount} tests passing${preview ? ", local preview" : ""})`);
