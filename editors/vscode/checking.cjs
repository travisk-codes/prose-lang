const { existsSync, readFileSync } = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");
const { Worker } = require("node:worker_threads");

const canonical = file => process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
const relevant = document => document.uri.scheme === "file" && !document.isClosed && /\.(?:prose|[cm]?[jt]sx?|json)$/i.test(document.uri.fsPath);
const prose = document => document.uri.scheme === "file" && document.uri.fsPath.endsWith(".prose") && document.languageId === "prose" && !document.isClosed;
const inside = (file, directory) => {
  const path = relative(canonical(directory), canonical(file));
  return !path || (path !== ".." && !path.startsWith("..\\") && !path.startsWith("../") && !isAbsolute(path));
};

function findConfig(file) {
  for (let directory = dirname(file);;) {
    const config = join(directory, "tsconfig.json");
    if (existsSync(config)) return config;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

// TypeScript and the project's compiler package stay off the extension host's
// event loop. Terminating a superseded worker also stops its synchronous check.
function startCheck(options) {
  const worker = new Worker(join(__dirname, "check-worker.cjs"), { workerData: options });
  const promise = new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => reject(new Error(`Prose checker stopped before returning a result (exit ${code}).`)));
  });
  return { promise, cancel: () => { void worker.terminate(); } };
}

function diagnosticRange(vscode, source, item) {
  const lines = source.split(/\r?\n/);
  const line = Math.min(Math.max((item.line ?? 1) - 1, 0), lines.length - 1);
  const text = lines[line];
  const column = item.column > 1 ? item.column - 1 : Math.max(0, text.search(/\S/));
  const start = Math.min(column, text.length);
  const token = text.slice(start).match(/^[\p{L}\p{N}_$]+|^./u)?.[0] ?? "";
  return new vscode.Range(line, start, line, Math.min(text.length, start + Math.max(1, token.length)));
}

function createDiagnostics(vscode, { runCheck = startCheck, delay = 350 } = {}) {
  const { workspace } = vscode;
  const collection = vscode.languages.createDiagnosticCollection("prose");
  const output = vscode.window.createOutputChannel("Prose");
  const states = new Map();
  let disposed = false;

  // A Prose dependency outside the project is identified by the check result.
  // JS/TS/JSON imports may live anywhere, so their edits conservatively refresh
  // all open projects, including while the first dependency graph is loading.
  const affects = (state, document, files = state.files) => !document || !document.uri.fsPath.endsWith('.prose') ||
    inside(document.uri.fsPath, state.options.cwd) || files.has(canonical(document.uri.fsPath));
  const buffers = () => workspace.textDocuments.filter(relevant);
  function changedSince(versions, files, state, incompleteGraph = false) {
    const current = new Map(buffers().map(document => [canonical(document.uri.fsPath), document]));
    for (const [key, snapshot] of versions) if ((incompleteGraph || affects(state, snapshot.document, files)) && current.get(key)?.version !== snapshot.version) return true;
    return [...current].some(([key, document]) => (incompleteGraph || affects(state, document, files)) && !versions.has(key));
  }

  function cancel(state) {
    state.revision++;
    clearTimeout(state.timer);
    state.job?.cancel();
    state.job = undefined;
  }

  function publish() {
    if (disposed) return;
    const entries = new Map();
    const sources = new Map();
    for (const state of states.values()) for (const item of state.items) {
      // Project-wide setup problems belong to the config, or the selected file
      // if there is no config. The message distinguishes these from source errors.
      const file = item.file ?? state.options.project ?? state.options.targets[0];
      const key = canonical(file);
      const document = workspace.textDocuments.find(document => !document.isClosed && document.uri.scheme === "file" && canonical(document.uri.fsPath) === key);
      if (document && (state.versions.get(key)?.version !== document.version || item.source === 'configuration' && document.isDirty)) continue;
      const uri = document?.uri ?? vscode.Uri.file(file);
      if (file.endsWith(".prose") && !workspace.getConfiguration("prose", uri).get("check.enabled", true)) continue;
      if (!sources.has(key)) {
        try { sources.set(key, state.versions.get(key)?.source ?? readFileSync(file, "utf8")); }
        catch { continue; } // A deleted dependency must not keep a stale marker.
      }
      const prefix = item.source === "configuration" ? "Type checking setup: "
        : item.source === "checker" ? "Type checker (no exact source location): " : "";
      const diagnostic = new vscode.Diagnostic(
        diagnosticRange(vscode, sources.get(key), item),
        prefix + item.message.replace(/\b_prose_([A-Za-z_0-9]+)/g, "$1"),
        item.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = "Prose";
      diagnostic.code = typeof item.code === "number" ? `TS${item.code}` : item.code;
      if (item.relatedInformation?.length) diagnostic.relatedInformation = item.relatedInformation.flatMap(related => {
        try {
          const source = workspace.textDocuments.find(document => !document.isClosed && document.uri.scheme === 'file' && canonical(document.uri.fsPath) === canonical(related.file))?.getText() ?? readFileSync(related.file, "utf8");
          return [new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(related.file), diagnosticRange(vscode, source, related)), related.message)];
        } catch { return []; }
      });
      if (!entries.has(key)) entries.set(key, [uri, []]);
      const diagnostics = entries.get(key)[1];
      if (!diagnostics.some(other => other.code === diagnostic.code && other.message === diagnostic.message &&
        other.range.start.line === diagnostic.range.start.line && other.range.start.character === diagnostic.range.start.character)) {
        diagnostics.push(diagnostic);
      }
    }
    collection.clear();
    collection.set([...entries.values()]);
  }

  async function validate(state) {
    const revision = state.revision;
    const versions = new Map(buffers().map(document => [canonical(document.uri.fsPath), { document, version: document.version, source: document.getText() }]));
    try {
      const job = runCheck({ ...state.options, overlays: [...versions.values()].map(({ document, source }) => [document.uri.fsPath, source]) });
      state.job = job;
      const result = await job.promise;
      if (disposed || revision !== state.revision) return;
      // Validate newly discovered external imports too. Their first edit may
      // precede the result that tells us which project imports them.
      const files = new Set(result.files.map(canonical));
      // A parse error may stop import discovery before the dependency's body is
      // added to files. Be conservative until a complete graph can be obtained.
      const incompleteGraph = result.diagnostics.some(item => item.source === 'prose');
      if (changedSince(versions, files, state, incompleteGraph)) { void refresh(); return; }
      state.items = result.diagnostics;
      state.files = files;
      state.versions = versions;
      for (const item of state.items) if (item.source === "configuration" || item.source === "checker") {
        output.appendLine(`${state.options.cwd}: ${item.message}`);
      }
      publish();
    } catch (error) {
      if (disposed || revision !== state.revision) return;
      if (changedSince(versions, state.files, state)) { void refresh(); return; }
      state.items = [{ source: "configuration", code: "PROSE_CHECK_SETUP", severity: "error", message: error.message }];
      state.versions = versions;
      output.appendLine(error.stack ?? error.message);
      publish();
    } finally {
      if (revision === state.revision) state.job = undefined;
    }
  }

  function refresh(immediate = false, changed) {
    if (disposed) return Promise.resolve();
    const groups = new Map();
    if (workspace.isTrusted) for (const document of workspace.textDocuments) {
      if (!prose(document) || !workspace.getConfiguration("prose", document.uri).get("check.enabled", true)) continue;
      const project = findConfig(document.uri.fsPath);
      const folder = workspace.getWorkspaceFolder(document.uri)?.uri;
      const cwd = project ? dirname(project) : folder?.scheme === "file" ? folder.fsPath : dirname(document.uri.fsPath);
      const strict = workspace.getConfiguration("prose", document.uri).get("check.strict", false);
      const key = canonical(project ?? cwd) + (strict ? "|strict" : "");
      if (!groups.has(key)) {
        groups.set(key, { cwd, project, targets: [], ...(strict ? { strict: true } : {}) });
      }
      groups.get(key).targets.push(document.uri.fsPath);
    }
    for (const [key, state] of states) if (!groups.has(key)) {
      cancel(state);
      states.delete(key);
    }
    const checks = [];
    for (const [key, options] of groups) {
      let state = states.get(key);
      if (!state) states.set(key, state = { revision: 0, items: [], files: new Set(), versions: new Map() });
      else if (changed && !affects(state, changed) && JSON.stringify(state.options) === JSON.stringify(options)) continue;
      cancel(state);
      state.items = [];
      state.options = options;
      if (immediate) checks.push(validate(state));
      else state.timer = setTimeout(() => { void validate(state); }, delay);
    }
    publish();
    return Promise.all(checks);
  }

  const subscriptions = [
    collection, output,
    workspace.onDidOpenTextDocument(document => { if (relevant(document)) void refresh(false, document); }),
    workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'file' && /\.(?:prose|[cm]?[jt]sx?|json)$/i.test(document.uri.fsPath)) void refresh(false, document); }),
    workspace.onDidSaveTextDocument(document => { if (relevant(document)) void refresh(false, document); }),
    workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (!relevant(document) || !contentChanges.length) return;
      void refresh(false, document);
    }),
    workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("prose.check")) void refresh(); }),
    workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
    workspace.onDidGrantWorkspaceTrust(() => { void refresh(); }),
    workspace.onDidDeleteFiles(() => { void refresh(); }),
    workspace.onDidRenameFiles(() => { void refresh(); }),
    vscode.commands.registerCommand("prose.check", () => refresh(true))
  ];
  const watcher = workspace.createFileSystemWatcher('**/*.{prose,ts,tsx,mts,cts,js,jsx,mjs,cjs,json}');
  const diskChanged = uri => { void refresh(false, { uri }); };
  subscriptions.push(watcher, watcher.onDidChange(diskChanged), watcher.onDidCreate(diskChanged), watcher.onDidDelete(diskChanged));
  void refresh();
  return { dispose() {
    if (disposed) return;
    disposed = true;
    for (const state of states.values()) cancel(state);
    states.clear();
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { createDiagnostics, diagnosticRange, findConfig, startCheck };
