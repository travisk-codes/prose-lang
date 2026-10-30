import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createQuickFixes }=createRequire(import.meta.url)('../editors/vscode/quick-fixes.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function token() {
  const listeners=new Set();
  return {isCancellationRequested:false,listeners,onCancellationRequested(callback){listeners.add(callback);return {dispose:()=>listeners.delete(callback)};},cancel(){this.isCancellationRequested=true;listeners.forEach(callback=>callback());}};
}
function editor({trusted=true}={}) {
  const root=mkdtempSync(join(tmpdir(),'prose quick fix provider ')),documents=[],jobs=[],logs=[],events={};
  let provider,disposed=false,enabled=true;
  const listen=name=>callback=>{(events[name]??=new Set()).add(callback);return {dispose:()=>events[name].delete(callback)};};
  class Kind {constructor(value){this.value=value;} contains(other){return !this.value || other.value===this.value || other.value.startsWith(this.value+'.');}}
  const watcher={onDidChange:listen('disk'),onDidCreate:listen('created'),onDidDelete:listen('deleted'),dispose(){}};
  const vscode={
    Position:class {constructor(line,character){Object.assign(this,{line,character});}},
    Range:class {constructor(line,character,endLine,endCharacter){this.start={line,character};this.end={line:endLine,character:endCharacter};}},
    Diagnostic:class {constructor(range,message,severity){Object.assign(this,{range,message,severity});}},DiagnosticSeverity:{Error:0},
    CodeAction:class {constructor(title,kind){Object.assign(this,{title,kind});}}, CodeActionKind:{QuickFix:new Kind('quickfix')}, CodeActionTriggerKind:{Invoke:1,Automatic:2},
    WorkspaceEdit:class {edits=[];replace(uri,range,newText){this.edits.push({uri,range,newText});}},
    window:{createOutputChannel:()=>({appendLine:text=>logs.push(text),dispose(){}})},
    languages:{registerCodeActionsProvider(selector,value,metadata){assert.deepEqual(selector,{language:'prose',scheme:'file'});assert.deepEqual(metadata.providedCodeActionKinds,[vscode.CodeActionKind.QuickFix]);provider=value;return {dispose(){disposed=true;}};}},
    workspace:{isTrusted:trusted,textDocuments:documents,getConfiguration:()=>({get:(key,fallback)=>key==='quickFixes.enabled'?enabled:fallback}),
      getWorkspaceFolder:()=>({uri:{scheme:'file',fsPath:root}}),createFileSystemWatcher:()=>watcher,
      onDidChangeTextDocument:listen('change'),onDidOpenTextDocument:listen('open'),onDidCloseTextDocument:listen('close'),onDidSaveTextDocument:listen('save'),
      onDidChangeConfiguration:listen('settings'),onDidChangeWorkspaceFolders:listen('folders'),onDidGrantWorkspaceTrust:listen('trust'),onDidDeleteFiles:listen('delete'),onDidRenameFiles:listen('rename')}
  };
  const runCheck=options=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const job={options,promise,resolve,reject,canceled:0,cancel(){this.canceled++;}};jobs.push(job);return job;};
  const service=createQuickFixes(vscode,{runCheck});
  const add=(name,text='result is action 1, 2',extra={})=>{const file=join(root,name);writeFileSync(file,text);const document={uri:{scheme:'file',fsPath:file},languageId:name.endsWith('.prose')?'prose':'typescript',version:1,isClosed:false,text,getText(){return this.text;},...extra};documents.push(document);return document;};
  const fire=(name,value)=>{for(const callback of events[name]??[])callback(value);};
  return {vscode,jobs,logs,fire,add,request:(document,extra={},cancellation=token(),range=new vscode.Range(0,12,0,12))=>provider.provideCodeActions(document,range,{diagnostics:[],triggerKind:1,...extra},cancellation),
    resolve:(action,cancellation=token())=>provider.resolveCodeAction(action,cancellation),
    setEnabled(value){enabled=value;fire('settings',{affectsConfiguration:key=>key==='prose.quickFixes'});},
    close(){service.dispose();assert.ok(disposed);rmSync(root,{recursive:true,force:true});}};
}
const response=file=>({exitCode:1,diagnostics:[{file,source:'prose',code:'PROSE_CALL_BOUNDARY',severity:'error',line:1,column:19,message:'Choose argument or array boundaries.',quickFix:{range:{start:{line:1,column:11},end:{line:1,column:22}},actions:[
  {title:'Use with for arguments',reading:'arguments',edits:[{line:1,column:18,endColumn:18,newText:'with '}]},
  {title:'Make an array (put the call in parentheses)',reading:'array',edits:[{line:1,column:11,endColumn:11,newText:'('},{line:1,column:19,endColumn:19,newText:')'}]}
]}}]});

test('quick fixes use current buffers and offer two non-preferred, lazily resolved choices',async()=>{
  const e=editor(),main=e.add('main.prose'),child=e.add('child.prose','export action is 1');
  try {
    const pending=e.request(main);assert.deepEqual(e.jobs[0].options.quickFixTargets,[main.uri.fsPath]);
    assert.deepEqual(e.jobs[0].options.overlays,[[main.uri.fsPath,main.text],[child.uri.fsPath,child.text]]);
    e.jobs[0].resolve(response(main.uri.fsPath));const actions=await pending;assert.equal(actions.length,2);
    for(const action of actions){assert.equal(action.isPreferred,false);assert.equal(action.edit,undefined);assert.equal(action.diagnostics[0].code,'PROSE_CALL_BOUNDARY');}
    assert.equal(e.resolve(actions[0]).edit.edits[0].newText,'with ');
    assert.equal(e.resolve(actions[1]).edit.edits.length,2);assert.equal(main.text,'result is action 1, 2');
    assert.equal((await e.request(main)).length,2);assert.equal(e.jobs.length,1);
  } finally {e.close();}
});

test('selection, automatic diagnostics and requested action kinds are filtered',async()=>{
  const e=editor(),main=e.add('main.prose');
  try {
    assert.deepEqual(await e.request(main,{triggerKind:2}),[]);assert.equal(e.jobs.length,0);
    assert.deepEqual(await e.request(main,{only:{contains:()=>false}}),[]);assert.equal(e.jobs.length,0);
    assert.deepEqual(await e.request(main,{triggerKind:2,diagnostics:[{source:'Other',code:'PROSE_CALL_BOUNDARY'}]}),[]);
    const pending=e.request(main,{triggerKind:2,diagnostics:[{source:'Prose',code:{value:'PROSE_CALL_BOUNDARY'}}]});
    e.jobs[0].resolve(response(main.uri.fsPath));assert.equal((await pending).length,2);
    assert.deepEqual(await e.request(main,{},token(),new e.vscode.Range(2,0,2,1)),[]);
  } finally {e.close();}
});

test('editing, cancellation and late dependency notifications cannot publish stale actions',async()=>{
  const e=editor(),main=e.add('main.prose');
  try {
    const old=e.request(main);main.version++;e.fire('change',{document:main,contentChanges:[{text:'x'}]});assert.equal(e.jobs[0].canceled,1);
    e.jobs[0].resolve(response(main.uri.fsPath));assert.deepEqual(await old,[]);
    const cancellation=token(),canceled=e.request(main,{},cancellation);cancellation.cancel();assert.deepEqual(await canceled,[]);assert.equal(cancellation.listeners.size,0);
    const retry=e.request(main);e.fire('disk');e.jobs[1].resolve(response(main.uri.fsPath));await tick();
    assert.equal(e.jobs.length,3);e.jobs[2].resolve(response(main.uri.fsPath));assert.equal((await retry).length,2);
  } finally {e.close();}
});

test('resolution rechecks document versions and closed dependency content before providing edits',async()=>{
  const e=editor(),main=e.add('main.prose'),closed=e.add('child.prose','export action is 1',{isClosed:true});
  const hash=text=>createHash('sha256').update(text).digest('hex');
  try {
    const pending=e.request(main);e.jobs[0].resolve({...response(main.uri.fsPath),quickFixSnapshot:{directories:[],files:[{file:closed.uri.fsPath,hash:hash(closed.text)}]}});
    const actions=await pending;assert.ok(e.resolve(actions[0]).edit);
    writeFileSync(closed.uri.fsPath,'export action is 2');assert.ok(e.resolve(actions[0]).disabled);assert.equal(actions[0].edit,undefined);
    main.version++;assert.ok(e.resolve(actions[1]).disabled);assert.equal(actions[1].edit,undefined);
  } finally {e.close();}
});

test('trust, local files and the independent setting gate fixes; setup errors stay in Output',async()=>{
  const e=editor({trusted:false}),main=e.add('main.prose');
  try {
    assert.deepEqual(await e.request(main),[]);assert.equal(e.jobs.length,0);
    e.vscode.workspace.isTrusted=true;e.setEnabled(false);assert.deepEqual(await e.request(main),[]);assert.equal(e.jobs.length,0);
    e.setEnabled(true);main.uri.scheme='untitled';assert.deepEqual(await e.request(main),[]);main.uri.scheme='file';
    const setup=e.request(main);e.jobs[0].resolve({exitCode:2,diagnostics:[{message:'Install TypeScript'}]});assert.deepEqual(await setup,[]);assert.match(e.logs.join('\n'),/Install TypeScript/);
  } finally {e.close();}
});
