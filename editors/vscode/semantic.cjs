const { dirname, resolve } = require('node:path');
const { findConfig, startCheck } = require('./checking.cjs');
const tokenTypes = ['proseFunction', 'proseParameter', 'proseVariable', 'proseBinding', 'proseProperty', 'proseIterator', 'proseBuiltin'];
const canonical = file => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
const relevant = document => document.uri.scheme === 'file' && !document.isClosed && /\.(?:prose|[cm]?[jt]sx?|json)$/i.test(document.uri.fsPath);

function createSemanticHighlighting(vscode, { runCheck = startCheck } = {}) {
  const { workspace } = vscode, states = new Map();
  const changed = new vscode.EventEmitter(), output = vscode.window.createOutputChannel('Prose Highlighting');
  const legend = new vscode.SemanticTokensLegend(tokenTypes, []);
  let disposed = false;
  const empty = () => new vscode.SemanticTokensBuilder(legend).build();
  const enabled = document => workspace.isTrusted && relevant(document) && document.languageId === 'prose' &&
    workspace.getConfiguration('prose', document.uri).get('semanticHighlighting.enabled', true) &&
    workspace.getConfiguration('editor', { uri: document.uri, languageId: 'prose' }).get('semanticHighlighting.enabled', 'configuredByTheme') !== false;
  function invalidate() {
    for (const state of states.values()) state.job?.cancel(); states.clear();
    if (!disposed) changed.fire();
  }
  function snapshot(document) {
    const documents = workspace.textDocuments.filter(relevant);
    if (!documents.some(other => canonical(other.uri.fsPath) === canonical(document.uri.fsPath))) documents.push(document);
    return { documents, stamp: JSON.stringify(documents.map(other => [canonical(other.uri.fsPath), other.version]).sort(([a],[b]) => a.localeCompare(b))) };
  }
  async function provideDocumentSemanticTokens(document, cancellation, retry = true) {
    if (disposed || cancellation.isCancellationRequested) return;
    if (!enabled(document)) return empty();
    const version = document.version, { documents, stamp } = snapshot(document), key = canonical(document.uri.fsPath);
    let state = states.get(key);
    if (state && state.stamp !== stamp) { state.job?.cancel(); states.delete(key); state = undefined; }
    if (!state) {
      const project = findConfig(document.uri.fsPath), folder = workspace.getWorkspaceFolder(document.uri)?.uri;
      const cwd = project ? dirname(project) : folder?.scheme === 'file' ? folder.fsPath : dirname(document.uri.fsPath);
      state = { stamp }; states.set(key, state);
      try {
        state.job = runCheck({ cwd, project, targets: [document.uri.fsPath], semanticTargets: [document.uri.fsPath],
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
      if (disposed || document.version !== version || cancellation.isCancellationRequested) return;
      if (!enabled(document)) return empty();
      if (states.get(key) !== state || snapshot(document).stamp !== stamp) return retry ? provideDocumentSemanticTokens(document, cancellation, false) : empty();
      if (result.exitCode === 2) { for (const diagnostic of result.diagnostics ?? []) output.appendLine(diagnostic.message); return empty(); }
      const builder = new vscode.SemanticTokensBuilder(legend);
      for (const token of result.semanticTokens?.find(record => canonical(record.file) === key)?.tokens ?? []) {
        const type = tokenTypes.indexOf(token.type);
        if (type >= 0) builder.push(token.line-1, token.column-1, token.length, type, 0);
      }
      return builder.build();
    } finally { subscription?.dispose(); }
  }
  const subscriptions = [changed, output,
    vscode.languages.registerDocumentSemanticTokensProvider({ language: 'prose', scheme: 'file' }, { provideDocumentSemanticTokens, onDidChangeSemanticTokens: changed.event }, legend),
    workspace.onDidChangeTextDocument(({ document, contentChanges }) => { if (relevant(document) && contentChanges.length) invalidate(); }),
    workspace.onDidOpenTextDocument(document => { if (relevant(document)) invalidate(); }),
    workspace.onDidCloseTextDocument(invalidate), workspace.onDidSaveTextDocument(document => { if (relevant(document)) invalidate(); }),
    workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('prose.semanticHighlighting') || event.affectsConfiguration('editor.semanticHighlighting')) invalidate(); }),
    workspace.onDidChangeWorkspaceFolders(invalidate), workspace.onDidGrantWorkspaceTrust(invalidate),
    workspace.onDidDeleteFiles(invalidate), workspace.onDidRenameFiles(invalidate)
  ];
  const watcher = workspace.createFileSystemWatcher('**/*.{prose,ts,tsx,mts,cts,js,jsx,mjs,cjs,json}');
  subscriptions.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
  return { dispose() { if (disposed) return; disposed = true; invalidate(); for (const subscription of subscriptions) subscription.dispose(); } };
}
module.exports = { createSemanticHighlighting, tokenTypes };
