import { camel, continues, sourceLines, markupExpressionAt } from "./transpile.js";
import { markupPosition } from "./markup.js";
import { hoverType } from "./check-hover.js";

// The parser decides whether the cursor is an argument, including when a comma
// actually starts an array element. These probes never enter the user's buffer.
export function signatureContexts(source, line, column) {
  const embedded = markupExpressionAt(source, line, column);
  if (embedded) {
    const start = markupPosition(source, embedded.start);
    const localLine = line - start.line + 1, localColumn = line === start.line ? column - start.start : column;
    return signatureContexts(source.slice(embedded.start, embedded.end), localLine, localColumn).map(context => {
      let probe = context.probe;
      while (source.includes(probe)) probe += '_';
      return { ...context, probe, line, column, source: source.slice(0, embedded.start) +
        context.source.replaceAll(context.probe, probe) + source.slice(embedded.end) };
    });
  }
  const rows = source.split('\n'), text = rows[line - 1]?.replace(/\r$/, ''), caret = column - 1;
  if (text === undefined || caret < 0 || caret > text.length) return [];
  let probe = '__prose_signature_probe_0', serial = 0;
  while (source.includes(probe)) probe = `__prose_signature_probe_${++serial}`;
  const prefix = rows.slice(0, line); prefix[line - 1] = text.slice(0, caret);
  let logical, partialString;
  try { logical = sourceLines(prefix.join('\n'), { locations: true }).at(-1); }
  catch (error) {
    if (error.line !== line || !/Unterminated string|Invalid string escape/.test(error.message)) return [];
    // Discard an unfinished string, including a half-written escape, at the cursor.
    for (let start = caret - 1; start >= 0; start--) if (text[start] === '"') {
      try {
        prefix[line - 1] = text.slice(0, start) + JSON.stringify(probe);
        logical = sourceLines(prefix.join('\n'), { locations: true }).at(-1);
        partialString = start; break;
      } catch { /* An earlier quote may be the opening quote. */ }
    }
  }
  if (!logical) return [];
  const blankContinuation = !text.trim() && text.slice(0, caret).replace(/\t/g, '    ').length > logical.indent && continues(logical.tokens);
  if (!logical.tokens.some(token => token.source.line === line) && !blankContinuation) return [];
  const tokens = logical.tokens, last = tokens.at(-1);
  if (tokens[0]?.value === 'use' || tokens[0]?.value === 'type') return [];
  let endLine = line;
  try {
    const original = sourceLines(source, { locations: true }).find(row => row.tokens.some(token => token.source.line === line));
    if (original) endLine = original.tokens.at(-1).source.line;
  } catch { /* Keep unrelated malformed source; the checker will reject it. */ }
  const starts = [];
  if (partialString !== undefined) starts.push(partialString);
  else if (blankContinuation) starts.push(caret);
  else {
    const end = last.source.start + last.source.raw.length;
    if (last.source.line === line && (caret > end || last.type === 'symbol' && [',', '('].includes(last.value) || last.type === 'word' && last.value === 'with')) starts.push(caret);
    if (last.source.line === line && ['word', 'number', 'string', 'pattern'].includes(last.type) && !(last.type === 'word' && last.value === 'with')) {
      let at = tokens.length - 1;
      // A partial member belongs to the argument receiver, not its property key.
      while (['.', ':'].includes(tokens[at - 1]?.value) && at > 1 && tokens[at - 2].source.line === line) at -= 2;
      if (tokens[at - 1]?.value !== '.' && tokens[at - 1]?.value !== ':') starts.push(tokens[at].source.start);
    } else if (last.type === 'symbol' && last.value === ')' && last.source.line === line) {
      let depth = 1, at = tokens.length - 2;
      for (; at >= 0; at--) {
        if (tokens[at].type !== 'symbol') continue;
        if (tokens[at].value === ')') depth++;
        if (tokens[at].value === '(' && !--depth) break;
      }
      if (at >= 0 && tokens[at].source.line === line) starts.push(tokens[at].source.start);
    }
  }
  return [...new Set(starts)].map(start => {
    const before = tokens.filter(token => token.source.line < line || token.source.start < start);
    const depth = before.reduce((depth, token) => depth + (token.type !== 'symbol' ? 0 : token.value === '(' ? 1 : token.value === ')' ? -1 : 0), 0);
    const changed = [...rows];
    changed[line - 1] = text.slice(0, start) + ' ' + JSON.stringify(probe) + ')'.repeat(Math.max(0, depth)) + (rows[line - 1].endsWith('\r') ? '\r' : '');
    for (let index = line; index < endLine; index++) changed[index] = rows[index].endsWith('\r') ? '\r' : '';
    return { source: changed.join('\n'), probe, line, column };
  });
}

export function collectSignatureHelp(ts, checker, generated, record, context) {
  let marker;
  function find(node) {
    if (ts.isStringLiteral(node) && node.text === context.probe) marker = node;
    ts.forEachChild(node, find);
  }
  find(generated);
  if (!marker) return;
  let child = marker, call, argument;
  for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const index = parent.arguments?.indexOf(child) ?? -1;
      if (index < 0) return;
      call = parent; argument = index; break;
    }
  }
  if (!call) return;
  const position = generated.getLineAndCharacterOfPosition(call.getStart(generated));
  const original = record.lookup(position.line, position.character);
  const words = sourceLines(record.source, { locations: true, embedded: true }).flatMap(row => row.tokens);
  const origin = original && words.find(token => token.source.line === original.line && token.source.start === original.column - 1);
  if (origin?.value === 'print' && ts.isPropertyAccessExpression(call.expression) && call.expression.getText(generated) === 'console.log') return;
  const callee = call.expression, type = checker.getNonNullableType(checker.getTypeAtLocation(callee));
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return;
  const builtin = ts.isIdentifier(callee) && ['__prose_length', '__prose_char_to_number', '__prose_number_to_char'].includes(callee.text);
  if (ts.isIdentifier(callee) && callee.text.startsWith('__prose_') && !builtin) return;
  const signatures = checker.getSignaturesOfType(type, ts.isNewExpression(call) ? ts.SignatureKind.Construct : ts.SignatureKind.Call).slice(0, 32);
  if (!signatures.length) return;
  const resolved = checker.getResolvedSignature(call);
  const selected = Math.max(0, signatures.findIndex(signature => signature === resolved || signature === resolved?.target));
  if (resolved) signatures[selected] = resolved;
  let named = callee;
  while (ts.isParenthesizedExpression(named)) named = named.expression;
  const leaf = ts.isPropertyAccessExpression(named) ? named.name.text : ts.isIdentifier(named) ? named.text.replace(/^_prose_|^__prose_/, '') : 'function';
  let name = leaf;
  if (original) {
    const token = words.find(token => token.type === 'word' && camel(token.value) === leaf &&
      (token.source.line > original.line || token.source.line === original.line && token.source.start >= original.column - 1));
    if (token) name = token.value;
  }
  const rendered = signatures.map(signature => {
    const parameters = signature.getParameters().filter(parameter => !builtin || parameter.getName() !== 'line');
    let label = (ts.isNewExpression(call) ? 'new ' : '') + name + (parameters.length ? ' takes ' : '');
    const information = parameters.map((parameter, index) => {
      const declaration = parameter.valueDeclaration ?? parameter.getDeclarations()?.[0];
      const rest = Boolean(declaration?.dotDotDotToken), optional = Boolean(parameter.flags & ts.SymbolFlags.Optional || declaration?.questionToken || declaration?.initializer);
      const type = hoverType(ts, checker, checker.getTypeOfSymbolAtLocation(parameter, call), call, new Set(), true).replace(/\n/g, ' ');
      if (index) label += ', ';
      const start = label.length;
      label += (rest ? 'each of ' : '') + parameter.getName().replace(/^_prose_/, '') + ' as ' + (type.length > 400 ? type.slice(0, 399) + '…' : type) + (optional ? ' (optional)' : '');
      return { label: [start, label.length], documentation: ts.displayPartsToString(parameter.getDocumentationComment(checker)), rest };
    });
    label += ' giving ' + hoverType(ts, checker, signature.getReturnType(), call, new Set(), true).replace(/\n/g, ' ');
    return { label, documentation: ts.displayPartsToString(signature.getDocumentationComment(checker)),
      parameters: information.map(({ rest, ...parameter }) => parameter),
      activeParameter: information.at(-1)?.rest ? Math.min(argument, parameters.length - 1) : argument };
  });
  return { signatures: rendered, activeSignature: selected, activeParameter: rendered[selected].activeParameter };
}
