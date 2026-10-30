const { createServer } = require('node:net');
const { statSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const { runContext } = require('./running.cjs');

const canonical = file => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
function inspectorPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function createDebugging(vscode, { bundledCli = join(__dirname, 'dist/runtime/bin/prose.js'), allocatePort = inspectorPort } = {}) {
  const pending = new Set(), sessions = new Map();
  let disposed = false;
  const subscriptions = [
    vscode.debug.onDidStartDebugSession(session => {
      if (typeof session.configuration.__proseFile === 'string') sessions.set(session.id, canonical(session.configuration.__proseFile));
    }),
    vscode.debug.onDidTerminateDebugSession(session => sessions.delete(session.id)),
    vscode.commands.registerCommand('prose.debug', async uri => {
      if (disposed) return;
      const { workspace, window, debug } = vscode;
      if (!workspace.isTrusted) { void window.showWarningMessage('Trust this workspace before debugging Prose files.'); return; }
      try {
        let document = uri ? workspace.textDocuments.find(document => !document.isClosed && document.uri.toString() === uri.toString()) : window.activeTextEditor?.document;
        if (!document && uri?.scheme === 'file') document = await workspace.openTextDocument(uri);
        if (!document || document.isClosed || document.uri.scheme !== 'file' || document.languageId !== 'prose' || !document.uri.fsPath.endsWith('.prose')) {
          void window.showInformationMessage('Open a local .prose file to debug it.'); return;
        }
        const folder = workspace.getWorkspaceFolder(document.uri);
        if (!folder || folder.uri.scheme !== 'file') { void window.showInformationMessage("Open this file's folder in VS Code before debugging it."); return; }
        const file = document.uri.fsPath, key = canonical(file);
        if (pending.has(key) || [...sessions.values()].includes(key)) {
          void window.showInformationMessage('This Prose file is already being debugged. Stop that session before starting another.'); return;
        }
        pending.add(key);
        try {
          const node = workspace.getConfiguration('prose', document.uri).get('run.nodePath', 'node');
          if (typeof node !== 'string' || !node.trim() || /[\0\r\n]/.test(node)) throw new Error('Set prose.run.nodePath to a Node executable name or path.');
          const { cli, cwd } = runContext(file, folder, bundledCli);
          if (!statSync(cli).isFile()) throw new Error('The Prose CLI is missing. Reinstall Prose Language.');
          if (document.isDirty && !(await document.save())) return;
          if (disposed || !workspace.isTrusted || document.isClosed) return;
          if (document.isDirty) { void window.showInformationMessage('The file changed while saving. Start debugging again when your edits are ready.'); return; }
          if (!statSync(file).isFile()) throw new Error('Save this Prose file before debugging it.');
          const port = await allocatePort();
          if (disposed || !workspace.isTrusted || document.isClosed || document.isDirty) return;
          const runtime = resolve(dirname(cli), '../src');
          // A direct loopback inspector connection also works on Windows Node
          // versions whose pipe enumeration breaks automatic debugger injection.
          return await debug.startDebugging(folder, {
            type: 'node', request: 'launch', name: 'Debug ' + basename(file), __proseFile: file,
            program: cli, args: [file, '--run'], cwd, runtimeExecutable: node,
            runtimeArgs: [`--inspect-brk=127.0.0.1:${port}`], attachSimplePort: port,
            console: 'integratedTerminal', sourceMaps: true, sourceMapRenames: true,
            pauseForSourceMap: true, smartStep: true, outFiles: [], resolveSourceMapLocations: ['**'],
            skipFiles: ['<node_internals>/**', cli, join(runtime, 'runtime.js'), join(runtime, 'node-hooks.js')],
            autoAttachChildProcesses: false
          }, { suppressSaveBeforeStart: true });
        } finally { pending.delete(key); }
      } catch (error) {
        if (!disposed) void window.showErrorMessage('Could not debug Prose: ' + error.message);
      }
    })
  ];
  return { dispose() {
    if (disposed) return;
    disposed = true; pending.clear(); sessions.clear();
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { createDebugging };
