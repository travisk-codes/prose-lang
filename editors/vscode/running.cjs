const { readFileSync, statSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');

const canonical = file => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };
function packageAt(directory) {
  try { return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); } catch { return; }
}

// Prefer the compiler the project is developing or has installed. The bundled
// CLI makes standalone examples work without installing a second Prose package.
function runContext(file, workspaceFolder, bundledCli) {
  let cwd, cli;
  for (let directory = dirname(file);;) {
    const pkg = packageAt(directory);
    if (!cwd && pkg) cwd = directory;
    for (const [root, info] of [[directory, pkg], [join(directory, 'node_modules', 'prose-lang'), packageAt(join(directory, 'node_modules', 'prose-lang'))]]) {
      const candidate = join(root, 'bin', 'prose.js');
      if (info?.name === 'prose-lang' && isFile(candidate)) { cli = candidate; break; }
    }
    if (cli || dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return { cli: cli ?? bundledCli, cwd: cwd ?? workspaceFolder?.uri.fsPath ?? dirname(file) };
}

function createRunner(vscode, { bundledCli = join(__dirname, 'dist', 'runtime', 'bin', 'prose.js') } = {}) {
  const pending = new Set();
  let disposed = false;
  const command = vscode.commands.registerCommand('prose.run', async uri => {
    if (disposed) return;
    const { workspace, window, tasks } = vscode;
    if (!workspace.isTrusted) { void window.showWarningMessage('Trust this workspace before running Prose files.'); return; }
    let document;
    try {
      document = uri ? workspace.textDocuments.find(document => !document.isClosed && document.uri.toString() === uri.toString()) : window.activeTextEditor?.document;
      if (!document && uri?.scheme === 'file') document = await workspace.openTextDocument(uri);
      if (!document || document.isClosed || document.uri.scheme !== 'file' || document.languageId !== 'prose' || !document.uri.fsPath.endsWith('.prose')) {
        void window.showInformationMessage('Open a local .prose file to run it.'); return;
      }
      const folder = workspace.getWorkspaceFolder(document.uri);
      if (!folder || folder.uri.scheme !== 'file') {
        void window.showInformationMessage("Open this file's folder in VS Code before running it."); return;
      }
      const file = document.uri.fsPath, key = canonical(file);
      if (pending.has(key) || tasks.taskExecutions.some(execution => execution.task.definition.type === 'prose' && execution.task.definition.file && canonical(execution.task.definition.file) === key)) {
        void window.showInformationMessage('This Prose file is already running. Use Tasks: Terminate Task to stop it.'); return;
      }
      pending.add(key);
      try {
        const node = workspace.getConfiguration('prose', document.uri).get('run.nodePath', 'node');
        if (typeof node !== 'string' || !node.trim() || /[\0\r\n]/.test(node)) throw new Error('Set prose.run.nodePath to a Node executable name or path.');
        const { cli, cwd } = runContext(file, folder, bundledCli);
        if (!isFile(cli)) throw new Error('The Prose runner is missing. Reinstall Prose Language or use a project with bin/prose.js.');
        if (document.isDirty && !(await document.save())) return;
        if (disposed || !workspace.isTrusted || document.isClosed) return;
        if (document.isDirty) { void window.showInformationMessage('The file changed while saving. Run it again when your edits are ready.'); return; }
        if (!isFile(file)) throw new Error('Save this Prose file before running it.');
        // ProcessExecution passes paths as separate arguments; file names are
        // never interpreted as PowerShell, cmd, or shell command text.
        const task = new vscode.Task({ type: 'prose', file }, folder,
          'Run ' + basename(file), 'Prose', new vscode.ProcessExecution(node, [cli, file, '--run'], { cwd }), []);
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
        return await tasks.executeTask(task);
      } finally { pending.delete(key); }
    } catch (error) {
      if (!disposed) void window.showErrorMessage('Could not run Prose: ' + error.message);
    }
  });
  return { dispose() { disposed = true; command.dispose(); pending.clear(); } };
}

module.exports = { createRunner, runContext };
