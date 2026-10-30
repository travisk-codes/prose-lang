import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createSemanticHighlighting, tokenTypes } = createRequire(import.meta.url)('../editors/vscode/semantic.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function token() {
  const listeners = new Set();
  return { isCancellationRequested: false, listeners, onCancellationRequested(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; }, cancel() { this.isCancellationRequested = true; listeners.forEach(callback => callback()); } };
}
function editor({ trusted = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prose semantic provider ')), documents = [], jobs = [], logs = [], events = {};
  let provider, registrationDisposed = false, enabled = true, coreEnabled = 'configuredByTheme', refreshes = 0;
  const listen = name => callback => { (events[name] ??= new Set()).add(callback); return { dispose: () => events[name].delete(callback) }; };
  const watcher = { onDidChange: listen('disk'), onDidCreate: listen('created'), onDidDelete: listen('deleted'), dispose() {} };
  const vscode = {
    EventEmitter: class { constructor() { this.listeners = new Set(); this.event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; }; } fire() { this.listeners.forEach(callback => callback()); } dispose() { this.listeners.clear(); } },
    SemanticTokensLegend: class { constructor(tokenTypes, tokenModifiers) { Object.assign(this, { tokenTypes, tokenModifiers }); } },
    SemanticTokensBuilder: class { entries = []; push(...entry) { this.entries.push(entry); } build() { return { entries: this.entries }; } },
    window: { createOutputChannel: () => ({ appendLine: text => logs.push(text), dispose() {} }) },
    languages: { registerDocumentSemanticTokensProvider(selector, value, legend) {
      assert.deepEqual(selector, { language: 'prose', scheme: 'file' }); assert.deepEqual(legend.tokenTypes, tokenTypes); assert.deepEqual(legend.tokenModifiers, []);
      provider = value; const sub = value.onDidChangeSemanticTokens(() => refreshes++);
      return { dispose() { registrationDisposed = true; sub.dispose(); } };
    } },
    workspace: { isTrusted: trusted, textDocuments: documents,
      getConfiguration: section => ({ get: (key, fallback) => key === 'semanticHighlighting.enabled' ? section === 'prose' ? enabled : coreEnabled : fallback }),
      getWorkspaceFolder: () => ({ uri: { scheme: 'file', fsPath: root } }), createFileSystemWatcher: () => watcher,
      onDidChangeTextDocument: listen('change'), onDidOpenTextDocument: listen('open'), onDidCloseTextDocument: listen('close'), onDidSaveTextDocument: listen('save'),
      onDidChangeConfiguration: listen('settings'), onDidChangeWorkspaceFolders: listen('folders'), onDidGrantWorkspaceTrust: listen('trust'), onDidDeleteFiles: listen('delete'), onDidRenameFiles: listen('rename') }
  };
  const runCheck = options => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); const job = { options, promise, resolve, reject, canceled: 0, cancel() { this.canceled++; } }; jobs.push(job); return job; };
  const service = createSemanticHighlighting(vscode, { runCheck });
  const add = (name, text = 'action is function takes value return value', extra = {}) => { const file = join(root, name); writeFileSync(file, text); const document = { uri: { scheme: 'file', fsPath: file }, languageId: name.endsWith('.prose') ? 'prose' : 'typescript', version: 1, isClosed: false, text, getText() { return this.text; }, ...extra }; documents.push(document); return document; };
  const fire = (name, value) => { for (const callback of events[name] ?? []) callback(value); };
  return { vscode, jobs, logs, fire, add, get refreshes() { return refreshes; }, request: (document, cancellation = token()) => provider.provideDocumentSemanticTokens(document, cancellation),
    setEnabled(value, core = coreEnabled) { enabled = value; coreEnabled = core; fire('settings', { affectsConfiguration: key => key === 'prose.semanticHighlighting' || key === 'editor.semanticHighlighting' }); },
    close() { service.dispose(); assert.ok(registrationDisposed); rmSync(root, { recursive: true, force: true }); } };
}
const response = file => ({ exitCode: 0, diagnostics: [], semanticTokens: [{ file, tokens: [{ line: 1, column: 1, length: 6, type: 'proseFunction' }] }] });

test('semantic provider encodes current-buffer tokens and caches an unchanged snapshot', async () => {
  const e = editor(), main = e.add('main.prose'), types = e.add('types.ts', 'export const count = 1;');
  try {
    const pending = e.request(main); assert.equal(e.jobs.length, 1);
    assert.deepEqual(e.jobs[0].options.semanticTargets, [main.uri.fsPath]);
    assert.deepEqual(e.jobs[0].options.overlays, [[main.uri.fsPath, main.text], [types.uri.fsPath, types.text]]);
    e.jobs[0].resolve(response(main.uri.fsPath)); const result = await pending;
    assert.deepEqual(result.entries, [[0,0,6,tokenTypes.indexOf('proseFunction'),0]]);
    assert.ok(await e.request(main)); assert.equal(e.jobs.length, 1);
  } finally { e.close(); }
});

test('edits, cancellation and dependency notifications invalidate stale semantic results', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const old = e.request(main); main.version++; e.fire('change', { document: main, contentChanges: [{ text: 'x' }] });
    assert.equal(e.jobs[0].canceled, 1); assert.ok(e.refreshes > 0);
    e.jobs[0].resolve(response(main.uri.fsPath)); assert.equal(await old, undefined);
    const cancellation = token(), canceled = e.request(main, cancellation); cancellation.cancel(); assert.equal(await canceled, undefined); assert.equal(cancellation.listeners.size, 0);
    const retry = e.request(main); e.fire('disk'); e.jobs[1].resolve(response(main.uri.fsPath)); await tick();
    assert.equal(e.jobs.length, 3); e.jobs[2].resolve(response(main.uri.fsPath)); assert.ok(await retry);
  } finally { e.close(); }
});

test('trust, local files and both highlighting settings return empty tokens when disabled', async () => {
  const e = editor({ trusted: false }), main = e.add('main.prose');
  try {
    assert.deepEqual((await e.request(main)).entries, []); assert.equal(e.jobs.length, 0);
    e.vscode.workspace.isTrusted = true; e.setEnabled(false);
    assert.deepEqual((await e.request(main)).entries, []); assert.equal(e.jobs.length, 0);
    e.setEnabled(true, false); assert.deepEqual((await e.request(main)).entries, []); assert.equal(e.jobs.length, 0);
    e.setEnabled(true, true); main.uri.scheme = 'untitled'; assert.deepEqual((await e.request(main)).entries, []);
    main.uri.scheme = 'file'; const pending = e.request(main); e.setEnabled(false); e.jobs[0].resolve(response(main.uri.fsPath));
    assert.deepEqual((await pending).entries, []);
  } finally { e.close(); }
});

test('syntax and setup failures clear semantic colors and setup details stay in Output', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const invalid = e.request(main); e.jobs[0].resolve({ exitCode: 1, semanticTokens: [] }); assert.deepEqual((await invalid).entries, []);
    e.fire('disk'); const setup = e.request(main); e.jobs[1].resolve({ exitCode: 2, diagnostics: [{ message: 'Install TypeScript' }] });
    assert.deepEqual((await setup).entries, []); assert.match(e.logs.join('\n'), /Install TypeScript/);
  } finally { e.close(); }
});

test('semantic scope fallbacks reuse the Prose palette without direct color overrides', () => {
  const manifest = JSON.parse(readFileSync(new URL('../editors/vscode/package.json', import.meta.url),'utf8'));
  assert.deepEqual(manifest.contributes.semanticTokenTypes.map(item=>item.id), tokenTypes);
  assert.ok(manifest.contributes.semanticTokenTypes.every(item => !item.superType));
  const scopes = manifest.contributes.semanticTokenScopes.find(item=>item.language==='prose').scopes;
  const rules = manifest.contributes.configurationDefaults['editor.tokenColorCustomizations'].textMateRules;
  const colors = { proseFunction:'#F5E07B', proseParameter:'#B7E16E', proseVariable:'#C5D9F5', proseBinding:'#85B7F4', proseProperty:'#64D6C7', proseIterator:'#B7E16E', proseBuiltin:'#66D6E9' };
  for (const type of tokenTypes) {
    const rule = rules.find(rule=>rule.scope.includes(scopes[type][0])); assert.ok(rule, type); assert.equal(rule.settings.foreground,colors[type]);
  }
  assert.equal(manifest.contributes.configurationDefaults['editor.semanticTokenColorCustomizations'],undefined);
  assert.equal(manifest.contributes.configuration.properties['prose.semanticHighlighting.enabled'].default,true);
});
