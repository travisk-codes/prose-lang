import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from '../editors/vscode/build.mjs';

const { createRunner, runContext } = createRequire(import.meta.url)('../editors/vscode/running.cjs');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prose run 😀 ' & $() "));
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  return { root, write, close: () => rmSync(root, { recursive: true, force: true }) };
}
function editor(f, { trusted = true, node = 'node', folder = true } = {}) {
  const commands = new Map(), documents = [], errors = [], messages = [], executions = [];
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
  const workspaceFolder = { uri: uri(f.root), name: 'Project', index: 0 };
  const bundledCli = f.write('extension/dist/runtime/bin/prose.js', '// bundled CLI');
  const vscode = {
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose: () => commands.delete(name) }; } },
    window: { activeTextEditor: undefined, showInformationMessage: text => messages.push(text), showWarningMessage: text => messages.push(text), showErrorMessage: text => errors.push(text) },
    workspace: { isTrusted: trusted, textDocuments: documents, getWorkspaceFolder: () => folder ? workspaceFolder : undefined,
      getConfiguration: () => ({ get: () => node }), openTextDocument: async resource => documents.find(doc => doc.uri.fsPath === resource.fsPath) },
    tasks: { taskExecutions: [], executeTask: async task => { const execution = { task, terminate() {} }; executions.push(execution); vscode.tasks.taskExecutions.push(execution); return execution; } },
    ProcessExecution: class { constructor(process, args, options) { Object.assign(this, { process, args, options }); } },
    Task: class { constructor(definition, scope, name, source, execution, problemMatchers) { Object.assign(this, { definition, scope, name, source, execution, problemMatchers }); } },
    TaskScope: { Workspace: 2 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 }
  };
  const service = createRunner(vscode, { bundledCli });
  const add = (name, source = 'print 1', extra = {}) => {
    const file = f.write(name, source);
    const doc = { uri: uri(file), languageId: 'prose', isDirty: false, isClosed: false, saves: 0, text: source,
      async save() { this.saves++; writeFileSync(file, this.text); this.isDirty = false; return true; }, ...extra };
    documents.push(doc); vscode.window.activeTextEditor = { document: doc }; return doc;
  };
  return { vscode, commands, documents, errors, messages, executions, bundledCli, workspaceFolder, service, add, run: resource => commands.get('prose.run')(resource) };
}

test('Run Current File launches an argument-based process task only after explicit invocation', async () => {
  const f = fixture(), e = editor(f), doc = e.add('examples/main file.prose');
  try {
    assert.equal(e.executions.length, 0);
    const executed = await e.run();
    assert.equal(executed, e.executions[0]);
    const { task } = executed;
    assert.deepEqual(task.definition, { type: 'prose', file: doc.uri.fsPath });
    assert.equal(task.scope, e.workspaceFolder);
    assert.equal(task.execution.process, 'node');
    assert.deepEqual(task.execution.args, [e.bundledCli, doc.uri.fsPath, '--run']);
    assert.equal(task.execution.options.cwd, f.root);
    assert.deepEqual(task.presentationOptions, { reveal: 1, panel: 2, clear: true });
    assert.equal(doc.saves, 0); assert.deepEqual(e.errors, []);
  } finally { e.service.dispose(); f.close(); }
});

test('running saves the selected dirty file, leaving unrelated and imported buffers alone', async () => {
  const f = fixture(), e = editor(f);
  const main = e.add('main.prose', 'print "saved"', { isDirty: true, text: 'print "changed"' });
  const child = e.add('child.prose', 'print "dependency"', { isDirty: true, text: 'print "unsaved dependency"' });
  try {
    await e.run(main.uri);
    assert.equal(main.saves, 1); assert.equal(child.saves, 0);
    assert.equal(readFileSync(main.uri.fsPath, 'utf8'), 'print "changed"');
    assert.equal(readFileSync(child.uri.fsPath, 'utf8'), 'print "dependency"');
    assert.equal(e.executions[0].task.definition.file, main.uri.fsPath);
  } finally { e.service.dispose(); f.close(); }
});

test('runner chooses the nearest development or installed Prose CLI and package working directory', () => {
  const f = fixture(), file = f.write('app/examples/main.prose', 'print 1'), bundled = 'bundled-cli';
  try {
    f.write('package.json', '{"name":"prose-lang"}');
    const development = f.write('bin/prose.js', '// development');
    f.write('app/package.json', '{"name":"app"}');
    assert.deepEqual(runContext(file, undefined, bundled), { cli: development, cwd: join(f.root, 'app') });
    f.write('app/node_modules/prose-lang/package.json', '{"name":"prose-lang"}');
    const installed = f.write('app/node_modules/prose-lang/bin/prose.js', '// installed');
    assert.deepEqual(runContext(file, undefined, bundled), { cli: installed, cwd: join(f.root, 'app') });
    f.write('app/examples/package.json', '{"name":"prose-lang"}');
    const nearest = f.write('app/examples/bin/prose.js', '// nearest');
    assert.deepEqual(runContext(file, undefined, bundled), { cli: nearest, cwd: join(f.root, 'app/examples') });
  } finally { f.close(); }
});

test('configured Node executable and punctuation in paths remain separate process arguments', async () => {
  const f = fixture(), node = join(f.root, 'Node Folder/node.exe'), e = editor(f, { node });
  const doc = e.add("standalone/odd ' & $().prose");
  try {
    await e.run();
    const { task } = e.executions[0];
    assert.equal(task.scope, e.workspaceFolder);
    assert.equal(task.execution.process, node);
    assert.deepEqual(task.execution.args, [e.bundledCli, doc.uri.fsPath, '--run']);
    assert.equal(task.execution.options.cwd, f.root);
  } finally { e.service.dispose(); f.close(); }
});

test('files outside an open local workspace explain the folder requirement before saving or executing', async () => {
  const f = fixture(), e = editor(f, { folder: false }), doc = e.add('loose.prose', 'print 1', { isDirty: true });
  try {
    await e.run(); assert.equal(e.executions.length, 0); assert.equal(doc.saves, 0);
    assert.match(e.messages[0], /Open this file's folder/);
  } finally { e.service.dispose(); f.close(); }
});

test('trust, file type and local document guards prevent execution and saving', async () => {
  const f = fixture(), e = editor(f, { trusted: false }), doc = e.add('main.prose', 'print 1', { isDirty: true });
  try {
    await e.run(); assert.equal(doc.saves, 0); assert.equal(e.executions.length, 0);
    e.vscode.workspace.isTrusted = true;
    for (const scheme of ['untitled', 'vscode-vfs']) {
      doc.uri.scheme = scheme; await e.run(); assert.equal(e.executions.length, 0);
    }
    doc.uri.scheme = 'file'; doc.languageId = 'plaintext'; await e.run(); assert.equal(e.executions.length, 0);
    e.vscode.window.activeTextEditor = undefined; await e.run(); assert.equal(e.executions.length, 0);
    assert.ok(e.messages.some(text => /Trust/.test(text)));
  } finally { e.service.dispose(); f.close(); }
});

test('failed saves and edits during saving cannot execute older source', async () => {
  const f = fixture(), e = editor(f), doc = e.add('main.prose', 'print 1', { isDirty: true });
  try {
    doc.save = async () => false; await e.run(); assert.equal(e.executions.length, 0);
    doc.save = async () => true; await e.run(); assert.equal(e.executions.length, 0);
    assert.match(e.messages.at(-1), /changed while saving/);
    doc.save = async () => { doc.isDirty = false; e.vscode.workspace.isTrusted = false; return true; };
    await e.run(); assert.equal(e.executions.length, 0);
  } finally { e.service.dispose(); f.close(); }
});

test('double clicks during save and active runs do not start duplicate programs', async () => {
  const f = fixture(), e = editor(f), doc = e.add('main.prose', 'print 1', { isDirty: true });
  try {
    let saved; doc.save = () => new Promise(resolve => { saved = resolve; });
    const first = e.run(); await e.run(); assert.equal(e.executions.length, 0);
    doc.isDirty = false; saved(true); await first; assert.equal(e.executions.length, 1);
    await e.run(); assert.equal(e.executions.length, 1);
    e.vscode.tasks.taskExecutions.length = 0; await e.run(); assert.equal(e.executions.length, 2);
  } finally { e.service.dispose(); f.close(); }
});

test('launch errors are actionable and disposal unregisters without terminating user tasks', async () => {
  const f = fixture(), e = editor(f), doc = e.add('main.prose');
  try {
    e.vscode.tasks.executeTask = async () => { throw new Error('Node executable not found'); };
    await e.run(); assert.match(e.errors.at(-1), /Could not run Prose: Node executable not found/);
    let saved; doc.isDirty = true; doc.save = () => new Promise(resolve => { saved = resolve; });
    const pending = e.run(); e.service.dispose(); doc.isDirty = false; saved(true); await pending;
    assert.equal(e.executions.length, 0); assert.equal(e.commands.size, 0);
  } finally { e.service.dispose(); f.close(); }
});

test('bundled CLI runs real imports, retains source locations and requires no project compiler installation', () => {
  const f = fixture();
  try {
    build(pathToFileURL(join(f.root, 'extension/dist/formatter') + '/'));
    const cli = join(f.root, 'extension/dist/runtime/bin/prose.js');
    const main = f.write('project/main file.prose', 'use double from "./math.prose"\nuse label from "./label.js"\nprint label + (double 3)');
    f.write('project/package.json', '{"type":"module"}');
    f.write('project/math.prose', 'export function double takes number\n    return number * 2');
    f.write('project/label.js', 'export const label = "Result: ";');
    const run = file => spawnSync(process.execPath, [cli, file, '--run'], { cwd: dirname(main), encoding: 'utf8' });
    const successful = run(main);
    assert.equal(successful.status, 0, successful.stderr); assert.equal(successful.stdout.trim(), 'Result: 6');
    const broken = f.write('project/broken.prose', 'print missing');
    const syntax = run(broken); assert.equal(syntax.status, 1); assert.match(syntax.stderr, /broken\.prose: Line 1: Unknown name/);
    const crash = f.write('project/crash.prose', 'print JSON.parse "oops"');
    const runtime = run(crash); assert.equal(runtime.status, 1); assert.match(runtime.stderr, /crash\.prose:1:/);
    const manifest = JSON.parse(readFileSync(new URL('../editors/vscode/package.json', import.meta.url), 'utf8'));
    assert.ok(manifest.files.includes('running.cjs'));
    assert.equal(manifest.contributes.commands.find(item => item.command === 'prose.run').icon, '$(play)');
    assert.equal(manifest.contributes.menus['editor/title'][0].command, 'prose.run');
  } finally { f.close(); }
});
