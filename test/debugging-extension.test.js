import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { createDebugging } = createRequire(import.meta.url)('../editors/vscode/debugging.cjs');

function editor({ trusted = true, folder = true, node = 'node', allocatePort = async () => 43127 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "prose debug 😀 ' & $() ")), commands = new Map(), documents = [], calls = [], messages = [], errors = [], events = {};
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  const bundledCli = write('extension/dist/runtime/bin/prose.js', '// bundled');
  const workspaceFolder = { uri: uri(root) };
  const listen = name => callback => { (events[name] ??= new Set()).add(callback); return { dispose: () => events[name].delete(callback) }; };
  const fire = (name, value) => { for (const callback of events[name] ?? []) callback(value); };
  const vscode = {
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose: () => commands.delete(name) }; } },
    window: { activeTextEditor: undefined, showInformationMessage: text => messages.push(text), showWarningMessage: text => messages.push(text), showErrorMessage: text => errors.push(text) },
    workspace: { isTrusted: trusted, textDocuments: documents, getWorkspaceFolder: () => folder ? workspaceFolder : undefined,
      getConfiguration: () => ({ get: () => node }), openTextDocument: async resource => documents.find(document => document.uri.fsPath === resource.fsPath) },
    debug: { onDidStartDebugSession: listen('start'), onDidTerminateDebugSession: listen('end'),
      async startDebugging(folder, configuration, options) {
        const session = { id: String(calls.length), configuration }; calls.push({ folder, configuration, options, session }); fire('start', session); return true;
      } }
  };
  const service = createDebugging(vscode, { bundledCli, allocatePort });
  const add = (name = 'main.prose', source = 'print 1', extra = {}) => {
    const file = write(name, source), document = { uri: uri(file), languageId: 'prose', isDirty: false, isClosed: false, saves: 0, text: source,
      async save() { this.saves++; writeFileSync(file, this.text); this.isDirty = false; return true; }, ...extra };
    documents.push(document); vscode.window.activeTextEditor = { document }; return document;
  };
  return { root, write, vscode, commands, calls, messages, errors, events, fire, bundledCli, workspaceFolder, service, add,
    debug: resource => commands.get('prose.debug')(resource), close() { service.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test('debugging starts only on invocation, with current file, source maps and a loopback inspector', async () => {
  const e = editor({ node: 'custom node.exe' }), main = e.add("main ' & $().prose");
  try {
    assert.equal(e.calls.length, 0); assert.equal(await e.debug(), true);
    const { folder, configuration: c, options } = e.calls[0];
    assert.equal(folder, e.workspaceFolder); assert.equal(c.type, 'node'); assert.equal(c.request, 'launch');
    assert.equal(c.program, e.bundledCli); assert.deepEqual(c.args, [main.uri.fsPath, '--run']);
    assert.equal(c.runtimeExecutable, 'custom node.exe'); assert.equal(c.cwd, e.root);
    assert.deepEqual(c.runtimeArgs, ['--inspect-brk=127.0.0.1:43127']); assert.equal(c.attachSimplePort, 43127);
    assert.equal(c.pauseForSourceMap, true); assert.equal(c.sourceMaps, true); assert.equal(c.sourceMapRenames, true);
    assert.equal(c.smartStep, true); assert.equal(c.console, 'integratedTerminal');
    assert.ok(c.skipFiles.includes(e.bundledCli)); assert.ok(c.skipFiles.some(path => path.endsWith('runtime.js')));
    assert.deepEqual(options, { suppressSaveBeforeStart: true });
  } finally { e.close(); }
});

test('debugging saves the selected file without saving dirty dependencies', async () => {
  const e = editor(), main = e.add('main.prose', 'print "saved"', { isDirty: true, text: 'print "new"' });
  const dependency = e.add('child.prose', 'print "child"', { isDirty: true, text: 'print "unsaved child"' });
  try {
    await e.debug(main.uri); assert.equal(main.saves, 1); assert.equal(dependency.saves, 0);
    assert.equal(readFileSync(main.uri.fsPath, 'utf8'), main.text);
    assert.equal(readFileSync(dependency.uri.fsPath, 'utf8'), 'print "child"');
    assert.equal(e.calls[0].configuration.__proseFile, main.uri.fsPath);
  } finally { e.close(); }
});

test('debugging uses the project CLI and skips that compiler runtime during stepping', async () => {
  const e = editor(), main = e.add('app/main.prose');
  e.write('app/package.json', '{"name":"prose-lang"}');
  const cli = e.write('app/bin/prose.js', '// project CLI');
  try {
    await e.debug(); const config = e.calls[0].configuration;
    assert.equal(config.program, cli); assert.equal(config.cwd, dirname(dirname(cli)));
    assert.ok(config.skipFiles.includes(join(e.root, 'app/src/runtime.js')));
    assert.deepEqual(config.args, [main.uri.fsPath, '--run']);
  } finally { e.close(); }
});

test('trust, local document and folder guards prevent saves and inspector allocation', async () => {
  let ports = 0;
  const e = editor({ trusted: false, allocatePort: async () => { ports++; return 43127; } }), main = e.add('main.prose', 'print 1', { isDirty: true });
  try {
    await e.debug(); e.vscode.workspace.isTrusted = true;
    for (const scheme of ['untitled', 'vscode-vfs']) { main.uri.scheme = scheme; await e.debug(); }
    main.uri.scheme = 'file'; main.languageId = 'plaintext'; await e.debug(); main.languageId = 'prose';
    e.vscode.workspace.getWorkspaceFolder = () => undefined; await e.debug();
    assert.equal(main.saves, 0); assert.equal(ports, 0); assert.equal(e.calls.length, 0);
  } finally { e.close(); }
});

test('failed saves, newer edits and disposal during port allocation cannot launch', async () => {
  let portReady;
  const e = editor({ allocatePort: () => new Promise(resolve => { portReady = resolve; }) }), main = e.add('main.prose', 'print 1', { isDirty: true });
  try {
    main.save = async () => false; await e.debug(); assert.equal(e.calls.length, 0);
    main.save = async () => true; await e.debug(); assert.match(e.messages.at(-1), /changed while saving/);
    main.isDirty = false; const pending = e.debug(); main.isDirty = true; portReady(43127); await pending; assert.equal(e.calls.length, 0);
    main.isDirty = false; const next = e.debug(); e.service.dispose(); portReady(43128); await next; assert.equal(e.calls.length, 0);
    assert.equal(e.commands.size, 0); assert.ok(Object.values(e.events).every(listeners => listeners.size === 0));
  } finally { e.close(); }
});

test('duplicate debug requests are suppressed until the pending or active session ends', async () => {
  let ready;
  const e = editor({ allocatePort: () => new Promise(resolve => { ready = resolve; }) }); e.add();
  try {
    const pending = e.debug(); await e.debug(); assert.equal(e.calls.length, 0);
    ready(43127); await pending; await e.debug(); assert.equal(e.calls.length, 1);
    e.fire('end', e.calls[0].session); const next = e.debug(); ready(43128); await next; assert.equal(e.calls.length, 2);
  } finally { e.close(); }
});

test('setup errors clear pending requests and remain actionable', async () => {
  let fail = true;
  const e = editor({ allocatePort: async () => { if (fail) throw new Error('Could not allocate inspector port'); return 43127; } }); e.add();
  try {
    await e.debug(); assert.match(e.errors[0], /Could not debug Prose: Could not allocate inspector port/);
    fail = false; await e.debug(); assert.equal(e.calls.length, 1);
  } finally { e.close(); }
});

test('F5 applies only to idle Prose editors and gutter breakpoints are enabled', () => {
  const manifest = JSON.parse(readFileSync(new URL('../editors/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('debugging.cjs'));
  assert.ok(manifest.contributes.breakpoints.some(item => item.language === 'prose'));
  const key = manifest.contributes.keybindings.find(item => item.command === 'prose.debug');
  assert.equal(key.key, 'f5'); assert.match(key.when, /editorLangId == prose/); assert.match(key.when, /!inDebugMode/);
  assert.ok(manifest.contributes.commands.some(item => item.command === 'prose.debug'));
});
