const { dirname, resolve } = require('node:path');
const { readFileSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { findConfig, startCheck } = require('./checking.cjs');
const canonical = file => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
const relevant = document => document.uri.scheme === 'file' && !document.isClosed && /\.(?:prose|[cm]?[jt]sx?|json)$/i.test(document.uri.fsPath);

function snapshotMatches(snapshot, documents) {
  if (!snapshot) return true;
  const buffers = new Map(documents.filter(relevant).map(document => [canonical(document.uri.fsPath), document]));
  try {
    return snapshot.directories.every(item => statSync(item.file).mtimeMs === item.mtimeMs) && snapshot.files.every(item => {
      const document = buffers.get(canonical(item.file));
      const source = document && !item.file.endsWith('.json') ? document.getText() : readFileSync(item.file, 'utf8');
      return createHash('sha256').update(source).digest('hex') === item.hash;
    });
  } catch { return false; }
}

function createRefactoring(vscode, { runCheck = startCheck, checkSnapshot = snapshotMatches } = {}) {
  const { workspace } = vscode, states = new Map(), output = vscode.window.createOutputChannel('Prose Refactoring');
  let disposed = false;
  const enabled = (document, feature) => workspace.isTrusted && relevant(document) && document.languageId === 'prose' &&
    workspace.getConfiguration('prose', document.uri).get(`${feature}.enabled`, true);
  function invalidate() { for (const state of states.values()) state.job?.cancel(); states.clear(); }
  // A create can deliver several disk events. Let an in-flight project snapshot
  // finish, then validate its contents; canceling on each event can starve it.
  function diskChanged() { for (const state of states.values()) state.diskChanged = true; }
  function snapshot(document) {
    const documents = workspace.textDocuments.filter(relevant);
    if (!documents.some(other => canonical(other.uri.fsPath) === canonical(document.uri.fsPath))) documents.push(document);
    return { documents, stamp: JSON.stringify(documents.map(other => [canonical(other.uri.fsPath), other.version]).sort(([a], [b]) => a.localeCompare(b))) };
  }
  async function query(document, position, cancellation, feature, options = {}, retry = true) {
    if (disposed || cancellation.isCancellationRequested || !enabled(document, feature)) return;
    const version = document.version, text = document.getText().split(/\r?\n/)[position.line] ?? '';
    if (!/[A-Za-z_0-9]/.test(text[position.character] ?? '') && !/[A-Za-z_0-9]/.test(text[position.character - 1] ?? '')) return;
    const { documents, stamp } = snapshot(document), key = canonical(document.uri.fsPath);
    const request = JSON.stringify([stamp, position.line, position.character, options]);
    let state = states.get(key);
    if (state && (state.request !== request || state.diskChanged && !state.job)) { state.job?.cancel(); states.delete(key); state = undefined; }
    if (!state) {
      const project = findConfig(document.uri.fsPath), folder = workspace.getWorkspaceFolder(document.uri)?.uri;
      const cwd = project ? dirname(project) : folder?.scheme === 'file' ? folder.fsPath : dirname(document.uri.fsPath);
      state = { request }; states.set(key, state);
      try {
        state.job = runCheck({ cwd, project, refactor: { file: document.uri.fsPath, line: position.line + 1, column: position.character + 1, ...options },
          overlays: documents.map(other => [other.uri.fsPath, other.getText()]) });
        state.promise = state.job.promise.catch(error => {
          if (!disposed && states.get(key) === state) output.appendLine(error.stack ?? error.message);
          return {};
        }).finally(() => { state.job = undefined; });
      } catch (error) { output.appendLine(error.message); state.promise = Promise.resolve({}); }
    }
    let subscription;
    try {
      const canceled = new Promise(resolve => { subscription = cancellation.onCancellationRequested(() => resolve({})); });
      const result = await Promise.race([state.promise, canceled]);
      if (disposed || document.version !== version || cancellation.isCancellationRequested || !enabled(document, feature)) return;
      if (states.get(key) !== state || snapshot(document).stamp !== stamp || state.diskChanged && !result.projectSnapshot) return retry ? query(document, position, cancellation, feature, options, false) : undefined;
      if (!checkSnapshot(result.projectSnapshot, workspace.textDocuments)) {
        invalidate();
        return retry ? query(document, position, cancellation, feature, options, false) : undefined;
      }
      state.diskChanged = false;
      if (result.exitCode === 2) { for (const diagnostic of result.diagnostics ?? []) output.appendLine(diagnostic.message); return; }
      return result;
    } finally { subscription?.dispose(); }
  }
  const range = item => new vscode.Range(item.line - 1, item.column - 1, item.line - 1, item.endColumn - 1);
  async function provideReferences(document, position, context, cancellation) {
    const result = await query(document, position, cancellation, 'references', { includeDeclaration: context.includeDeclaration });
    return result?.references?.map(item => new vscode.Location(vscode.Uri.file(item.file), range(item)));
  }
  async function prepareRename(document, position, cancellation) {
    const result = await query(document, position, cancellation, 'rename');
    if (!result) return;
    if (result.renameError) throw new Error(result.renameError);
    return result.rename && { range: range(result.rename), placeholder: result.rename.placeholder };
  }
  async function provideRenameEdits(document, position, newName, cancellation) {
    const result = await query(document, position, cancellation, 'rename', { newName });
    if (!result) return;
    if (result.renameError) throw new Error(result.renameError);
    if (!result.edits) return;
    const edit = new vscode.WorkspaceEdit();
    for (const item of result.edits) edit.replace(vscode.Uri.file(item.file), range(item), item.newText);
    return edit;
  }
  const subscriptions = [output,
    vscode.languages.registerReferenceProvider({ language: 'prose', scheme: 'file' }, { provideReferences }),
    vscode.languages.registerRenameProvider({ language: 'prose', scheme: 'file' }, { prepareRename, provideRenameEdits }),
    workspace.onDidChangeTextDocument(({ document, contentChanges }) => { if (relevant(document) && contentChanges.length) invalidate(); }),
    workspace.onDidOpenTextDocument(document => { if (relevant(document)) invalidate(); }),
    workspace.onDidCloseTextDocument(invalidate), workspace.onDidSaveTextDocument(document => { if (relevant(document)) invalidate(); }),
    workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('prose.references') || event.affectsConfiguration('prose.rename')) invalidate(); }),
    workspace.onDidChangeWorkspaceFolders(invalidate), workspace.onDidGrantWorkspaceTrust(invalidate),
    workspace.onDidDeleteFiles(invalidate), workspace.onDidRenameFiles(invalidate)
  ];
  const watcher = workspace.createFileSystemWatcher('**/*.{prose,ts,tsx,mts,cts,js,jsx,mjs,cjs,json}');
  subscriptions.push(watcher, watcher.onDidChange(diskChanged), watcher.onDidCreate(diskChanged), watcher.onDidDelete(diskChanged));
  return { dispose() { if (disposed) return; disposed = true; invalidate(); for (const subscription of subscriptions) subscription.dispose(); } };
}
module.exports = { createRefactoring, snapshotMatches };
