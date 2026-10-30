import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionContext } from '../src/completions.js';
const { createCompletions } = createRequire(import.meta.url)('../editors/vscode/completing.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function token() {
  const listeners = new Set();
  return { isCancellationRequested: false, listeners, onCancellationRequested(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; }, cancel() { this.isCancellationRequested = true; listeners.forEach(callback => callback()); } };
}
function editor({ enabled = true, trusted = true, loadContext = async () => ({ completionContext }) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prose completion provider ')), documents = [], jobs = [], logs = [], events = {};
  let provider, registrationDisposed = false;
  const listen = name => callback => { (events[name] ??= new Set()).add(callback); return { dispose: () => events[name].delete(callback) }; };
  const output = { appendLine: text => logs.push(text), dispose() { this.disposed = true; } };
  const watcher = { onDidChange: listen('disk'), onDidCreate: listen('created'), onDidDelete: listen('deleted'), dispose() {} };
  const vscode = {
    CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
    CompletionItemKind: { Method: 1, Property: 2, Function: 3, Variable: 4 },
    CompletionList: class { constructor(items, isIncomplete) { Object.assign(this, { items, isIncomplete }); } },
    Range: class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } },
    MarkdownString: class { constructor() { this.parts = []; } appendText(text) { this.parts.push(text); } },
    window: { createOutputChannel: () => output },
    languages: { registerCompletionItemProvider(selector, value, ...triggers) { assert.deepEqual(selector, { language: 'prose', scheme: 'file' }); assert.deepEqual(triggers, ['.', ':']); provider = value; return { dispose() { registrationDisposed = true; } }; } },
    workspace: { isTrusted: trusted, textDocuments: documents,
      getConfiguration: () => ({ get: (key, fallback) => key === 'completion.enabled' ? enabled : fallback }),
      getWorkspaceFolder: () => ({ uri: { scheme: 'file', fsPath: root } }), createFileSystemWatcher: () => watcher,
      onDidChangeTextDocument: listen('change'), onDidOpenTextDocument: listen('open'), onDidCloseTextDocument: listen('close'), onDidSaveTextDocument: listen('save'),
      onDidChangeConfiguration: listen('settings'), onDidChangeWorkspaceFolders: listen('folders'), onDidGrantWorkspaceTrust: listen('trust'), onDidDeleteFiles: listen('delete'), onDidRenameFiles: listen('rename') }
  };
  const runCheck = options => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); const job = { options, promise, resolve, reject, canceled: 0, cancel() { this.canceled++; } }; jobs.push(job); return job; };
  const service = createCompletions(vscode, { runCheck, loadContext });
  const add = (name, text = 'book.', extra = {}) => { const file = join(root, name); writeFileSync(file, text); const document = { uri: { scheme: 'file', fsPath: file }, languageId: name.endsWith('.prose') ? 'prose' : 'typescript', version: 1, isDirty: false, isClosed: false, text, getText() { return this.text; }, ...extra }; documents.push(document); return document; };
  const fire = (name, value) => { for (const callback of events[name] ?? []) callback(value); };
  return { vscode, jobs, logs, output, documents, fire, add, request: (document, cancellation = token(), position = { line: 0, character: document.text.length }) => provider.provideCompletionItems(document, position, cancellation),
    setEnabled(value) { enabled = value; fire('settings', { affectsConfiguration: key => key === 'prose.completion' }); },
    close() { service.dispose(); assert.ok(registrationDisposed); rmSync(root, { recursive: true, force: true }); } };
}
const response = { exitCode: 0, diagnostics: [], items: [{ label: 'title', insertText: 'title', filterText: 'title', kind: 'property', detail: 'title as text', documentation: '[unsafe](command:danger) <script>', line: 1, startColumn: 6, endColumn: 6 }] };

test('completion provider caches identical requests, includes dirty dependencies, and renders safe documentation', async () => {
  const e = editor(), main = e.add('main.prose', 'book.', { isDirty: true }), dependency = e.add('data.ts', 'export const count = 1;', { isDirty: true });
  try {
    const pending = e.request(main); await tick();
    assert.equal(e.jobs.length, 1);
    assert.deepEqual(e.jobs[0].options.completion, { file: main.uri.fsPath, line: 1, column: 6 });
    assert.deepEqual(e.jobs[0].options.overlays, [[main.uri.fsPath, 'book.'], [dependency.uri.fsPath, dependency.text]]);
    e.jobs[0].resolve(response);
    const list = await pending;
    assert.equal(list.isIncomplete, false);
    assert.equal(list.items[0].label, 'title');
    assert.deepEqual(list.items[0].range.start, { line: 0, character: 5 });
    assert.equal(list.items[0].documentation.isTrusted, false);
    assert.equal(list.items[0].documentation.supportHtml, false);
    assert.deepEqual(list.items[0].documentation.parts, ['[unsafe](command:danger) <script>']);
    assert.ok(await e.request(main)); assert.equal(e.jobs.length, 1);
  } finally { e.close(); }
});

test('completion edits, cancellation and late disk changes never publish stale suggestions', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const old = e.request(main); await tick();
    main.version++; main.text = 'book.t'; e.fire('change', { document: main, contentChanges: [{ text: 't' }] });
    assert.equal(e.jobs[0].canceled, 1);
    const fresh = e.request(main); await tick(); e.jobs[1].resolve(response); assert.ok(await fresh);
    e.jobs[0].resolve(response); assert.equal(await old, undefined);
    const cancellation = token(); e.fire('disk'); const canceled = e.request(main, cancellation); await tick(); cancellation.cancel(); assert.equal(await canceled, undefined); assert.equal(cancellation.listeners.size, 0);
    const retry = e.request(main); await tick(); e.fire('disk'); e.jobs[2].resolve(response); await tick();
    assert.equal(e.jobs.length, 4); e.jobs[3].resolve(response); assert.ok(await retry);
  } finally { e.close(); }
});

test('completions require trust and their own setting, and skip strings and virtual documents', async () => {
  const e = editor({ trusted: false }), main = e.add('main.prose');
  try {
    assert.equal(await e.request(main), undefined); assert.equal(e.jobs.length, 0);
    e.vscode.workspace.isTrusted = true; e.setEnabled(false);
    assert.equal(await e.request(main), undefined); assert.equal(e.jobs.length, 0);
    e.setEnabled(true); main.text = 'print "book."'; main.version++;
    assert.equal(await e.request(main, token(), { line: 0, character: 12 }), undefined); assert.equal(e.jobs.length, 0);
    main.text = 'book.'; main.uri.scheme = 'untitled';
    assert.equal(await e.request(main), undefined); assert.equal(e.jobs.length, 0);
  } finally { e.close(); }
});

test('setup errors stay in Output and a disabled feature cannot publish a pending list', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const pending = e.request(main); await tick(); e.jobs[0].resolve({ exitCode: 2, diagnostics: [{ message: 'Install TypeScript' }] });
    assert.equal(await pending, undefined); assert.match(e.logs.join('\n'), /Install TypeScript/);
    e.fire('disk'); const next = e.request(main); await tick(); e.setEnabled(false); e.jobs[1].resolve(response);
    assert.equal(await next, undefined);
  } finally { e.close(); }
});

test('method completions preserve colon escape edit ranges and filter text', async () => {
  const e = editor(), main = e.add('main.prose', 'words.ma');
  try {
    const pending = e.request(main); await tick(); e.jobs[0].resolve({ ...response, items: [{ ...response.items[0], label: 'map', kind: 'method', insertText: ':map', filterText: '.map', startColumn: 6, endColumn: 9 }] });
    const list = await pending;
    assert.equal(list.items[0].insertText, ':map'); assert.equal(list.items[0].filterText, '.map');
    assert.equal(list.items[0].kind, e.vscode.CompletionItemKind.Method);
    assert.deepEqual(list.items[0].range, new e.vscode.Range(0, 5, 0, 8));
  } finally { e.close(); }
});

test('identifier suggestions retain kinds, signatures, complete token ranges and plain text insertion', async () => {
  const e = editor(), main = e.add('main.prose', 'print cipher');
  try {
    const pending = e.request(main, token(), { line: 0, character: 9 }); await tick();
    assert.equal(e.jobs.length, 1);
    e.jobs[0].resolve({ ...response, items: [
      { ...response.items[0], label: 'cipher', kind: 'function', insertText: 'cipher', filterText: 'cipher', detail: 'function cipher takes text as text giving text', startColumn: 7, endColumn: 13 },
      { ...response.items[0], label: 'letter_count', kind: 'variable', insertText: 'letter_count', filterText: 'letter_count', detail: 'letter_count as number', startColumn: 7, endColumn: 13 }
    ] });
    const list = await pending;
    assert.deepEqual(list.items.map(item => item.kind), [e.vscode.CompletionItemKind.Function, e.vscode.CompletionItemKind.Variable]);
    assert.equal(list.items[0].insertText, 'cipher'); assert.match(list.items[0].detail, /takes text/);
    assert.deepEqual(list.items[0].range, new e.vscode.Range(0, 6, 0, 12));
    assert.equal(list.items[1].insertText, 'letter_count');
  } finally { e.close(); }
});

test('identifier requests use current callback buffers and suppress stale lists after edits', async () => {
  const e = editor(), main = e.add('main.prose', 'names is "A", "B"\nnames.map function takes name\n    return na', { isDirty: true });
  try {
    const pending = e.request(main, token(), { line: 2, character: 13 }); await tick();
    assert.equal(e.jobs.length, 1); assert.equal(e.jobs[0].options.overlays[0][1], main.text);
    assert.deepEqual(e.jobs[0].options.completion, { file: main.uri.fsPath, line: 3, column: 14 });
    main.version++; main.text += 'me'; e.fire('change', { document: main, contentChanges: [{ text: 'me' }] });
    e.jobs[0].resolve(response); assert.equal(await pending, undefined);
  } finally { e.close(); }
});
