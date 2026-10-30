import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const { createRefactoring, snapshotMatches } = createRequire(import.meta.url)('../editors/vscode/refactoring.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function token() {
  const listeners = new Set();
  return { isCancellationRequested: false, listeners, onCancellationRequested(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; }, cancel() { this.isCancellationRequested = true; listeners.forEach(callback => callback()); } };
}
function editor({ trusted = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prose refactoring provider ')), documents = [], jobs = [], logs = [], events = {};
  let references, rename, disposed = 0;
  const settings = { references: true, rename: true };
  const listen = name => callback => { (events[name] ??= new Set()).add(callback); return { dispose: () => events[name].delete(callback) }; };
  const output = { appendLine: text => logs.push(text), dispose() {} };
  const watcher = { onDidChange: listen('disk'), onDidCreate: listen('created'), onDidDelete: listen('deleted'), dispose() {} };
  const vscode = {
    Range: class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } },
    Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
    WorkspaceEdit: class { edits = []; replace(uri, range, newText) { this.edits.push({ uri, range, newText }); } },
    Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) }, window: { createOutputChannel: () => output },
    languages: {
      registerReferenceProvider(selector, value) { assert.deepEqual(selector, { language: 'prose', scheme: 'file' }); references = value; return { dispose() { disposed++; } }; },
      registerRenameProvider(selector, value) { assert.deepEqual(selector, { language: 'prose', scheme: 'file' }); rename = value; return { dispose() { disposed++; } }; }
    },
    workspace: { isTrusted: trusted, textDocuments: documents,
      getConfiguration: () => ({ get: (key, fallback) => settings[key.split('.')[0]] ?? fallback }),
      getWorkspaceFolder: () => ({ uri: { scheme: 'file', fsPath: root } }), createFileSystemWatcher: () => watcher,
      onDidChangeTextDocument: listen('change'), onDidOpenTextDocument: listen('open'), onDidCloseTextDocument: listen('close'), onDidSaveTextDocument: listen('save'),
      onDidChangeConfiguration: listen('settings'), onDidChangeWorkspaceFolders: listen('folders'), onDidGrantWorkspaceTrust: listen('trust'), onDidDeleteFiles: listen('delete'), onDidRenameFiles: listen('rename') }
  };
  const runCheck = options => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); const job = { options, promise, resolve, reject, canceled: 0, cancel() { this.canceled++; } }; jobs.push(job); return job; };
  const service = createRefactoring(vscode, { runCheck });
  const add = (name, text = 'count is 1', extra = {}) => { const file = join(root, name); writeFileSync(file, text); const document = { uri: { scheme: 'file', fsPath: file }, languageId: name.endsWith('.prose') ? 'prose' : 'typescript', version: 1, isClosed: false, text, getText() { return this.text; }, ...extra }; documents.push(document); return document; };
  const position = { line: 0, character: 2 };
  const fire = (name, value) => { for (const callback of events[name] ?? []) callback(value); };
  return { vscode, jobs, logs, fire, add,
    references: (document, cancellation = token(), includeDeclaration = true) => references.provideReferences(document, position, { includeDeclaration }, cancellation),
    prepare: (document, cancellation = token()) => rename.prepareRename(document, position, cancellation),
    rename: (document, newName, cancellation = token()) => rename.provideRenameEdits(document, position, newName, cancellation),
    setEnabled(feature, value) { settings[feature] = value; fire('settings', { affectsConfiguration: key => key === 'prose.' + feature }); },
    close() { service.dispose(); assert.equal(disposed, 2); rmSync(root, { recursive: true, force: true }); } };
}
const response = file => ({ exitCode: 0, diagnostics: [], references: [{ file, line: 1, column: 1, endColumn: 6 }], rename: { line: 1, column: 1, endColumn: 6, placeholder: 'count' } });

test('references use current buffers, respect declaration choice and cache an identical request', async () => {
  const e = editor(), main = e.add('main.prose'), dependency = e.add('types.ts', 'export const changed = 1;');
  try {
    const pending = e.references(main, token(), false); assert.equal(e.jobs.length, 1);
    assert.equal(e.jobs[0].options.refactor.includeDeclaration, false);
    assert.deepEqual(e.jobs[0].options.overlays, [[main.uri.fsPath, main.text], [dependency.uri.fsPath, dependency.text]]);
    e.jobs[0].resolve(response(main.uri.fsPath));
    const locations = await pending;
    assert.equal(locations[0].uri.fsPath, main.uri.fsPath);
    assert.deepEqual(locations[0].range.start, { line: 0, character: 0 });
    assert.ok(await e.references(main, token(), false)); assert.equal(e.jobs.length, 1);
  } finally { e.close(); }
});

test('rename prepares a range, validates the requested name and returns edits without applying them', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const pending = e.prepare(main); e.jobs[0].resolve(response(main.uri.fsPath));
    assert.equal((await pending).placeholder, 'count');
    const renamed = e.rename(main, 'total'); assert.equal(e.jobs[1].options.refactor.newName, 'total');
    e.jobs[1].resolve({ ...response(main.uri.fsPath), edits: [{ file: main.uri.fsPath, line: 1, column: 1, endColumn: 6, newText: 'total' }] });
    const edit = await renamed; assert.equal(edit.edits[0].newText, 'total'); assert.equal(main.text, 'count is 1');
    const conflict = e.rename(main, 'other'); e.jobs[2].resolve({ renameError: 'That name would capture another binding.' });
    await assert.rejects(conflict, /capture/);
    e.fire('disk'); const unsupported = e.prepare(main); e.jobs[3].resolve({ renameError: 'Exported bindings are not supported yet.' });
    await assert.rejects(unsupported, /Exported/);
  } finally { e.close(); }
});

test('edits and dependency changes cancel old requests and never return stale workspace edits', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const old = e.rename(main, 'total'); main.version++; e.fire('change', { document: main, contentChanges: [{ text: '1' }] });
    assert.equal(e.jobs[0].canceled, 1); e.jobs[0].resolve({ ...response(main.uri.fsPath), edits: [] }); assert.equal(await old, undefined);
    const cancellation = token(), canceled = e.references(main, cancellation); cancellation.cancel(); assert.equal(await canceled, undefined); assert.equal(cancellation.listeners.size, 0);
    const retry = e.references(main); e.fire('disk'); e.jobs[1].resolve(response(main.uri.fsPath)); await tick();
    assert.equal(e.jobs.length, 3); e.jobs[2].resolve(response(main.uri.fsPath)); assert.ok(await retry);
  } finally { e.close(); }
});

test('trust, local-file rules and independent settings gate refactoring; setup errors stay in Output', async () => {
  const e = editor({ trusted: false }), main = e.add('main.prose');
  try {
    assert.equal(await e.prepare(main), undefined); assert.equal(e.jobs.length, 0);
    e.vscode.workspace.isTrusted = true; e.setEnabled('rename', false);
    assert.equal(await e.rename(main, 'total'), undefined); assert.equal(e.jobs.length, 0);
    const refs = e.references(main); e.jobs[0].resolve(response(main.uri.fsPath)); assert.ok(await refs);
    e.setEnabled('references', false); assert.equal(await e.references(main), undefined);
    e.setEnabled('rename', true); main.uri.scheme = 'untitled'; assert.equal(await e.prepare(main), undefined);
    main.uri.scheme = 'file'; const setup = e.prepare(main); e.jobs[1].resolve({ exitCode: 2, diagnostics: [{ message: 'Install TypeScript' }] });
    assert.equal(await setup, undefined); assert.match(e.logs.join('\n'), /Install TypeScript/);
  } finally { e.close(); }
});

test('changed closed-file content retries before returning multi-file workspace edits', async () => {
  const e = editor(), main = e.add('main.prose'), closed = e.add('closed.prose', 'print count', { isClosed: true });
  const hash = text => createHash('sha256').update(text).digest('hex');
  const result = text => ({ ...response(main.uri.fsPath), projectSnapshot: { directories: [], files: [{ file: closed.uri.fsPath, hash: hash(text) }] },
    edits: [main, closed].map(document => ({ file: document.uri.fsPath, line: 1, column: 1, endColumn: 6, newText: 'total' })) });
  try {
    const pending = e.rename(main, 'total');
    writeFileSync(closed.uri.fsPath, 'print count + 1'); e.jobs[0].resolve(result('print count')); await tick();
    assert.equal(e.jobs.length, 2);
    e.jobs[1].resolve(result('print count + 1'));
    const edit = await pending; assert.equal(edit.edits.length, 2);
    assert.equal(edit.edits[1].uri.fsPath, closed.uri.fsPath);
  } finally { e.close(); }
});

test('project snapshots use dirty buffers and detect changed directory inventories', () => {
  const e = editor(), main = e.add('main.prose', 'count is 1');
  const hash = text => createHash('sha256').update(text).digest('hex');
  try {
    main.text = 'count is 2';
    const root = dirname(main.uri.fsPath), snapshot = { files: [{ file: main.uri.fsPath, hash: hash(main.text) }], directories: [{ file: root, mtimeMs: statSync(root).mtimeMs }] };
    assert.equal(snapshotMatches(snapshot, [main]), true);
    assert.equal(snapshotMatches(snapshot, []), false);
    utimesSync(root, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    assert.equal(snapshotMatches(snapshot, [main]), false);
  } finally { e.close(); }
});

test('bursts of disk events do not cancel a project result whose snapshot is still current', async () => {
  const e = editor(), main = e.add('main.prose');
  try {
    const pending = e.rename(main, 'total');
    e.fire('created'); e.fire('disk'); e.fire('disk');
    assert.equal(e.jobs[0].canceled, 0);
    e.jobs[0].resolve({ ...response(main.uri.fsPath), projectSnapshot: { files: [], directories: [] }, edits: [] });
    assert.ok(await pending); assert.equal(e.jobs.length, 1);
  } finally { e.close(); }
});
