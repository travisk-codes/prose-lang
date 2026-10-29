import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { format } from "../src/format.js";
import { sourceLines } from "../src/transpile.js";
import { build } from "../editors/vscode/build.mjs";

build();

const require = createRequire(import.meta.url);
const { changedRange, createProvider } = require("../editors/vscode/formatting.cjs");

function editor(source, { imports = {}, width = 80, open = [], eol = 1 } = {}) {
  const errors = [], reads = [];
  const document = { version: 1, uri: new URL("file:///project/main.prose"), eol, getText: () => source, positionAt: offset => offset };
  const vscode = {
    EndOfLine: { CRLF: 2 },
    Uri: { joinPath: (uri, parent, specifier) => new URL(specifier, new URL(parent + "/", uri.href + "/")) },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    TextEdit: { replace: (range, text) => ({ ...range, text }) },
    window: { showErrorMessage: message => errors.push(message) },
    workspace: {
      textDocuments: open,
      fs: { readFile: async uri => {
        reads.push(uri.toString());
        if (!(uri.pathname in imports)) throw new Error("Missing imported file.");
        return new TextEncoder().encode(imports[uri.pathname]);
      } },
      getConfiguration: () => ({ get: () => width })
    }
  };
  const provider = createProvider(vscode, async () => ({ format, sourceLines }));
  return { errors, reads, document, provider };
}
const settings = { tabSize: 4, insertSpaces: true };
const cancellation = { isCancellationRequested: false };
const apply = (source, edits) => edits.reduceRight((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);

test("VS Code formatter returns a bounded edit and respects indentation and CRLF", async () => {
  const source = 'function greet\r\n  print  "hello"\r\n';
  const { document, provider, errors } = editor(source, { eol: 2 });
  const edits = await provider.provideDocumentFormattingEdits(document, { tabSize: 2, insertSpaces: true }, cancellation);
  assert.equal(apply(source, edits), 'function greet\r\n  print "hello"\r\n');
  assert.ok(edits[0].start > 0);
  assert.ok(edits[0].end < source.length);
  assert.deepEqual(errors, []);
});

test("VS Code formatter reads imported signatures without executing modules", async () => {
  const source = 'use double from "./math.prose"\nprint  double 2, double 3';
  const { document, provider, reads, errors } = editor(source, {
    imports: { "/project/math.prose": 'export function double takes n\n    fail "Must never execute"' }
  });
  const edits = await provider.provideDocumentFormattingEdits(document, settings, cancellation);
  assert.equal(apply(source, edits), source.replace("print  ", "print ") + "\n");
  assert.deepEqual(reads, ["file:///project/math.prose"]);
  assert.deepEqual(errors, []);
});

test("VS Code formatter uses unsaved imported documents and skips type-only imports", async () => {
  const source = 'use type Thing from "./missing-types.prose"\nuse double from "./math.prose"\nprint  double 2';
  const { document, provider, reads, errors } = editor(source, {
    open: [{ uri: new URL("file:///project/math.prose"), getText: () => 'export function double takes n\n    return n * 2' }]
  });
  const edits = await provider.provideDocumentFormattingEdits(document, settings, cancellation);
  assert.equal(apply(source, edits), source.replace("print  ", "print ") + "\n");
  assert.deepEqual(reads, []);
  assert.deepEqual(errors, []);
});

test("VS Code formatter leaves invalid and cancelled documents alone", async () => {
  const invalid = editor("if true\nprint 1");
  assert.deepEqual(await invalid.provider.provideDocumentFormattingEdits(invalid.document, settings, cancellation), []);
  assert.match(invalid.errors[0], /Line 1: Expected an indented body/);
  const cancelled = editor("print  1");
  assert.deepEqual(await cancelled.provider.provideDocumentFormattingEdits(cancelled.document, settings, { isCancellationRequested: true }), []);
  assert.deepEqual(cancelled.errors, []);
});

test("VS Code formatter does not apply an edit to a newer document version", async () => {
  const { document, errors } = editor("print  1");
  const provider = createProvider({}, async () => {
    document.version++;
    return { format, sourceLines };
  });
  assert.deepEqual(await provider.provideDocumentFormattingEdits(document, settings, cancellation), []);
  assert.deepEqual(errors, []);
});

test("bounded edits preserve Unicode characters and CRLF pairs", () => {
  assert.equal(changedRange("print 1\n", "print 1\n"), null);
  const samples = ["", "a", "a\r\nb", "a\nb", "😀", "😁", "a😀b", "a😁b", "😀\r\n", "print  1", "print 1\n"];
  for (const before of samples) for (const after of samples) {
    const change = changedRange(before, after);
    assert.equal(change ? before.slice(0, change.start) + change.text + before.slice(change.end) : before, after);
    if (change) for (const point of [change.start, change.end]) {
      assert.ok(!(before[point - 1] === "\r" && before[point] === "\n"));
      assert.ok(!(/[\uD800-\uDBFF]/.test(before[point - 1] ?? "") && /[\uDC00-\uDFFF]/.test(before[point] ?? "")));
    }
  }
});

test("packaged formatter uses the same parser and behavior as the CLI", async () => {
  const bundled = await import("../editors/vscode/dist/formatter/format.js");
  for (const source of [
    'shout is function takes word return word.to_upper_case run\nprint  shout "hello"',
    'export function greet takes name as text, title as maybe text, giving text\n    return name',
    'result is first_choice or\n      second_choice or\n          last_choice\n'
  ]) {
    const formatted = format(source, { width: 40 });
    assert.equal(bundled.format(source, { width: 40 }), formatted);
    assert.equal(bundled.format(formatted, { width: 40 }), formatted);
  }
  const manifest = JSON.parse(readFileSync(new URL("../editors/vscode/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.main, "./extension.cjs");
  assert.equal(manifest.contributes.configuration.properties["prose.format.width"].default, 80);
});

test("extension activation registers the document formatter and disposes it with the context", () => {
  const registrations = [];
  const disposable = { dispose() {} };
  const vscode = { languages: { registerDocumentFormattingEditProvider: (language, provider) => {
    registrations.push({ language, provider });
    return disposable;
  } } };
  const exports = {};
  const diagnostics = { dispose() {} };
  const hovers = { dispose() {} };
  const source = readFileSync(new URL("../editors/vscode/extension.cjs", import.meta.url), "utf8");
  runInNewContext(source, { exports, require: name => name === "vscode" ? vscode
    : name === "./formatting.cjs" ? { createProvider } : name === "./checking.cjs" ? { createDiagnostics: api => {
      assert.equal(api, vscode);
      return diagnostics;
    } } : { createLanguageFeatures: api => {
      assert.equal(name, "./hovering.cjs");
      assert.equal(api, vscode);
      return hovers;
    } } });
  const context = { subscriptions: [] };
  exports.activate(context);
  assert.equal(registrations[0].language, "prose");
  assert.equal(typeof registrations[0].provider.provideDocumentFormattingEdits, "function");
  assert.deepEqual(context.subscriptions, [disposable, diagnostics, hovers]);
});
