import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compile, parse } from '../src/transpile.js';
import { callBoundaryFixes } from '../src/call-quick-fixes.js';
import { checkProject } from '../src/check-project.js';
import { run } from './run.js';
const ts = createRequire(import.meta.url)('typescript');
function fixes(source, options) {
  let error; try { compile(source,options); } catch(caught) { error=caught; }
  assert.equal(error?.code,'PROSE_CALL_BOUNDARY');
  return callBoundaryFixes(source,error,options);
}
function apply(source, action) {
  for (const item of [...action.edits].sort((a,b)=>b.line-a.line || b.column-a.column)) {
    const rows=source.split('\n'), row=rows[item.line-1]; rows[item.line-1]=row.slice(0,item.column-1)+item.newText+row.slice(item.endColumn-1); source=rows.join('\n');
  }
  return source;
}
const action = (result, reading) => { const item=result?.actions.find(item=>item.reading===reading); assert.ok(item,reading); return item; };

test('unknown calls offer two explicit readings with different verified behavior', () => {
  const source='function apply takes action\n    return action 1, 2\nfunction choose takes first, second\n    if second = unset then return first\n    return first + second\nprint apply choose';
  const result=fixes(source);
  assert.equal(result.actions.length,2);
  const args=apply(source,action(result,'arguments')), array=apply(source,action(result,'array'));
  assert.match(args,/return action with 1, 2/); assert.match(array,/return \(action 1\), 2/);
  assert.deepEqual(run(args),[3]); assert.deepEqual(run(array),[[1,2]]);
});

test('method receivers, grouped callees, constructors and computed properties keep exact boundaries', () => {
  for (const source of [
    'result is Math.max 1, 2', 'result is (Math.max) 1, 2', 'result is Math:("max") 1, 2',
    'date is new Date 2026, 0, 1', 'function apply takes action\n    return action (1, 2), 3'
  ]) {
    const result=fixes(source); assert.equal(result.actions.length,2,source);
    for (const item of result.actions) assert.doesNotThrow(()=>compile(apply(source,item)));
  }
});

test('maybe stays attached to the call in both readings', () => {
  const source='function apply takes action\n    return maybe action 1, 2';
  const result=fixes(source), args=apply(source,action(result,'arguments')), array=apply(source,action(result,'array'));
  assert.match(array,/return \(maybe action 1\), 2/);
  assert.equal(parse(args)[0].body[0].value.maybe,true);
  assert.equal(parse(array)[0].body[0].value.elements[0].maybe,true);
});

test('a comma captured by an outer call is not mislabeled as an array separator', () => {
  const source='function outer takes first, second\n    return first\nfunction apply takes inner\n    return outer with inner 1, 2';
  const result=fixes(source);
  assert.deepEqual(result.actions,[]);
});

test('inline lambda array separators are checked in the actual parsed program', () => {
  const source='apply is function takes action return action 1, 2';
  const result=fixes(source); assert.equal(result.actions.length,2);
  const value=parse(apply(source,action(result,'array')))[0].value;
  assert.equal(value.type,'array'); assert.equal(value.elements[0].type,'lambda');
});

test('wrapped CRLF, tabs, Unicode and punctuation inside strings keep source positions', () => {
  for (const source of [
    'print "😀", Math.max "(", 2',
    'function apply takes action\r\n\treturn action 1,\r\n\t    2',
    'function apply takes action\n    return action pattern "a,b", 2'
  ]) {
    const result=fixes(source); assert.equal(result.actions.length,2,source);
    for (const item of result.actions) {
      const edited=apply(source,item); assert.doesNotThrow(()=>compile(edited));
      if (source.includes('\r\n')) assert.equal(edited.split('\r\n').length,source.split('\r\n').length);
    }
  }
});

test('other parser errors and incomplete alternatives receive no invented fix', () => {
  assert.equal(callBoundaryFixes('value is (',new SyntaxError('Unrelated')),undefined);
  const source='function apply takes action\n    return (action 1,)';
  let error; try { compile(source); } catch(caught) { error=caught; }
  assert.equal(callBoundaryFixes(source,error),undefined);
});

test('checker exposes a precise diagnostic and opt-in fixes against current imported buffers without writes', () => {
  const root=mkdtempSync(join(tmpdir(),'prose quick fixes 😀 '));
  const write=(name,source)=>{const file=join(root,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);return file;};
  try {
    write('tsconfig.json','{"compilerOptions":{"moduleResolution":"bundler","types":[]},"include":["*.prose"]}');
    const source='use action from "./child.prose"\nresult is action 1, 2\nfail "Never execute"';
    const file=write('main.prose',source), child=write('child.prose','export action is function takes value return value');
    const options={cwd:root,targets:[file],typescript:ts,overlays:[[child,'export action is JSON.parse "null"']]};
    const regular=checkProject(options), diagnostic=regular.diagnostics[0];
    assert.equal(diagnostic.code,'PROSE_CALL_BOUNDARY'); assert.equal(diagnostic.line,2); assert.equal(diagnostic.column,19);
    assert.equal(diagnostic.quickFix,undefined);
    const result=checkProject({...options,quickFixTargets:[file]});
    assert.equal(result.diagnostics[0].quickFix.actions.length,2);
    assert.ok(result.quickFixSnapshot.files.some(item=>item.file===child));
    assert.equal(readFileSync(file,'utf8'),source); assert.match(readFileSync(child,'utf8'),/function takes value/);
    assert.doesNotThrow(()=>JSON.stringify(result));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
