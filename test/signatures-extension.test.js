import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signatureContexts } from '../src/signature-help.js';
const { createSignatureHelp } = createRequire(import.meta.url)('../editors/vscode/signatures.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function token() {
  const listeners = new Set();
  return { isCancellationRequested: false, listeners, onCancellationRequested(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; }, cancel() { this.isCancellationRequested = true; listeners.forEach(callback => callback()); } };
}
function editor({ trusted = true, loadContext = async () => ({ signatureContexts }) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prose parameter provider ')), documents = [], jobs = [], logs = [], events = {};
  let provider, registrationDisposed = false, enabled = true;
  const listen = name => callback => { (events[name] ??= new Set()).add(callback); return { dispose: () => events[name].delete(callback) }; };
  const output = { appendLine: text => logs.push(text), dispose() { this.disposed = true; } };
  const watcher = { onDidChange: listen('disk'), onDidCreate: listen('created'), onDidDelete: listen('deleted'), dispose() {} };
  const vscode = {
    SignatureHelp: class {},
    SignatureInformation: class { constructor(label, documentation) { Object.assign(this, { label, documentation }); } },
    ParameterInformation: class { constructor(label, documentation) { Object.assign(this, { label, documentation }); } },
    MarkdownString: class { constructor() { this.parts = []; } appendText(text) { this.parts.push(text); } },
    window: { createOutputChannel: () => output },
    languages: { registerSignatureHelpProvider(selector, value, triggers) { assert.deepEqual(selector, { language: 'prose', scheme: 'file' }); assert.deepEqual(triggers.triggerCharacters, [' ', ',', '(']); provider = value; return { dispose() { registrationDisposed = true; } }; } },
    workspace: { isTrusted: trusted, textDocuments: documents,
      getConfiguration: () => ({ get: (key, fallback) => key === 'signatureHelp.enabled' ? enabled : fallback }),
      getWorkspaceFolder: () => ({ uri: { scheme: 'file', fsPath: root } }), createFileSystemWatcher: () => watcher,
      onDidChangeTextDocument: listen('change'), onDidOpenTextDocument: listen('open'), onDidCloseTextDocument: listen('close'), onDidSaveTextDocument: listen('save'),
      onDidChangeConfiguration: listen('settings'), onDidChangeWorkspaceFolders: listen('folders'), onDidGrantWorkspaceTrust: listen('trust'), onDidDeleteFiles: listen('delete'), onDidRenameFiles: listen('rename') }
  };
  const runCheck = options => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); const job = { options, promise, resolve, reject, canceled: 0, cancel() { this.canceled++; } }; jobs.push(job); return job; };
  const service = createSignatureHelp(vscode, { runCheck, loadContext });
  const add = (name, text = 'cipher "hello", ', extra = {}) => { const file = join(root, name); writeFileSync(file, text); const document = { uri: { scheme: 'file', fsPath: file }, languageId: name.endsWith('.prose') ? 'prose' : 'typescript', version: 1, isDirty: false, isClosed: false, text, getText() { return this.text; }, ...extra }; documents.push(document); return document; };
  const fire = (name, value) => { for (const callback of events[name] ?? []) callback(value); };
  return { vscode, jobs, logs, output, fire, add, request: (document, cancellation = token()) => provider.provideSignatureHelp(document, { line: 0, character: document.text.length }, cancellation),
    setEnabled(value) { enabled = value; fire('settings', { affectsConfiguration: key => key === 'prose.signatureHelp' }); },
    close() { service.dispose(); assert.ok(registrationDisposed); rmSync(root, { recursive: true, force: true }); } };
}
const response = { exitCode: 0, diagnostics: [], signatureHelp: { activeSignature: 0, activeParameter: 1, signatures: [{ label: 'cipher takes message as text, rotate as number giving text',
  activeParameter: 1, documentation: '[unsafe](command:danger) <script>', parameters: [{ label: [13, 28], documentation: 'The message.' }, { label: [30, 46], documentation: 'The rotation.' }] }] } };

test('parameter provider caches current buffers and returns highlight ranges with safe documentation', async () => {
  const e = editor(), main = e.add('main.prose', undefined, { isDirty: true }), dependency = e.add('data.ts', 'export const count = 1;', { isDirty: true });
  try {
    const pending = e.request(main); await tick();
    assert.equal(e.jobs.length, 1);
    assert.deepEqual(e.jobs[0].options.signature, { file: main.uri.fsPath, line: 1, column: main.text.length + 1 });
    assert.deepEqual(e.jobs[0].options.overlays, [[main.uri.fsPath, main.text], [dependency.uri.fsPath, dependency.text]]);
    e.jobs[0].resolve(response);
    const help = await pending;
    assert.equal(help.activeParameter, 1);
    assert.equal(help.signatures[0].activeParameter, 1);
    assert.deepEqual(help.signatures[0].parameters[1].label, [30, 46]);
    assert.equal(help.signatures[0].documentation.isTrusted, false);
    assert.equal(help.signatures[0].documentation.supportHtml, false);
    assert.deepEqual(help.signatures[0].documentation.parts, ['[unsafe](command:danger) <script>']);
    assert.ok(await e.request(main)); assert.equal(e.jobs.length, 1);
  } finally { e.close(); }
});

test('edits, cancellation and changed dependencies cannot return stale parameter hints', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const old = e.request(main); await tick();
    main.version++; main.text += '2'; e.fire('change', { document: main, contentChanges: [{ text: '2' }] });
    assert.equal(e.jobs[0].canceled, 1);
    const fresh = e.request(main); await tick(); e.jobs[1].resolve(response); assert.ok(await fresh);
    e.jobs[0].resolve(response); assert.equal(await old, undefined);
    e.fire('disk'); const cancellation = token(), canceled = e.request(main, cancellation); await tick(); cancellation.cancel();
    assert.equal(await canceled, undefined); assert.equal(cancellation.listeners.size, 0);
    const retry = e.request(main); await tick(); e.fire('disk'); e.jobs[2].resolve(response); await tick();
    assert.equal(e.jobs.length, 4); e.jobs[3].resolve(response); assert.ok(await retry);
  } finally { e.close(); }
});

test('parameter hints require trust, local files and their independent enabled setting', async () => {
  const e = editor({ trusted: false }), main = e.add('main.prose');
  try {
    assert.equal(await e.request(main), undefined); assert.equal(e.jobs.length, 0);
    e.vscode.workspace.isTrusted = true; e.setEnabled(false);
    assert.equal(await e.request(main), undefined); assert.equal(e.jobs.length, 0);
    e.setEnabled(true); main.uri.scheme = 'untitled';
    assert.equal(await e.request(main), undefined); assert.equal(e.jobs.length, 0);
    main.uri.scheme = 'file'; main.text = '';
    assert.equal(await e.request(main), undefined); assert.equal(e.jobs.length, 0);
  } finally { e.close(); }
});

test('setup problems stay in Output and a setting change suppresses pending hints', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const pending = e.request(main); await tick(); e.jobs[0].resolve({ exitCode: 2, diagnostics: [{ message: 'Install TypeScript' }] });
    assert.equal(await pending, undefined); assert.match(e.logs.join('\n'), /Install TypeScript/);
    e.fire('disk'); const next = e.request(main); await tick(); e.setEnabled(false); e.jobs[1].resolve(response);
    assert.equal(await next, undefined);
  } finally { e.close(); }
});
