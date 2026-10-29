import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkProject } from "../src/check-project.js";
import { build } from "../editors/vscode/build.mjs";

const require = createRequire(import.meta.url);
const { createDiagnostics, diagnosticRange } = require("../editors/vscode/checking.cjs");
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prose editor 😀 "));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
    return join(root, file);
  };
  write("package.json", '{"type":"module"}');
  write("tsconfig.json", '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]},"include":["src"]}');
  return { root, write, close: () => rmSync(root, { recursive: true, force: true }) };
}

function editor(f, { trusted = true, enabled = true } = {}) {
  const documents = [], jobs = [], entries = new Map(), logs = [], events = {}, commands = new Map();
  const uri = file => ({ scheme: "file", fsPath: file, toString: () => pathToFileURL(file).href });
  const listen = name => callback => {
    (events[name] ??= new Set()).add(callback);
    return { dispose: () => events[name].delete(callback) };
  };
  const collection = {
    clear: () => entries.clear(), set: values => { for (const [uri, diagnostics] of values) entries.set(uri.fsPath, diagnostics); },
    dispose() { this.disposed = true; entries.clear(); }
  };
  const output = { appendLine: text => logs.push(text), dispose() { this.disposed = true; } };
  const vscode = {
    Range: class { constructor(line, character, endLine, endCharacter) {
      this.start = { line, character }; this.end = { line: endLine, character: endCharacter };
    } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Uri: { file: uri },
    languages: { createDiagnosticCollection: name => { assert.equal(name, "prose"); return collection; } },
    window: { createOutputChannel: name => { assert.equal(name, "Prose"); return output; } },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose: () => commands.delete(name) }; } },
    workspace: {
      textDocuments: documents, isTrusted: trusted,
      getConfiguration: () => ({ get: (key, fallback) => key === "check.enabled" ? enabled : fallback }),
      getWorkspaceFolder: () => ({ uri: uri(f.root) }),
      onDidOpenTextDocument: listen("open"), onDidCloseTextDocument: listen("close"),
      onDidSaveTextDocument: listen("save"), onDidChangeTextDocument: listen("change"),
      onDidChangeConfiguration: listen("settings"), onDidChangeWorkspaceFolders: listen("folders"),
      onDidGrantWorkspaceTrust: listen("trust"), onDidDeleteFiles: listen("delete"), onDidRenameFiles: listen("rename")
    }
  };
  const add = (file, text = 'print 1', extra = {}) => {
    const path = f.write(file, text);
    const document = { uri: uri(path), languageId: "prose", isClosed: false, isDirty: false, version: 1, getText: () => text, ...extra };
    documents.push(document);
    return document;
  };
  const runCheck = options => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { options, promise, resolve, reject, canceled: 0, cancel() { this.canceled++; } };
    jobs.push(job);
    return job;
  };
  const fire = (name, value) => { for (const callback of events[name] ?? []) callback(value); };
  return {
    vscode, documents, jobs, entries, collection, output, logs, events, commands, add, fire,
    start: () => createDiagnostics(vscode, { runCheck, delay: 0 }),
    setEnabled: value => { enabled = value; fire("settings", { affectsConfiguration: key => key === "prose.check" }); }
  };
}

const error = (file, line = 1, column = 1) => ({
  file, line, column, code: 2322, severity: "error", source: "typescript", message: "Type of '_prose_count' is wrong."
});
const result = (files, diagnostics = []) => ({ files, diagnostics, exitCode: diagnostics.length ? 1 : 0 });

test("editor publishes mapped diagnostics for a saved file and its closed Prose dependency", async () => {
  const f = fixture(), e = editor(f);
  const document = e.add("src/main.prose", 'export count as number is "bad"');
  const child = f.write("src/child.prose", 'function wrong giving number\n    return "bad"');
  const service = e.start();
  try {
    await pause();
    assert.deepEqual(e.jobs[0].options.targets, [document.uri.fsPath]);
    assert.equal(e.jobs[0].options.project, join(f.root, "tsconfig.json"));
    e.jobs[0].resolve(result([document.uri.fsPath, child], [error(document.uri.fsPath), error(child, 2, 5)]));
    await pause();
    assert.equal(e.entries.size, 2);
    const diagnostic = e.entries.get(child)[0];
    assert.deepEqual(diagnostic.range.start, { line: 1, character: 4 });
    assert.deepEqual(diagnostic.range.end, { line: 1, character: 10 });
    assert.equal(diagnostic.source, "Prose");
    assert.equal(diagnostic.code, "TS2322");
    assert.equal(diagnostic.message, "Type of 'count' is wrong.");
  } finally { service.dispose(); f.close(); }
});

test("edits clear markers, cancel running checks, and prevent older results replacing a saved fix", async () => {
  const f = fixture(), e = editor(f);
  const document = e.add("src/main.prose");
  const service = e.start();
  try {
    await pause();
    document.version++; document.isDirty = true;
    e.fire("change", { document, contentChanges: [{ text: "2" }] });
    assert.equal(e.jobs[0].canceled, 1);
    assert.equal(e.entries.size, 0);
    document.isDirty = false;
    e.fire("save", document);
    await pause();
    e.jobs[1].resolve(result([document.uri.fsPath]));
    await pause();
    e.jobs[0].resolve(result([document.uri.fsPath], [error(document.uri.fsPath)]));
    await pause();
    assert.equal(e.entries.size, 0);
    const checking = e.commands.get("prose.check")();
    e.jobs[2].resolve(result([document.uri.fsPath], [error(document.uri.fsPath)]));
    await checking;
    assert.equal(e.entries.size, 1);
    document.version++; document.isDirty = true;
    e.fire("change", { document, contentChanges: [{ text: "3" }] });
    assert.equal(e.entries.size, 0);
  } finally { service.dispose(); f.close(); }
});

test("checking waits for trust and honors disabling it while a worker is running", async () => {
  const f = fixture(), e = editor(f, { trusted: false });
  const document = e.add("src/main.prose");
  const service = e.start();
  try {
    await pause();
    assert.equal(e.jobs.length, 0);
    await e.commands.get("prose.check")();
    assert.equal(e.jobs.length, 0);
    e.vscode.workspace.isTrusted = true;
    e.fire("trust");
    await pause();
    assert.equal(e.jobs.length, 1);
    e.setEnabled(false);
    assert.equal(e.jobs[0].canceled, 1);
    e.jobs[0].resolve(result([document.uri.fsPath], [error(document.uri.fsPath)]));
    await pause();
    assert.equal(e.entries.size, 0);
    e.setEnabled(true);
    await pause();
    assert.equal(e.jobs.length, 2);
  } finally { service.dispose(); f.close(); }
});

test("unsaved, dirty, and virtual documents do not start disk checks", async () => {
  const f = fixture(), e = editor(f);
  e.add("src/dirty.prose", "print 1", { isDirty: true });
  e.add("src/untitled.prose", "print 1", { uri: { scheme: "untitled", fsPath: "untitled" } });
  e.add("src/virtual.prose", "print 1", { uri: { scheme: "vscode-vfs", fsPath: "virtual" } });
  e.add("src/other.txt", "print 1");
  const service = e.start();
  try { await pause(); assert.equal(e.jobs.length, 0); }
  finally { service.dispose(); f.close(); }
});

test("dirty imported buffers never receive disk diagnostics", async () => {
  const f = fixture(), e = editor(f);
  const main = e.add("src/main.prose");
  const dirty = e.add("src/dirty.prose", 'print "unsaved"', { isDirty: true });
  const service = e.start();
  try {
    await pause();
    assert.deepEqual(e.jobs[0].options.targets, [main.uri.fsPath]);
    e.jobs[0].resolve(result([main.uri.fsPath, dirty.uri.fsPath], [error(dirty.uri.fsPath)]));
    await pause();
    assert.equal(e.entries.size, 0);
  } finally { service.dispose(); f.close(); }
});

test("nested projects get separate jobs and edits in one project do not discard another's result", async () => {
  const f = fixture(), e = editor(f);
  f.write("one/tsconfig.json", "{}"); f.write("two/tsconfig.json", "{}");
  const one = e.add("one/main.prose"), two = e.add("two/main.prose");
  const service = e.start();
  try {
    await pause();
    assert.equal(e.jobs.length, 2);
    one.version++; one.isDirty = true;
    e.fire("change", { document: one, contentChanges: [{ text: "2" }] });
    assert.equal(e.jobs[0].canceled, 1);
    assert.equal(e.jobs[1].canceled, 0);
    e.jobs[1].resolve(result([two.uri.fsPath], [error(two.uri.fsPath)]));
    await pause();
    assert.equal(e.entries.size, 1);
    assert.ok(e.entries.has(two.uri.fsPath));
  } finally { service.dispose(); f.close(); }
});

test("saving a TypeScript dependency rechecks open Prose roots and a clean result removes stale diagnostics", async () => {
  const f = fixture(), e = editor(f);
  const main = e.add("src/main.prose"), types = e.add("src/types.ts", "export type Thing = string", { languageId: "typescript" });
  const service = e.start();
  try {
    await pause();
    e.jobs[0].resolve(result([main.uri.fsPath], [error(main.uri.fsPath)]));
    await pause();
    assert.equal(e.entries.size, 1);
    e.fire("save", types);
    await pause();
    assert.deepEqual(e.jobs[1].options.targets, [main.uri.fsPath]);
    e.jobs[1].resolve(result([main.uri.fsPath]));
    await pause();
    assert.equal(e.entries.size, 0);
  } finally { service.dispose(); f.close(); }
});

test("setup errors appear on the project config and are logged without popup notifications", async () => {
  const f = fixture(), e = editor(f);
  e.add("src/main.prose");
  const service = e.start();
  try {
    await pause();
    e.jobs[0].resolve({ files: [], exitCode: 2, diagnostics: [{
      source: "configuration", code: "PROSE_CHECK_SETUP", severity: "error", message: "TypeScript is not installed."
    }] });
    await pause();
    const diagnostic = e.entries.get(join(f.root, "tsconfig.json"))[0];
    assert.match(diagnostic.message, /^Type checking setup: TypeScript is not installed/);
    assert.equal(diagnostic.range.start.line, 0);
    assert.equal(e.logs.length, 1);
  } finally { service.dispose(); f.close(); }
});

test("closing roots clears diagnostics, and disposal removes subscriptions and stops workers", async () => {
  const f = fixture(), e = editor(f);
  const document = e.add("src/main.prose");
  const service = e.start();
  try {
    await pause();
    e.jobs[0].resolve(result([document.uri.fsPath], [error(document.uri.fsPath)]));
    await pause();
    assert.equal(e.entries.size, 1);
    document.isClosed = true;
    e.fire("close", document);
    assert.equal(e.entries.size, 0);
    document.isClosed = false;
    e.fire("open", document);
    await pause();
    service.dispose();
    assert.equal(e.jobs[1].canceled, 1);
    assert.equal(e.commands.size, 0);
    assert.ok(Object.values(e.events).every(listeners => listeners.size === 0));
    assert.ok(e.output.disposed && e.collection.disposed);
    e.jobs[1].resolve(result([document.uri.fsPath], [error(document.uri.fsPath)]));
    await pause();
    assert.equal(e.entries.size, 0);
  } finally { f.close(); }
});

test("diagnostic ranges clamp positions and preserve an emoji's UTF-16 width", () => {
  const f = fixture(), { vscode } = editor(f);
  try {
    const range = diagnosticRange(vscode, 'print 😀\r\n', { line: 1, column: 7 });
    assert.deepEqual(range.start, { line: 0, character: 6 });
    assert.deepEqual(range.end, { line: 0, character: 8 });
    assert.deepEqual(diagnosticRange(vscode, "", { line: 20, column: 40 }).start, { line: 0, character: 0 });
  } finally { f.close(); }
});

function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "node_modules") return [];
    const file = join(root, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, readFileSync(file, "utf8")]];
  }));
}

function packagedChecker(f) {
  // Each test builds a separate package, including when Node runs test files in
  // parallel. Windows cannot copy over a module another process is loading.
  for (const name of ["checking.cjs", "check-worker.cjs"]) {
    f.write(`extension/${name}`, readFileSync(new URL(`../editors/vscode/${name}`, import.meta.url)));
  }
  build(pathToFileURL(join(f.root, "extension/dist/formatter") + "/"));
  return require(join(f.root, "extension/checking.cjs")).startCheck;
}

test("packaged worker matches the CLI checker, uses project TypeScript, and never executes or writes application files", async () => {
  const f = fixture();
  try {
    const startCheck = packagedChecker(f);
    f.write("node_modules/typescript/package.json", '{"main":"index.cjs"}');
    f.write("node_modules/typescript/index.cjs", `module.exports = { ...require(${JSON.stringify(require.resolve("typescript"))}), version: "workspace-test" };`);
    const main = f.write("src/main.prose", [
      'use value from "./child.prose"', 'fail "must never run"', 'print value run',
      'type Point is object', '    value as number or null',
      'function values takes points as list of Point, giving list of number',
      '    present is points.filter function takes point return point.value != null',
      '    return present.map function takes point return point.value',
      'function side takes ready as boolean, giving "a" or "b"',
      '    if ready', '    or false', '        name is "a"', '    else name is "b"', '    return name'
    ].join('\n'));
    f.write("src/child.prose", 'export function value giving number\n    return "wrong"');
    f.write("src/child.d.prose.ts", 'export function value(): string;');
    const before = snapshot(f.root);
    const options = { cwd: f.root, project: join(f.root, "tsconfig.json"), targets: [main] };
    const checked = await startCheck(options).promise;
    assert.deepEqual(checked, checkProject(options));
    assert.equal(checked.typescriptVersion, "workspace-test");
    assert.equal(checked.files.length, 2);
    assert.equal(checked.diagnostics.length, 1);
    assert.equal(checked.diagnostics[0].line, 2);
    assert.deepEqual(snapshot(f.root), before);
    const manifest = JSON.parse(readFileSync(new URL("../editors/vscode/package.json", import.meta.url), "utf8"));
    assert.ok(manifest.files.includes("checking.cjs") && manifest.files.includes("check-worker.cjs"));
    assert.equal(manifest.contributes.configuration.properties["prose.check.enabled"].default, true);
    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited");
  } finally { f.close(); }
});

test("worker returns setup diagnostics for missing TypeScript and supports cancellation", async () => {
  const f = fixture();
  try {
    const startCheck = packagedChecker(f);
    const main = f.write("src/main.prose", "print 1");
    const options = { cwd: f.root, targets: [main] };
    const checked = await startCheck(options).promise;
    assert.equal(checked.exitCode, 2);
    assert.match(checked.diagnostics[0].message, /TypeScript is not installed/);
    const canceled = startCheck(options);
    canceled.cancel();
    await assert.rejects(canceled.promise, /stopped before returning/);
  } finally { f.close(); }
});
