const { dirname, resolve } = require("node:path");
const { findConfig, startCheck } = require("./checking.cjs");

const canonical = file => process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
const relevant = document => document.uri.scheme === "file" && !document.isClosed && /\.(?:prose|[cm]?[jt]sx?|json)$/i.test(document.uri.fsPath);
const prose = document => relevant(document) && document.languageId === "prose" && document.uri.fsPath.endsWith(".prose");

// Hover and definition requests share one project snapshot off the extension
// host. Edits invalidate the source ranges, types, and pending workers together.
function createLanguageFeatures(vscode, { runCheck = startCheck } = {}) {
  const { workspace } = vscode;
  const states = new Map();
  const output = vscode.window.createOutputChannel("Prose Language");
  let disposed = false;
  const enabled = (document, feature) => workspace.isTrusted && prose(document) &&
    workspace.getConfiguration("prose", document.uri).get(`${feature}.enabled`, true);
  function invalidate() {
    for (const state of states.values()) state.job?.cancel();
    states.clear();
  }
  function group(document) {
    const project = findConfig(document.uri.fsPath);
    const folder = workspace.getWorkspaceFolder(document.uri)?.uri;
    const cwd = project ? dirname(project) : folder?.scheme === "file" ? folder.fsPath : dirname(document.uri.fsPath);
    return { key: canonical(project ?? cwd), cwd, project };
  }
  function snapshot(document) {
    const documents = workspace.textDocuments.filter(relevant);
    if (!documents.some(other => canonical(other.uri.fsPath) === canonical(document.uri.fsPath))) documents.push(document);
    const stamp = JSON.stringify(documents.map(other => [canonical(other.uri.fsPath), other.version]).sort(([a], [b]) => a.localeCompare(b)));
    return { documents, stamp };
  }
  async function query(document, position, cancellation, feature, retry = true) {
    if (disposed || cancellation.isCancellationRequested || !enabled(document, feature)) return;
    const line = document.getText().split(/\r?\n/)[position.line] ?? "";
    // String-key and numeric-position hints also cover quotes and Unicode.
    if (!(feature === "hover" ? /\S/u : /[A-Za-z_0-9]/).test(line[position.character] ?? "")) return;
    const version = document.version;
    const { key, cwd, project } = group(document);
    const { documents, stamp } = snapshot(document);
    let state = states.get(key);
    if (state && state.stamp !== stamp) {
      state.job?.cancel();
      states.delete(key);
      state = undefined;
    }
    if (!state) {
      const targets = documents.filter(other => prose(other) && group(other).key === key).map(other => other.uri.fsPath);
      if (!targets.includes(document.uri.fsPath)) targets.push(document.uri.fsPath);
      const wanted = feature => targets.filter(file => workspace.getConfiguration("prose", vscode.Uri.file(file)).get(`${feature}.enabled`, true));
      const overlays = documents.map(other => [other.uri.fsPath, other.getText()]);
      state = { stamp };
      states.set(key, state);
      try {
        state.job = runCheck({ cwd, project, targets, hoverTargets: wanted("hover"), definitionTargets: wanted("definition"), overlays });
        state.promise = state.job.promise.then(result => {
          if (!disposed && states.get(key) === state && result.exitCode === 2) for (const item of result.diagnostics) output.appendLine(item.message);
          return result;
        }).catch(error => {
          if (!disposed && states.get(key) === state) output.appendLine(error.stack ?? error.message);
          return {};
        }).finally(() => { state.job = undefined; });
      } catch (error) {
        output.appendLine(error.message);
        state.promise = Promise.resolve({});
      }
    }
    let subscription;
    try {
      const canceled = new Promise(resolve => { subscription = cancellation.onCancellationRequested(() => resolve({})); });
      const result = await Promise.race([state.promise, canceled]);
      if (disposed || document.isClosed || document.version !== version || cancellation.isCancellationRequested || !enabled(document, feature)) return;
      // Saves and settings changes can deliver a second disk notification after
      // the request starts. Retry a settled buffer once; edits still return early.
      if (states.get(key) !== state || snapshot(document).stamp !== stamp) {
        return retry ? query(document, position, cancellation, feature, false) : undefined;
      }
      return (result[feature === "hover" ? "hovers" : "definitions"] ?? []).find(item => canonical(item.file) === canonical(document.uri.fsPath) && item.line === position.line + 1 &&
        item.column - 1 <= position.character && position.character < item.endColumn - 1);
    } finally { subscription?.dispose(); }
  }
  const range = item => new vscode.Range(item.line - 1, item.column - 1, (item.endLine ?? item.line) - 1, item.endColumn - 1);
  async function provideHover(document, position, cancellation) {
    const item = await query(document, position, cancellation, "hover");
    if (!item) return;
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    markdown.supportHtml = false;
    markdown.appendCodeblock(item.code, "prose");
    if (item.documentation) markdown.appendText("\n\n" + item.documentation);
    for (const note of item.notes ?? []) markdown.appendText("\n\n" + note);
    return new vscode.Hover(markdown, range(item));
  }
  async function provideDefinition(document, position, cancellation) {
    const item = await query(document, position, cancellation, "definition");
    return item?.targets.map(target => ({ originSelectionRange: range(item), targetUri: vscode.Uri.file(target.file),
      targetRange: range(target), targetSelectionRange: range(target) }));
  }
  const subscriptions = [
    output, vscode.languages.registerHoverProvider({ language: "prose", scheme: "file" }, { provideHover }),
    vscode.languages.registerDefinitionProvider({ language: "prose", scheme: "file" }, { provideDefinition }),
    workspace.onDidChangeTextDocument(({ document, contentChanges }) => { if (relevant(document) && contentChanges.length) invalidate(); }),
    workspace.onDidOpenTextDocument(document => { if (relevant(document)) invalidate(); }),
    workspace.onDidCloseTextDocument(invalidate), workspace.onDidSaveTextDocument(document => { if (relevant(document)) invalidate(); }),
    workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("prose.hover") || event.affectsConfiguration("prose.definition")) invalidate(); }),
    workspace.onDidChangeWorkspaceFolders(invalidate), workspace.onDidGrantWorkspaceTrust(invalidate),
    workspace.onDidDeleteFiles(invalidate), workspace.onDidRenameFiles(invalidate)
  ];
  const watcher = workspace.createFileSystemWatcher("**/*.{prose,ts,tsx,mts,cts,js,jsx,mjs,cjs,json}");
  subscriptions.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
  return { dispose() {
    if (disposed) return;
    disposed = true;
    invalidate();
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { createLanguageFeatures, createHovers: createLanguageFeatures };
