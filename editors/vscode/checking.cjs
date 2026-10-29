const { existsSync, readFileSync } = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");
const { Worker } = require("node:worker_threads");

const canonical = file => process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
const relevant = document => document.uri.scheme === "file" && /\.(?:prose|[cm]?[jt]sx?|json)$/i.test(document.uri.fsPath);
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

function createDiagnostics(vscode, { runCheck = startCheck, delay = 250 } = {}) {
  const { workspace } = vscode;
  const collection = vscode.languages.createDiagnosticCollection("prose");
  const output = vscode.window.createOutputChannel("Prose");
  const states = new Map();
  let disposed = false;

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
      const document = workspace.textDocuments.find(document => document.uri.scheme === "file" && canonical(document.uri.fsPath) === key);
      if (document?.isDirty || (document && state.versions.get(key) !== document.version)) continue;
      const uri = document?.uri ?? vscode.Uri.file(file);
      if (file.endsWith(".prose") && !workspace.getConfiguration("prose", uri).get("check.enabled", true)) continue;
      if (!sources.has(key)) {
        try { sources.set(key, document ? document.getText() : readFileSync(file, "utf8")); }
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
    const versions = new Map(workspace.textDocuments.filter(document => document.uri.scheme === "file")
      .map(document => [canonical(document.uri.fsPath), document.version]));
    try {
      const job = runCheck(state.options);
      state.job = job;
      const result = await job.promise;
      if (disposed || revision !== state.revision) return;
      // A result is a snapshot of saved files. Never publish it over a newer edit.
      const files = new Set(result.files.map(canonical));
      if (workspace.textDocuments.some(document => (inside(document.uri.fsPath, state.options.cwd) || files.has(canonical(document.uri.fsPath))) &&
        versions.has(canonical(document.uri.fsPath)) && versions.get(canonical(document.uri.fsPath)) !== document.version)) return;
      state.items = result.diagnostics;
      state.files = files;
      state.versions = versions;
      for (const item of state.items) if (item.source === "configuration" || item.source === "checker") {
        output.appendLine(`${state.options.cwd}: ${item.message}`);
      }
      publish();
    } catch (error) {
      if (disposed || revision !== state.revision) return;
      state.items = [{ source: "configuration", code: "PROSE_CHECK_SETUP", severity: "error", message: error.message }];
      state.versions = versions;
      output.appendLine(error.stack ?? error.message);
      publish();
    } finally {
      if (revision === state.revision) state.job = undefined;
    }
  }

  function refresh(immediate = false) {
    if (disposed) return Promise.resolve();
    const groups = new Map();
    if (workspace.isTrusted) for (const document of workspace.textDocuments) {
      if (!prose(document) || document.isDirty || !existsSync(document.uri.fsPath) || !workspace.getConfiguration("prose", document.uri).get("check.enabled", true)) continue;
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
      cancel(state);
      state.options = options;
      if (immediate) checks.push(validate(state));
      else state.timer = setTimeout(() => { void validate(state); }, delay);
    }
    publish();
    return Promise.all(checks);
  }

  const subscriptions = [
    collection, output,
    workspace.onDidOpenTextDocument(document => { if (prose(document)) void refresh(); }),
    workspace.onDidCloseTextDocument(document => { if (document.languageId === "prose") void refresh(); }),
    workspace.onDidSaveTextDocument(document => { if (relevant(document)) void refresh(); }),
    workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (!relevant(document) || !contentChanges.length) return;
      for (const state of states.values()) if (inside(document.uri.fsPath, state.options.cwd) || state.files.has(canonical(document.uri.fsPath))) {
        cancel(state);
        state.items = [];
      }
      publish();
    }),
    workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("prose.check")) void refresh(); }),
    workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
    workspace.onDidGrantWorkspaceTrust(() => { void refresh(); }),
    workspace.onDidDeleteFiles(() => { void refresh(); }),
    workspace.onDidRenameFiles(() => { void refresh(); }),
    vscode.commands.registerCommand("prose.check", () => refresh(true))
  ];
  void refresh();
  return { dispose() {
    disposed = true;
    for (const state of states.values()) cancel(state);
    states.clear();
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { createDiagnostics, diagnosticRange, findConfig, startCheck };
