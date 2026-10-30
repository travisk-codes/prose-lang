import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { signatureHelpProject } from '../src/check-signature.js';
import { signatureContexts } from '../src/signature-help.js';
import { compile } from '../src/transpile.js';

const ts = createRequire(import.meta.url)('typescript');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prose signatures 😀 '));
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  write('tsconfig.json', '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]},"include":["*.prose","*.ts"]}');
  return { root, write, help(marked, extra = {}) {
    const offset = marked.indexOf('|'); assert.ok(offset >= 0);
    const source = marked.slice(0, offset) + marked.slice(offset + 1), before = source.slice(0, offset).split(/\r?\n/);
    const file = write('main.prose', source), signature = { file, line: before.length, column: before.at(-1).length + 1 };
    const result = signatureHelpProject({ cwd: root, typescript: ts, signature, ...extra });
    assert.equal(readFileSync(file, 'utf8'), source);
    return result.signatureHelp;
  }, close: () => rmSync(root, { recursive: true, force: true }) };
}
const cipher = 'function cipher takes message as text, rotate as number, giving text\n    return message\n';
const selected = help => { assert.ok(help, 'Expected signature help'); return help.signatures[help.activeSignature]; };
const active = help => { const signature = selected(help), span = signature.parameters[help.activeParameter].label; return signature.label.slice(...span); };

test('unfinished named calls show their declared signature and current argument', () => {
  const f = fixture();
  try {
    const first = f.help(cipher + 'print cipher |');
    assert.match(selected(first).label, /^cipher takes message as text, rotate as number giving text$/);
    assert.equal(active(first), 'message as text');
    const second = f.help(cipher + 'print cipher "hello", |');
    assert.equal(active(second), 'rotate as number');
    assert.equal(active(f.help(cipher + 'print cipher with "hello", |')), 'rotate as number');
    assert.equal(active(f.help(cipher + 'print cipher "he|llo", 2')), 'message as text');
    assert.equal(active(f.help(cipher + 'print cipher "hello", 2|')), 'rotate as number');
    assert.equal(active(f.help(cipher + 'cipher "(", |')), 'rotate as number');
    assert.equal(active(f.help(cipher + 'cipher "with|"')), 'message as text');
    assert.equal(active(f.help(cipher + 'cipher "a,b", |')), 'rotate as number');
    assert.doesNotThrow(() => JSON.stringify(first));
  } finally { f.close(); }
});

test('half-written strings and escapes retain parameter help', () => {
  const f = fixture();
  try {
    assert.equal(active(f.help(cipher + 'cipher "hel|')), 'message as text');
    assert.equal(active(f.help(cipher + 'cipher "hel\\|')), 'message as text');
  } finally { f.close(); }
});

test('nested calls select the inner call and resume the outer argument after its closing parenthesis', () => {
  const f = fixture();
  try {
    const prefix = cipher + 'function trim takes value as text, giving text\n    return value\n';
    assert.match(selected(f.help(prefix + 'cipher (trim |')).label, /^trim takes value as text/);
    assert.equal(active(f.help(prefix + 'cipher (trim "hello"), |')), 'rotate as number');
    assert.equal(active(f.help(prefix + 'cipher (trim "hello")|')), 'message as text');
  } finally { f.close(); }
});

test('function values and typed parameters use the same call boundaries as the compiler', () => {
  const g = fixture();
  try {
    assert.equal(g.help('double is function takes value as number giving number return value * 2\ndouble 2, |'), undefined);
    assert.equal(active(g.help('action is function takes left as number, right as number giving number return left + right\nalias is action\nprint alias 1, |')), 'right as number');
    assert.match(selected(g.help('function apply takes action as function taking text and number giving text\n    return action with "hello", |')).label, /arg2 as number/);
    assert.equal(g.help('function apply takes action\n    return action with 1, |'), undefined);
  } finally { g.close(); }
});

test('native methods keep Prose names and optional/rest parameters', () => {
  const f = fixture();
  try {
    const help = f.help('word is "hello"\nword.slice with 0, |');
    assert.match(selected(help).label, /^slice takes start as maybe number \(optional\), end as maybe number \(optional\) giving text$/);
    assert.match(active(help), /^end as /);
    assert.match(selected(f.help('word is "hello"\nword.index_of |')).label, /^index_of takes searchString as text/);
    assert.match(active(f.help('Math.max with 1, 2, |')), /each of values as list of number/);
    assert.equal(active(f.help('length |')), 'value as text or list of unknown');
    assert.match(selected(f.help('new Date with |')).label, /^new Date takes/);
    assert.match(active(f.help('console.log with |')), /each of data as list of any/);
    assert.equal(f.help('word is "hello"\nword.slice with 0, 1, |').activeParameter, 2);
  } finally { f.close(); }
});

test('overloads and generic inference use the receiver and already-entered arguments', () => {
  const f = fixture();
  try {
    f.write('types.ts', '/** Format a value. */\nexport function format(value: string, style: string): string;\n/** Format a number. */\nexport function format(value: number, precision: number): number;\nexport function format(value: string | number, option: string | number): string | number { return value; }\nexport function choose<T>(value: T, fallback?: T): T { return value; }');
    const help = f.help('use format from "./types"\nformat with 12, |');
    assert.equal(help.signatures.length, 2);
    assert.match(active(help), /^precision as number/);
    assert.match(selected(help).documentation, /Format a number/);
    const generic = f.help('use choose from "./types"\nchoose with 12, |');
    assert.match(active(generic), /fallback as /);
    assert.match(selected(generic).label, /giving (?:12|number)$/);
    assert.doesNotMatch(selected(generic).label, /__Prose|_prose_/);
  } finally { f.close(); }
});

test('callbacks and wrapped calls retain contextual types and argument positions', () => {
  const f = fixture();
  try {
    assert.match(selected(f.help('books is (object title is "A"), (object title is "B")\nlabels is books.map function takes book\n    return book.title.slice with 0, |')).label, /^slice takes/);
    assert.equal(active(f.help(cipher + 'cipher "hello",\n    |')), 'rotate as number');
    assert.equal(active(f.help(cipher.replace(/\n/g, '\r\n') + 'print "😀", cipher with "hello", |')), 'rotate as number');
  } finally { f.close(); }
});

test('current imported buffers supply fresh signatures without saves or execution', () => {
  const f = fixture();
  try {
    const child = f.write('child.prose', 'export function action takes saved as number\n    return saved');
    const changed = 'export function action takes message as text, count as number\n    return message';
    const help = f.help('use action from "./child.prose"\naction "hi", |\nfail "Never execute"', { overlays: [[child, changed]] });
    assert.equal(active(help), 'count as number');
    assert.match(readFileSync(child, 'utf8'), /saved as number/);
  } finally { f.close(); }
});

test('non-call contexts and unrelated syntax errors do not produce guessed signatures', () => {
  const f = fixture();
  try {
    for (const source of ['print "hello | world"', 'value is 1, |', 'word is "hello"\nword:|', 'type Value is |', cipher + 'broken is (\ncipher |']) assert.equal(f.help(source), undefined, source);
    assert.deepEqual(signatureContexts('word.', 1, 100), []);
    assert.throws(() => compile(cipher + 'cipher "hi"'), /Expected ','/);
    assert.throws(() => compile(cipher + 'cipher "hi",'), /Expected an expression/);
  } finally { f.close(); }
});
