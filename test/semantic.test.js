import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkProject } from '../src/check-project.js';
const ts = createRequire(import.meta.url)('typescript');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prose semantic 😀 '));
  const write = (name, source) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  write('tsconfig.json', '{"compilerOptions":{"target":"es2023","module":"esnext","moduleResolution":"bundler","types":[]},"include":["*.prose","*.ts"]}');
  return { root, write, check(source, extra = {}) {
    const file = write('main.prose', source);
    const result = checkProject({ cwd: root, targets: [file], semanticTargets: [file], typescript: ts, ...extra });
    assert.equal(readFileSync(file, 'utf8'), source);
    assert.doesNotThrow(() => JSON.stringify(result));
    return result.semanticTokens.find(record => record.file === file)?.tokens ?? [];
  }, close: () => rmSync(root, { recursive: true, force: true }) };
}
function at(tokens, source, needle, word = needle) {
  const offset = source.indexOf(needle) + needle.lastIndexOf(word); assert.ok(offset >= 0);
  const before = source.slice(0, offset).split(/\r?\n/);
  return tokens.find(token => token.line === before.length && token.column === before.at(-1).length + 1);
}

test('named functions, function-value aliases and reassignment follow the type at each use', () => {
  const f = fixture();
  const source = 'function double takes value as number, giving number\n    return value * 2\naction is double\nprint action 3\nchanging is function takes value return value\nprint changing 1\nchanging is 12\nprint changing';
  try {
    const tokens = f.check(source);
    for (const [needle, word] of [['function double','double'], ['action is','action'], ['print action','action'], ['changing is function','changing'], ['print changing 1','changing']]) assert.equal(at(tokens,source,needle,word)?.type,'proseFunction',needle);
    assert.equal(at(tokens,source,'changing is 12','changing')?.type,'proseBinding');
    const last = tokens.filter(token => token.line === source.split('\n').length);
    assert.equal(last[0]?.type,'proseVariable');
  } finally { f.close(); }
});

test('parameter identity survives closures, shadowing and higher-order calls', () => {
  const f = fixture();
  const source = 'value is 99\nfunction outer takes value\n    inner is function takes value return value + 1\n    capture is function takes delta return value + delta\n    return inner value\nfunction apply takes action as function taking number giving number\n    return action 2';
  try {
    const tokens = f.check(source);
    assert.equal(at(tokens,source,'value is','value')?.type,'proseBinding');
    for (const [needle,word] of [['outer takes value','value'], ['takes value return','value'], ['return value + 1','value'], ['return value + delta','value'], ['inner value','value']]) assert.equal(at(tokens,source,needle,word)?.type,'proseParameter',needle);
    assert.equal(at(tokens,source,'takes action','action')?.type,'proseParameter');
    assert.equal(at(tokens,source,'return action 2','action')?.type,'proseFunction');
  } finally { f.close(); }
});

test('loop variables and known numeric dot selectors differ from property keys', () => {
  const f = fixture();
  const source = 'items is 10, 20\nfor i is 1 to 2\n    print items.i\noffset is 1\nprint items.offset\nrecord is object offset is 99\nprint record.offset\nprint items:offset\nfor each entry in items\n    print entry';
  try {
    const tokens = f.check(source);
    assert.equal(at(tokens,source,'for i','i')?.type,'proseIterator');
    assert.equal(at(tokens,source,'items.i','i')?.type,'proseIterator');
    assert.equal(at(tokens,source,'items.offset','offset')?.type,'proseVariable');
    assert.equal(at(tokens,source,'record.offset','offset')?.type,'proseProperty');
    assert.equal(at(tokens,source,'items:offset','offset')?.type,'proseProperty');
    assert.equal(at(tokens,source,'each entry','entry')?.type,'proseIterator');
    assert.equal(at(tokens,source,'print entry','entry')?.type,'proseIterator');
  } finally { f.close(); }
});

test('object definitions, methods, shorthand and native calls receive their actual roles', () => {
  const f = fixture();
  const source = 'name is "Ada"\nrecord is object\n    name is name\n    transform is function takes value return value\nprint record.name\nprint record.transform 2\ninline is object name\nword is "hello"\nprint word.slice with 0, 2\nprint length word\nprint Math.max with 1, 2\ndate is new Date';
  try {
    const tokens = f.check(source);
    assert.equal(at(tokens,source,'    name is','name')?.type,'proseProperty');
    assert.equal(at(tokens,source,'record.name','name')?.type,'proseProperty');
    assert.equal(at(tokens,source,'record.transform','transform')?.type,'proseFunction');
    assert.equal(at(tokens,source,'inline is object name','name')?.type,'proseVariable');
    assert.equal(at(tokens,source,'word.slice','slice')?.type,'proseBuiltin');
    assert.equal(at(tokens,source,'length word','length')?.type,'proseBuiltin');
    assert.equal(at(tokens,source,'Math.max','max')?.type,'proseBuiltin');
    assert.equal(at(tokens,source,'new Date','Date'),undefined);
    const shadow = 'slice is "name"\nword is "hello"\nprint word.slice with 0, 2';
    assert.equal(at(f.check(shadow),shadow,'word.slice','slice')?.type,'proseBuiltin');
  } finally { f.close(); }
});

test('underscores, accessors, strings and comments never receive semantic spans', () => {
  const f = fixture();
  const source = 'first_name is "Ada"\nlast_name is first_name\nprint "first_name", last_name\n"first_name is a comment"\nrecord is object first_name is first_name\nprint record.first_name';
  try {
    const tokens = f.check(source), rows = source.split('\n');
    for (const token of tokens) assert.match(rows[token.line-1].slice(token.column-1,token.column-1+token.length),/^[A-Za-z0-9]+$/);
    assert.ok(tokens.some(token => token.line===1 && token.column===7 && token.length===4));
    assert.ok(!tokens.some(token => token.line===4));
    assert.equal(at(tokens,source,'"first_name",','first_name'),undefined);
    const spans = tokens.filter(token=>token.line===6);
    assert.ok(spans.every(token => !rows[5].slice(token.column-1,token.column-1+token.length).includes('.')));
  } finally { f.close(); }
});

test('current imported signatures and callback inference drive callable highlighting without execution', () => {
  const f = fixture();
  try {
    const child = f.write('child.prose','export function action takes value as number, giving number\n    return value');
    const source = 'use action from "./child.prose"\nalias is action\nprint alias 2\nbooks is (object title is "A"), (object title is "B")\nlabels is books.map function takes book\n    return book.title\nfail "Never execute"';
    const tokens = f.check(source);
    assert.equal(at(tokens,source,'alias is','alias')?.type,'proseFunction');
    assert.equal(at(tokens,source,'takes book','book')?.type,'proseParameter');
    assert.equal(at(tokens,source,'book.title','title')?.type,'proseProperty');
    const changed = f.check(source,{overlays:[[child,'export action is 12']]});
    assert.equal(at(changed,source,'alias is','alias')?.type,'proseBinding');
    assert.match(readFileSync(child,'utf8'),/export function action/);
  } finally { f.close(); }
});

test('ambiguous selectors and invalid syntax fall back, while UTF-16 ranges remain accurate', () => {
  const f = fixture();
  try {
    const source = 'function read takes items, position as number\n    return items.position';
    assert.equal(at(f.check(source),source,'items.position','position'),undefined);
    const unicode = 'function greet takes\r\n\tname as text,\r\ngiving text\r\n\treturn "😀" + name';
    assert.equal(at(f.check(unicode),unicode,'"😀" + name','name')?.type,'proseParameter');
    assert.deepEqual(f.check('value is "unfinished'),[]);
  } finally { f.close(); }
});
