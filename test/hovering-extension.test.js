import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const { createHovers } = createRequire(import.meta.url)("../editors/vscode/hovering.cjs");

function editor({ trusted = true, enabled = true, definitions = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "prose hover editor "));
  const events = {}, documents = [], jobs = [], logs = [];
  let provider, definitionProvider, registrationDisposed = false, definitionDisposed = false;
  const uri = file => ({ scheme: "file", fsPath: file });
  const listen = name => callback => {
    (events[name] ??= new Set()).add(callback);
    return { dispose: () => events[name].delete(callback) };
  };
  const output = { appendLine: text => logs.push(text), dispose() { this.disposed = true; } };
  const watcher = { onDidChange: listen("disk"), onDidCreate: listen("created"), onDidDelete: listen("deleted"), dispose() { this.disposed = true; } };
  const vscode = {
    Range: class { constructor(line, character, endLine, endCharacter) {
      this.start = { line, character }; this.end = { line: endLine, character: endCharacter };
    } },
    Hover: class { constructor(markdown, range) { this.contents = [markdown]; this.range = range; } },
    MarkdownString: class {
      constructor() { this.parts = []; }
      appendCodeblock(code, language) { this.parts.push({ code, language }); }
      appendText(text) { this.parts.push({ text }); }
    },
    window: { createOutputChannel: () => output },
    Uri: { file: uri },
    languages: { registerHoverProvider: (selector, value) => {
      assert.deepEqual(selector, { language: "prose", scheme: "file" });
      provider = value;
      return { dispose: () => { registrationDisposed = true; } };
    }, registerDefinitionProvider: (selector, value) => {
      assert.deepEqual(selector, { language: "prose", scheme: "file" });
      definitionProvider = value;
      return { dispose: () => { definitionDisposed = true; } };
    } },
    workspace: {
      isTrusted: trusted, textDocuments: documents,
      getConfiguration: () => ({ get: (key, fallback) => key === "hover.enabled" ? enabled : key === "definition.enabled" ? definitions : fallback }),
      getWorkspaceFolder: () => ({ uri: uri(root) }),
      createFileSystemWatcher: () => watcher,
      onDidOpenTextDocument: listen("open"), onDidCloseTextDocument: listen("close"), onDidSaveTextDocument: listen("save"),
      onDidChangeTextDocument: listen("change"), onDidChangeConfiguration: listen("settings"),
      onDidChangeWorkspaceFolders: listen("folders"), onDidGrantWorkspaceTrust: listen("trust"),
      onDidDeleteFiles: listen("delete"), onDidRenameFiles: listen("rename")
    }
  };
  const write = (name, text) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  const add = (name, text = 'count is 1', extra = {}) => {
    const document = { uri: uri(write(name, text)), text, languageId: name.endsWith('.prose') ? 'prose' : 'typescript',
      version: 1, isDirty: false, isClosed: false, getText() { return this.text; }, ...extra };
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
  const service = createHovers(vscode, { runCheck });
  return { root, jobs, logs, documents, output, watcher, events, service, vscode, add, write, fire,
    request: (document, token = cancellation(), position = { line: 0, character: 2 }) => provider.provideHover(document, position, token),
    definition: (document, token = cancellation(), position = { line: 0, character: 2 }) => definitionProvider.provideDefinition(document, position, token),
    setEnabled: value => { enabled = value; fire('settings', { affectsConfiguration: () => true }); },
    setDefinitions: value => { definitions = value; fire('settings', { affectsConfiguration: key => key === 'prose.definition' }); },
    close() { service.dispose(); assert.ok(registrationDisposed && definitionDisposed); rmSync(root, { recursive: true, force: true }); } };
}
function cancellation() {
  const listeners = new Set();
  return { isCancellationRequested: false, listeners,
    onCancellationRequested(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    cancel() { this.isCancellationRequested = true; for (const callback of listeners) callback(); } };
}
const result = (document, code = 'count as 1', documentation = '') => ({ exitCode: 0, diagnostics: [], files: [document.uri.fsPath], hovers: [
  { file: document.uri.fsPath, line: 1, column: 1, endColumn: 6, code, documentation }
] });

test("hover provider caches a project snapshot, includes dirty buffers, and renders safe Markdown", async () => {
  const e = editor();
  const document = e.add('main.prose', 'count is 2', { isDirty: true });
  try {
    const pending = e.request(document);
    assert.equal(e.jobs.length, 1);
    assert.deepEqual(e.jobs[0].options.overlays, [[document.uri.fsPath, 'count is 2']]);
    assert.deepEqual(e.jobs[0].options.hoverTargets, [document.uri.fsPath]);
    e.jobs[0].resolve(result(document, 'count as 2', '[unsafe](command:danger) <script>'));
    const hover = await pending;
    assert.deepEqual(hover.range.start, { line: 0, character: 0 });
    assert.deepEqual(hover.range.end, { line: 0, character: 5 });
    assert.deepEqual(hover.contents[0].parts, [{ code: 'count as 2', language: 'prose' }, { text: '\n\n[unsafe](command:danger) <script>' }]);
    assert.equal(hover.contents[0].isTrusted, false);
    assert.equal(hover.contents[0].supportHtml, false);
    assert.ok(await e.request(document));
    assert.equal(e.jobs.length, 1);
    assert.equal(await e.request(document, cancellation(), { line: 0, character: 5 }), undefined);
  } finally { e.close(); }
});

test("edits cancel pending snapshots and older results cannot replace current hover types", async () => {
  const e = editor(), document = e.add('main.prose');
  try {
    const old = e.request(document);
    document.version++; document.text = 'count is "new"'; document.isDirty = true;
    e.fire('change', { document, contentChanges: [{ text: '"new"' }] });
    assert.equal(e.jobs[0].canceled, 1);
    const current = e.request(document);
    e.jobs[1].resolve(result(document, 'count as "new"'));
    assert.equal((await current).contents[0].parts[0].code, 'count as "new"');
    e.jobs[0].resolve(result(document));
    assert.equal(await old, undefined);
    assert.ok(e.jobs[1].options.overlays.some(([file, source]) => file === document.uri.fsPath && source.includes('"new"')));
    e.fire('disk', document.uri);
    const afterDiskChange = e.request(document);
    assert.equal(e.jobs.length, 3);
    e.jobs[2].resolve(result(document, 'count as "new"'));
    assert.ok(await afterDiskChange);
    // Version checks also protect the interval before an edit event is handled.
    document.version++; document.text = 'count is 3';
    const afterVersionChange = e.request(document);
    assert.equal(e.jobs.length, 4);
    e.jobs[3].resolve(result(document, 'count as 3'));
    assert.equal((await afterVersionChange).contents[0].parts[0].code, 'count as 3');
  } finally { e.close(); }
});

test("canceling a hover returns promptly while its snapshot can serve the next request", async () => {
  const e = editor(), document = e.add('main.prose');
  try {
    const token = cancellation(), pending = e.request(document, token);
    token.cancel();
    assert.equal(await pending, undefined);
    assert.equal(token.listeners.size, 0);
    const next = e.request(document);
    assert.equal(e.jobs.length, 1);
    e.jobs[0].resolve(result(document));
    assert.ok(await next);
  } finally { e.close(); }
});

test("a late disk notification retries a settled buffer once", async () => {
  const e = editor(), document = e.add('main.prose');
  try {
    const pending = e.request(document);
    e.fire('disk', document.uri);
    e.jobs[0].resolve(result(document));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.jobs.length, 2);
    e.jobs[1].resolve(result(document));
    assert.ok(await pending);
    e.fire('disk', document.uri);
    const bounded = e.request(document);
    e.fire('disk', document.uri);
    e.jobs[2].resolve(result(document));
    await new Promise(resolve => setImmediate(resolve));
    e.fire('disk', document.uri);
    e.jobs[3].resolve(result(document));
    assert.equal(await bounded, undefined);
    assert.equal(e.jobs.length, 4);
  } finally { e.close(); }
});

test("hover types require trust, honor their own setting, and ignore virtual documents", async () => {
  const e = editor({ trusted: false }), document = e.add('main.prose');
  try {
    assert.equal(await e.request(document), undefined);
    assert.equal(e.jobs.length, 0);
    e.vscode.workspace.isTrusted = true;
    e.setEnabled(false);
    assert.equal(await e.request(document), undefined);
    e.setEnabled(true);
    const pending = e.request(document);
    e.setEnabled(false);
    assert.equal(e.jobs[0].canceled, 1);
    e.jobs[0].resolve(result(document));
    assert.equal(await pending, undefined);
    e.setEnabled(true);
    document.uri.scheme = 'untitled';
    assert.equal(await e.request(document), undefined);
  } finally { e.close(); }
});

test("nearest configurations isolate hover projects and include unsaved dependencies", async () => {
  const e = editor();
  e.write('tsconfig.json', '{}'); e.write('child/tsconfig.json', '{}');
  const first = e.add('main.prose'), second = e.add('child/main.prose');
  const dependency = e.add('child/types.ts', 'export type Count = number', { isDirty: true });
  try {
    const a = e.request(first), b = e.request(second);
    assert.equal(e.jobs.length, 2);
    assert.equal(e.jobs[0].options.project, join(e.root, 'tsconfig.json'));
    assert.equal(e.jobs[1].options.project, join(e.root, 'child/tsconfig.json'));
    assert.deepEqual(e.jobs[0].options.targets, [first.uri.fsPath]);
    assert.deepEqual(e.jobs[1].options.targets, [second.uri.fsPath]);
    assert.ok(e.jobs[1].options.overlays.some(([file]) => file === dependency.uri.fsPath));
    e.jobs[0].resolve(result(first)); e.jobs[1].resolve(result(second));
    assert.ok(await a); assert.ok(await b);
  } finally { e.close(); }
});

test("setup failures stay out of hover content and disposal releases workers and listeners", async () => {
  const e = editor(), document = e.add('main.prose');
  try {
    const pending = e.request(document);
    e.jobs[0].resolve({ exitCode: 2, files: [], diagnostics: [{ message: 'TypeScript is not installed' }] });
    assert.equal(await pending, undefined);
    assert.deepEqual(e.logs, ['TypeScript is not installed']);
    e.fire('save', document);
    const next = e.request(document);
    e.service.dispose();
    assert.equal(e.jobs[1].canceled, 1);
    e.jobs[1].resolve(result(document));
    assert.equal(await next, undefined);
    assert.ok(Object.values(e.events).every(listeners => listeners.size === 0));
    assert.ok(e.output.disposed && e.watcher.disposed);
  } finally { e.close(); }
});

test("definitions share the hover snapshot and return original source selection ranges", async () => {
  const e = editor(), document = e.add('main.prose'), child = e.write('child.prose', 'count is 1');
  try {
    const hover = e.request(document), definition = e.definition(document);
    assert.equal(e.jobs.length, 1);
    assert.deepEqual(e.jobs[0].options.definitionTargets, [document.uri.fsPath]);
    const data = result(document);
    data.definitions = [{ file: document.uri.fsPath, line: 1, column: 1, endColumn: 6,
      targets: [{ file: child, line: 1, column: 1, endColumn: 6 }] }];
    e.jobs[0].resolve(data);
    assert.ok(await hover);
    const [link] = await definition;
    assert.equal(link.targetUri.fsPath, child);
    assert.deepEqual(link.originSelectionRange.start, { line: 0, character: 0 });
    assert.deepEqual(link.targetSelectionRange.end, { line: 0, character: 5 });
    assert.equal((await e.definition(document)).length, 1);
    assert.equal(e.jobs.length, 1);
  } finally { e.close(); }
});

test("definition navigation has an independent setting and respects cancellation and newer edits", async () => {
  const e = editor({ enabled: false }), document = e.add('main.prose');
  try {
    assert.equal(await e.request(document), undefined);
    const token = cancellation(), canceled = e.definition(document, token);
    assert.deepEqual(e.jobs[0].options.hoverTargets, []);
    token.cancel();
    assert.equal(await canceled, undefined);
    const pending = e.definition(document);
    document.version++; e.fire('change', { document, contentChanges: [{ text: '2' }] });
    e.jobs[0].resolve(result(document));
    assert.equal(await pending, undefined);
    e.setDefinitions(false);
    assert.equal(await e.definition(document), undefined);
    assert.equal(e.jobs.length, 1);
  } finally { e.close(); }
});
