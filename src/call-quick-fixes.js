import { compile, parse, sourceLines } from './transpile.js';

const pointOffset = (rows, point) => {
  if (!point || point.line < 1 || point.line > rows.length || point.column < 1 || point.column > rows[point.line-1].replace(/\r$/, '').length + 1) return;
  return rows.slice(0,point.line-1).reduce((sum,row)=>sum+row.length+1,0) + point.column-1;
};

/** Both readings are explicit choices. Only return edits whose resulting source
 * compiles, without running the program or its imported modules. */
export function callBoundaryFixes(source, error, { readModule } = {}) {
  const info = error?.code === 'PROSE_CALL_BOUNDARY' && error.callBoundaryInfo;
  if (!info) return;
  const rows = source.split('\n');
  const start = pointOffset(rows,info.start), argument = pointOffset(rows,info.argument), comma = pointOffset(rows,info.comma);
  if ([start,argument,comma].some(value=>value === undefined) || start >= argument || argument >= comma || source[comma] !== ',') return;
  const edit = (point,newText) => ({ ...point, endColumn: point.column, newText });
  const candidates = [
    { title: 'Use with for arguments', reading: 'arguments', edits: [edit(info.argument,'with ')] },
    { title: 'Make an array (put the call in parentheses)', reading: 'array', edits: [edit(info.start,'('),edit(info.comma,')')] }
  ];
  const actions = candidates.filter(candidate => {
    let changed = source;
    const edits = candidate.edits.map(item=>({ ...item,offset:pointOffset(rows,item) })).sort((a,b)=>b.offset-a.offset);
    for (const item of edits) changed = changed.slice(0,item.offset) + item.newText + changed.slice(item.offset);
    try {
      compile(changed,{check:true,readModule});
      const tree = parse(changed,{readModule});
      const changedComma = comma + edits.filter(item=>item.offset<=comma).reduce((sum,item)=>sum+item.newText.length,0);
      const point = changed.slice(0,changedComma).split(/\r?\n/);
      let matches = false;
      function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (candidate.reading === 'array' && node.type === 'array' && node.separators?.some(separator=>separator?.line===point.length && separator.start===point.at(-1).length)) matches = true;
        if (candidate.reading === 'arguments' && ['call','invoke','new'].includes(node.type) && node.args.length > 1 &&
            node.location?.line===info.start.line && node.location.start===info.start.column-1) matches = true;
        for (const value of Object.values(node)) if (typeof value === 'object') visit(value);
      }
      visit(tree); return matches;
    } catch { return false; }
  });
  const logical = sourceLines(source,{locations:true}).find(row=>row.tokens.some(token=>token.source.line===info.comma.line && token.source.start===info.comma.column-1));
  const lastLine = logical?.tokens.at(-1).source.line ?? info.comma.line;
  return { range: { start: info.start, end: { line: lastLine, column: rows[lastLine-1].replace(/\r$/, '').length+1 } }, actions };
}
