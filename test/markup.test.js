import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compile, sourceLines } from '../src/transpile.js';
import { markupText } from '../src/markup.js';
import { format } from '../src/format.js';
import { checkProject } from '../src/check-project.js';
import { completeProject } from '../src/check-completion.js';
import { signatureHelpProject } from '../src/check-signature.js';
import { refactorProject } from '../src/check-refactor.js';

const ts = createRequire(import.meta.url)('typescript');

// Inspect the compiler's public React calls without requiring React in core Prose.
function run(source) {
  const result = compile(source), output = [];
  const code = result.code.replace(/^import .* from "react";\n/m, '');
  runInNewContext(code, { console: { log: value => output.push(value) },
    __prose_fragment: 'fragment', __prose_element: (tag, props, ...children) => ({ tag, props, children }) });
  return JSON.parse(JSON.stringify(output));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prose markup 😀 '));
  const write = (name, text) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'es2023', module: 'esnext', moduleResolution: 'bundler', types: [], strict: true }, include: ['*.prose'] }));
  write('node_modules/react/package.json', '{"name":"react","exports":{"./jsx-runtime":"./jsx-runtime.d.ts"}}');
  write('node_modules/react/jsx-runtime.d.ts', `export namespace JSX {
    interface Element { readonly element: unique symbol }
    interface ElementChildrenAttribute { children: {} }
    interface IntrinsicElements {
      div: { children?: unknown; className?: string; title?: string };
      span: { children?: unknown };
      button: { children?: unknown; disabled?: boolean; onClick?: (event: { preventDefault(): void; currentTarget: HTMLButtonElement }) => void };
    }
  }`);
  return { root, write, close: () => rmSync(root, { recursive: true, force: true }) };
}
const cursor = (file, source, needle) => {
  const offset = source.indexOf(needle); assert.ok(offset >= 0);
  const rows = source.slice(0, offset).split('\n'); return { file, line: rows.length, column: rows.at(-1).length + 1 };
};

test('markup emits React elements, fragments, boolean and snake_case attributes', () => {
  const [node] = run(`name is "Ada"
print <><div class_name="greeting" data-id='x'>Hello <span>{name}</span>!</div><button disabled /></>`);
  assert.equal(node.tag, 'fragment');
  assert.deepEqual(node.children[0], { tag: 'div', props: { className: 'greeting', 'data-id': 'x' }, children: ['Hello ', { tag: 'span', props: null, children: ['Ada'] }, '!'] });
  assert.deepEqual(node.children[1].props, { disabled: true });
  assert.equal(compile('print <div />').jsx, true);
  assert.equal(compile('print 1').jsx, undefined);
  assert.doesNotMatch(compile('print 1').code, /from "react"/);
});

test('text follows JSX line trimming with exact strings and Unicode entities', () => {
  for (const eol of ['\n', '\r\n']) {
    const [node] = run(['print <p>', '    Hello', '\tworld &amp; &#x1F600; &nbsp;', '', '    again', '</p>'].join(eol));
    assert.deepEqual(node.children, ['Hello world & 😀 \u00a0 again']);
  }
  assert.equal(markupText('one\n  two\n three'), 'one two three');
  assert.deepEqual(run('print <p>{"  a\\n b  "}</p>')[0].children, ['  a\n b  ']);
  assert.equal(run('print <p title="a  b" />')[0].props.title, 'a  b');
});

test('braces parse Prose calls, conditionals, inline callbacks, arrays and nested markup', () => {
  const output = run(`function double takes n
    return n * 2
values is 1, 2
print <div title={"yes" if 1 < 2 else "no"}>
    {values.map function takes n return <span key={n}>{double n}</span>}
    {<b>yes</b> if true else <i>no</i>}
</div>`);
  assert.equal(output[0].props.title, 'yes');
  assert.deepEqual(output[0].children[0].map(node => node.children), [[2], [4]]);
  assert.equal(output[0].children[1].tag, 'b');
});

test('uppercase and dotted components are values and markup is an ordinary expression', () => {
  const [node] = run(`Card is function takes props return props
UI is object Card is Card
function identity takes value
    return value
print identity (<UI.Card title="Prose"><Card /></UI.Card>)`);
  assert.equal(node.props.title, 'Prose');
  assert.equal(node.children.length, 1);
  assert.match(compile('print <div />', { check: true }).code, /<div><\/div>/);
});

test('comparison operators, strings and patterns retain their existing meanings', () => {
  assert.deepEqual(run('a is 1\nb is 2\nprint a<b\nprint a <b\nprint a <= b\nprint "<div>{x}</div>"'), [true, true, true, '<div>{x}</div>']);
  assert.doesNotMatch(compile('p is pattern "<div>"\nprint p').code, /from "react"/);
  assert.throws(() => compile('render is function takes n return n\nprint render <div />'), /Line 2/);
});

test('markup reports mismatched, duplicate and incomplete syntax at source lines', () => {
  for (const [source, message, line] of [
    ['print <div>\n</span>', /Expected <\/div>/, 2],
    ['print <div>hello', /Unclosed <div>/, 1],
    ['print <div title={1 />', /Unclosed markup expression/, 1],
    ['print <div title="no />', /Unclosed markup attribute string/, 1],
    ['print <div title="a" title="b" />', /Duplicate attribute/, 1],
    ['print <div class_name="a" className="b" />', /Duplicate React property/, 1],
    ['print <div title={} />', /cannot be empty/, 1],
    ['print <div>&bogus;</div>', /Unknown markup entity/, 1],
    ['print <div>&#x110000;</div>', /Invalid Unicode entity/, 1],
    ['print <div>bad }</div>', /Literal/, 1]
  ]) assert.throws(() => compile(source), error => message.test(error.message) && error.line === line, source);
});

test('format preserves authored tag/text layout, suffixes and following statements', () => {
  const source = 'function greeting takes name\r\n    return <div title="a  b">\r\n        Hello {name}\r\n        again\r\n    </div>\r\nprint  greeting "Ada"\r\n';
  const formatted = format(source, { tabWidth: 2 });
  assert.ok(formatted.includes('    </div>\r\nprint greeting "Ada"'));
  assert.equal(format(formatted, { tabWidth: 2 }), formatted);
  assert.equal(compile(source).code, compile(formatted).code);
  const suffix = 'value is (<div>\n    hi\n</div>)\nprint value\n';
  assert.equal(format(suffix), suffix);
});

test('React checking validates props and contextually types event callbacks at Prose positions', () => {
  const f = fixture();
  try {
    let source = 'view is <button\n    disabled={"bad"}\n    on_click={function takes event return event.no_such}\n/>', file = f.write('main.prose', source);
    let result = checkProject({ cwd: f.root, typescript: ts, targets: [file], hoverTargets: [file] });
    assert.ok(result.diagnostics.some(item => item.code === 2322 && item.line === 2), JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(item => item.code === 2339 && item.line === 3 && /noSuch/.test(item.message)));
    source = source.replace('"bad"', 'true').replace('event.no_such', 'event.prevent_default run');
    f.write('main.prose', source);
    result = checkProject({ cwd: f.root, typescript: ts, targets: [file] });
    assert.equal(result.exitCode, 0, JSON.stringify(result.diagnostics));
  } finally { f.close(); }
});

test('markup expressions retain hover, member completion and parameter help', () => {
  const f = fixture();
  try {
    const prefix = 'function label takes value as text, width as number, giving text\n    return value\nbook is object title is "Prose"\n';
    let source = prefix + 'view is <div>{book.title}</div>', file = f.write('main.prose', source);
    const result = checkProject({ cwd: f.root, typescript: ts, targets: [file], hoverTargets: [file] });
    assert.ok(result.hovers.some(item => item.code === 'title as text'), JSON.stringify(result.hovers));
    source = prefix + 'view is <div>{book.}</div>'; f.write('main.prose', source);
    const completion = completeProject({ cwd: f.root, typescript: ts, completion: cursor(file, source, '}</div>') });
    assert.ok(completion.items.some(item => item.label === 'title'), JSON.stringify(completion));
    source = prefix + 'view is <div>{label "a", }</div>'; f.write('main.prose', source);
    const help = signatureHelpProject({ cwd: f.root, typescript: ts, signature: cursor(file, source, '}</div>') }).signatureHelp;
    assert.ok(help, 'Expected help inside braces');
    assert.equal(help.activeParameter, 1);
  } finally { f.close(); }
});

test('component references include both tags, with safe scope-aware renaming', () => {
  const f = fixture();
  try {
    const source = 'function Card takes props\n    return <span>{props.title}</span>\nview is <Card title="Prose"></Card>\n';
    const file = f.write('main.prose', source);
    const result = refactorProject({ cwd: f.root, typescript: ts, refactor: { ...cursor(file, source, 'Card takes'), newName: 'Panel', includeDeclaration: true } });
    assert.equal(result.renameError, undefined, JSON.stringify(result));
    assert.equal(result.edits.length, 3, JSON.stringify(result));
    const tokens = sourceLines(source, { locations: true, embedded: true }).flatMap(row => row.tokens);
    assert.equal(tokens.filter(token => token.value === 'Card').length, 3);
  } finally { f.close(); }
});

test('component contracts, dotted tag names and CRLF positions remain checked', () => {
  const f = fixture();
  try {
    const prefix = 'type Props is object\n    title as text\nfunction Card takes props as Props\n    return <span>{props.title}</span>\nUI is object Card is Card\n';
    for (const eol of ['\n', '\r\n']) {
      const source = (prefix + 'view is <UI.Card title={12}></UI.Card>\n').replaceAll('\n', eol);
      const file = f.write('main.prose', source), result = checkProject({ cwd: f.root, typescript: ts, targets: [file], definitionTargets: [file], semanticTargets: [file] });
      assert.ok(result.diagnostics.some(item => item.code === 2322 && item.line === 6 && item.column === 18), JSON.stringify(result.diagnostics));
      const reference = refactorProject({ cwd: f.root, typescript: ts, refactor: { ...cursor(file, source, 'UI is'), newName: 'Widgets' } });
      assert.equal(reference.renameError, undefined, JSON.stringify(reference));
      assert.equal(reference.edits.length, 3);
    }
    const source = prefix + 'view is <Card />', file = f.write('main.prose', source);
    const result = checkProject({ cwd: f.root, typescript: ts, targets: [file] });
    assert.ok(result.diagnostics.some(item => item.code === 2741 && /title/.test(item.message)), JSON.stringify(result.diagnostics));
  } finally { f.close(); }
});

test('generic arrow callbacks and object attributes generate valid TSX checking code', () => {
  const f = fixture();
  try {
    const source = 'identity is function takes value as item giving item return value\nview is <div title={identity "Prose"}>\n    {<span>Yes</span> if 1 < 2 else <span>No</span>}\n</div>';
    const file = f.write('main.prose', source), result = checkProject({ cwd: f.root, typescript: ts, targets: [file] });
    assert.equal(result.exitCode, 0, JSON.stringify(result.diagnostics));
    assert.deepEqual(run('print <div style={object color is "red", font_size is 12} />')[0].props.style, { color: 'red', fontSize: 12 });
  } finally { f.close(); }
});
