const { dirname, resolve } = require("node:path");
const { findConfig, startCheck } = require("./checking.cjs");

const canonical = file => process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
const relevant = document => document.uri.scheme === "file" && !document.isClosed && /\.(?:prose|[cm]?[jt]sx?|json)$/i.test(document.uri.fsPath);

function createSignatureHelp(vscode, { runCheck = startCheck, loadContext = () => import("./dist/formatter/signature-help.js") } = {}) {
  const { workspace } = vscode, states = new Map();
  const output = vscode.window.createOutputChannel("Prose Parameters");
  let disposed = false, contextModule;
  const enabled = document => workspace.isTrusted && relevant(document) && document.languageId === "prose" &&
    workspace.getConfiguration("prose", document.uri).get("signatureHelp.enabled", true);
  function invalidate() {
    for (const state of states.values()) state.job?.cancel();
    states.clear();
  }
  function snapshot(document) {
    const documents = workspace.textDocuments.filter(relevant);
    if (!documents.some(other => canonical(other.uri.fsPath) === canonical(document.uri.fsPath))) documents.push(document);
    return { documents, stamp: JSON.stringify(documents.map(other => [canonical(other.uri.fsPath), other.version]).sort(([a], [b]) => a.localeCompare(b))) };
  }
  const markdown = text => {
    if (!text) return undefined;
    const value = new vscode.MarkdownString(); value.isTrusted = false; value.supportHtml = false; value.appendText(text);
    return value;
  };
  async function query(document, position, cancellation, retry = true) {
    if (disposed || cancellation.isCancellationRequested || !enabled(document)) return;
    const version = document.version;
    let signatureContexts;
    try { ({ signatureContexts } = await (contextModule ??= loadContext())); }
    catch (error) { contextModule = undefined; if (!disposed) output.appendLine(error.message); return; }
    if (disposed || document.version !== version || cancellation.isCancellationRequested || !enabled(document)) return;
    if (!signatureContexts(document.getText(), position.line + 1, position.character + 1).length) return;
    const { documents, stamp } = snapshot(document), key = canonical(document.uri.fsPath);
    const request = JSON.stringify([stamp, position.line, position.character]);
    let state = states.get(key);
    if (state && state.request !== request) { state.job?.cancel(); states.delete(key); state = undefined; }
    if (!state) {
      const project = findConfig(document.uri.fsPath), folder = workspace.getWorkspaceFolder(document.uri)?.uri;
      const cwd = project ? dirname(project) : folder?.scheme === "file" ? folder.fsPath : dirname(document.uri.fsPath);
      state = { request }; states.set(key, state);
      try {
        state.job = runCheck({ cwd, project, signature: { file: document.uri.fsPath, line: position.line + 1, column: position.character + 1 },
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
      if (disposed || document.version !== version || cancellation.isCancellationRequested || !enabled(document)) return;
      if (states.get(key) !== state || snapshot(document).stamp !== stamp) return retry ? query(document, position, cancellation, false) : undefined;
      if (result.exitCode === 2) { for (const diagnostic of result.diagnostics ?? []) output.appendLine(diagnostic.message); return; }
      if (!result.signatureHelp) return;
      const help = new vscode.SignatureHelp();
      help.activeSignature = result.signatureHelp.activeSignature;
      help.activeParameter = result.signatureHelp.activeParameter;
      help.signatures = result.signatureHelp.signatures.map(item => {
        const signature = new vscode.SignatureInformation(item.label, markdown(item.documentation));
        signature.parameters = item.parameters.map(parameter => new vscode.ParameterInformation(parameter.label, markdown(parameter.documentation)));
        signature.activeParameter = item.activeParameter;
        return signature;
      });
      return help;
    } finally { subscription?.dispose(); }
  }
  const subscriptions = [output,
    vscode.languages.registerSignatureHelpProvider({ language: "prose", scheme: "file" }, { provideSignatureHelp: (document, position, cancellation) => query(document, position, cancellation) },
      { triggerCharacters: [" ", ",", "("], retriggerCharacters: [",", ")"] }),
    workspace.onDidChangeTextDocument(({ document, contentChanges }) => { if (relevant(document) && contentChanges.length) invalidate(); }),
    workspace.onDidOpenTextDocument(document => { if (relevant(document)) invalidate(); }),
    workspace.onDidCloseTextDocument(invalidate), workspace.onDidSaveTextDocument(document => { if (relevant(document)) invalidate(); }),
    workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("prose.signatureHelp")) invalidate(); }),
    workspace.onDidChangeWorkspaceFolders(invalidate), workspace.onDidGrantWorkspaceTrust(invalidate),
    workspace.onDidDeleteFiles(invalidate), workspace.onDidRenameFiles(invalidate)
  ];
  const watcher = workspace.createFileSystemWatcher("**/*.{prose,ts,tsx,mts,cts,js,jsx,mjs,cjs,json}");
  subscriptions.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
  return { dispose() { if (disposed) return; disposed = true; invalidate(); for (const subscription of subscriptions) subscription.dispose(); } };
}

module.exports = { createSignatureHelp };
