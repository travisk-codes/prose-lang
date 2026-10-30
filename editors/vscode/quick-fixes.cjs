const { dirname, resolve } = require('node:path');
const { findConfig, startCheck, diagnosticRange } = require('./checking.cjs');
const { snapshotMatches } = require('./refactoring.cjs');
const canonical = file => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
const relevant = document => document.uri.scheme === 'file' && !document.isClosed && /\.(?:prose|[cm]?[jt]sx?|json)$/i.test(document.uri.fsPath);
const boundaryCode = diagnostic => (typeof diagnostic.code === 'object' ? diagnostic.code?.value : diagnostic.code) === 'PROSE_CALL_BOUNDARY' && diagnostic.source === 'Prose';
const compare = (a,b) => a.line-b.line || a.character-b.character;

function createQuickFixes(vscode, { runCheck = startCheck, checkSnapshot = snapshotMatches } = {}) {
  const { workspace } = vscode, states = new Map(), actions = new WeakMap();
  const output = vscode.window.createOutputChannel('Prose Quick Fixes');
  let disposed = false;
  const enabled = document => workspace.isTrusted && relevant(document) && document.languageId === 'prose' &&
    workspace.getConfiguration('prose',document.uri).get('quickFixes.enabled',true);
  function invalidate() { for (const state of states.values()) state.job?.cancel(); states.clear(); }
  function snapshot(document) {
    const documents = workspace.textDocuments.filter(relevant);
    if (!documents.some(other=>canonical(other.uri.fsPath)===canonical(document.uri.fsPath))) documents.push(document);
    return { documents, stamp: JSON.stringify(documents.map(other=>[canonical(other.uri.fsPath),other.version]).sort(([a],[b])=>a.localeCompare(b))) };
  }
  async function query(document,cancellation,retry=true) {
    if (disposed || cancellation.isCancellationRequested || !enabled(document)) return;
    const version=document.version, { documents,stamp }=snapshot(document), key=canonical(document.uri.fsPath);
    let state=states.get(key);
    if (state && state.stamp!==stamp) { state.job?.cancel(); states.delete(key); state=undefined; }
    if (!state) {
      const project=findConfig(document.uri.fsPath), folder=workspace.getWorkspaceFolder(document.uri)?.uri;
      const cwd=project ? dirname(project) : folder?.scheme==='file' ? folder.fsPath : dirname(document.uri.fsPath);
      state={stamp}; states.set(key,state);
      try {
        state.job=runCheck({cwd,project,targets:[document.uri.fsPath],quickFixTargets:[document.uri.fsPath],overlays:documents.map(other=>[other.uri.fsPath,other.getText()])});
        state.promise=state.job.promise.catch(error=>{if(!disposed && states.get(key)===state) output.appendLine(error.stack??error.message);return {};}).finally(()=>{state.job=undefined;});
      } catch(error) { output.appendLine(error.message); state.promise=Promise.resolve({}); }
    }
    let subscription;
    try {
      const canceled=new Promise(resolve=>{subscription=cancellation.onCancellationRequested(()=>resolve({}));});
      const result=await Promise.race([state.promise,canceled]);
      if (disposed || document.version!==version || cancellation.isCancellationRequested || !enabled(document)) return;
      if (states.get(key)!==state || snapshot(document).stamp!==stamp || !checkSnapshot(result.quickFixSnapshot,workspace.textDocuments)) {
        invalidate(); return retry ? query(document,cancellation,false) : undefined;
      }
      if (result.exitCode===2) { for(const diagnostic of result.diagnostics??[]) output.appendLine(diagnostic.message); return; }
      return result;
    } finally { subscription?.dispose(); }
  }
  const point = item => new vscode.Position(item.line-1,item.column-1);
  const editRange = item => new vscode.Range(item.line-1,item.column-1,item.line-1,item.endColumn-1);
  async function provideCodeActions(document,range,context,cancellation) {
    if (context.only && !context.only.contains(vscode.CodeActionKind.QuickFix)) return [];
    if (context.triggerKind===vscode.CodeActionTriggerKind.Automatic && !(context.diagnostics??[]).some(boundaryCode)) return [];
    const result=await query(document,cancellation); if(!result) return [];
    const provided=[];
    for (const diagnostic of result.diagnostics??[]) {
      if (diagnostic.code!=='PROSE_CALL_BOUNDARY' || !diagnostic.quickFix || !diagnostic.file || canonical(diagnostic.file)!==canonical(document.uri.fsPath)) continue;
      const target=diagnostic.quickFix.range;
      if (compare(range.end,point(target.start))<0 || compare(range.start,point(target.end))>0) continue;
      const marker=new vscode.Diagnostic(diagnosticRange(vscode,document.getText(),diagnostic),diagnostic.message,vscode.DiagnosticSeverity.Error);
      marker.source='Prose'; marker.code=diagnostic.code;
      for (const choice of diagnostic.quickFix.actions) {
        const action=new vscode.CodeAction(choice.title,vscode.CodeActionKind.QuickFix);
        action.diagnostics=[marker]; action.isPreferred=false;
        actions.set(action,{document,version:document.version,snapshot:result.quickFixSnapshot,edits:choice.edits});
        provided.push(action);
      }
    }
    return provided;
  }
  function resolveCodeAction(action,cancellation) {
    const data=actions.get(action); if(!data) return action;
    delete action.edit;
    if(cancellation.isCancellationRequested) return action;
    if (disposed || !enabled(data.document) || data.document.version!==data.version || !checkSnapshot(data.snapshot,workspace.textDocuments)) {
      action.disabled={reason:'This quick fix is no longer current. Request it again.'}; return action;
    }
    const edit=new vscode.WorkspaceEdit();
    for (const item of data.edits) edit.replace(data.document.uri,editRange(item),item.newText);
    delete action.disabled; action.edit=edit; return action;
  }
  const subscriptions=[output,
    vscode.languages.registerCodeActionsProvider({language:'prose',scheme:'file'},{provideCodeActions,resolveCodeAction},{providedCodeActionKinds:[vscode.CodeActionKind.QuickFix]}),
    workspace.onDidChangeTextDocument(({document,contentChanges})=>{if(relevant(document)&&contentChanges.length)invalidate();}),
    workspace.onDidOpenTextDocument(document=>{if(relevant(document))invalidate();}),
    workspace.onDidCloseTextDocument(invalidate),workspace.onDidSaveTextDocument(document=>{if(relevant(document))invalidate();}),
    workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('prose.quickFixes'))invalidate();}),
    workspace.onDidChangeWorkspaceFolders(invalidate),workspace.onDidGrantWorkspaceTrust(invalidate),
    workspace.onDidDeleteFiles(invalidate),workspace.onDidRenameFiles(invalidate)
  ];
  const watcher=workspace.createFileSystemWatcher('**/*.{prose,ts,tsx,mts,cts,js,jsx,mjs,cjs,json}');
  subscriptions.push(watcher,watcher.onDidChange(invalidate),watcher.onDidCreate(invalidate),watcher.onDidDelete(invalidate));
  return {dispose(){if(disposed)return;disposed=true;invalidate();for(const subscription of subscriptions)subscription.dispose();}};
}
module.exports={createQuickFixes};
