import { fail } from "./errors.js";
import { readMarkup } from "./markup.js";

const isWord = (token, value) => token?.type === "word" && token.value === value;

function tokenize(text, line, locations = false, context) {
  const tokens = [];
  let pos = 0;
  while (pos < text.length) {
    if (/\s/.test(text[pos])) { pos++; continue; }
    // Spacing only matters to tell `f -1` (a negative argument) from `f - 1`.
    const spaced = pos > 0 && /\s/.test(text[pos - 1]);
    const tokenStart = pos;
    const rest = text.slice(pos);
    const previous = tokens.at(-1) ?? context?.previous;
    const keywordOperand = previous?.type === 'word' &&
      ['return', 'is', 'are', 'print', 'fail', 'with', 'then', 'else', 'if', 'and', 'or', 'otherwise', 'not', 'in'].includes(previous.value) &&
      !['.', ':'].includes(tokens.at(-2)?.value);
    const operand = !previous || keywordOperand || previous.type === 'symbol' && ![')', '.', ':'].includes(previous.value);
    if (context && text[pos] === '<' && /[A-Za-z_>]/.test(text[pos + 1] ?? '') && operand) {
      const token = context.element(pos); token.spaced = spaced; tokens.push(token);
      Object.defineProperty(tokens, 'resumeOffset', { value: token.tree.end });
      return tokens;
    }
    const number = /^(?:\d+(?:\.\d+)?)/.exec(rest);
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
    if (number) {
      if (!Number.isFinite(Number(number[0]))) fail(line, "Number is too large.");
      tokens.push({ type: "number", value: Number(number[0]) });
      pos += number[0].length;
    } else if (word) {
      tokens.push({ type: "word", value: word[0] });
      pos += word[0].length;
    } else if (text[pos] === '"') {
      const start = pos++;
      let closed = false;
      while (pos < text.length) {
        const char = text[pos++];
        if (char === "\\") pos++;
        else if (char === '"') { closed = true; break; }
      }
      if (!closed) fail(line, "Unterminated string.");
      // After an accessor, `pattern` is a property name, not the start of a pattern literal.
      if (isWord(tokens.at(-1), "pattern") && ![".", ":"].includes(tokens.at(-2)?.value)) {
        // After `pattern` the text is a regular expression, kept as typed except that \" is a quote.
        const pattern = tokens.at(-1);
        tokens[tokens.length - 1] = { type: "pattern", value: text.slice(start + 1, pos - 1).replace(/\\(.)/g, (all, char) => char === '"' ? '"' : all) };
        if (locations) tokens.at(-1).source = { raw: `pattern ${text.slice(start, pos)}`, line, start: pattern.source.start };
        continue;
      }
      try {
        tokens.push({ type: "string", value: JSON.parse(text.slice(start, pos)) });
      } catch {
        fail(line, "Invalid string escape.");
      }
    } else {
      const operator = /^(?:<=|>=|!=|[=<>+*/%().,:-])/.exec(rest);
      if (!operator) fail(line, `Unexpected character ${JSON.stringify(text[pos])}.`);
      tokens.push({ type: "symbol", value: operator[0] });
      pos += operator[0].length;
    }
    tokens.at(-1).spaced = spaced;
    if (locations) tokens.at(-1).source = { raw: text.slice(tokenStart, pos), line, start: tokenStart + (context?.column ?? 0) };
  }
  return tokens;
}

export function lexSource(source) {
  const starts = [0];
  for (let at = 0; at < source.length; at++) if (source[at] === '\n') starts.push(at + 1);
  const position = offset => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid] <= offset) low = mid; else high = mid; }
    return { line: low + 1, start: offset - starts[low] };
  };
  const element = offset => {
    const tree = readMarkup(source, offset);
    function expressions(node) {
      if (node.kind === 'expression') node.tokens = range(node.start, node.end).flatMap(row => row.tokens);
      else if (node.kind === 'element') {
        node.attributes.forEach(attribute => expressions(attribute.value));
        node.children.forEach(expressions);
      }
    }
    expressions(tree);
    const token = { type: 'markup', value: source.slice(offset, tree.end), tree,
      source: { raw: source.slice(offset, tree.end), ...position(offset), end: position(tree.end) } };
    Object.defineProperty(token, 'markupSource', { value: source }); return token;
  };
  function range(start = 0, end = source.length) {
    const rows = []; let at = start, row = { line: position(start).line, tokens: [] };
    while (at < end) {
      const here = position(at), newline = source.indexOf('\n', at), stop = Math.min(newline < 0 ? end : newline, end);
      const tokens = tokenize(source.slice(at, stop).replace(/\r$/, ''), here.line, true,
        { column: here.start, previous: row.tokens.at(-1), element: pos => element(at + pos) });
      row.tokens.push(...tokens);
      if (tokens.resumeOffset !== undefined) { at = tokens.resumeOffset; continue; }
      if (row.tokens.length) rows.push(row);
      at = stop + 1; row = { line: position(at).line, tokens: [] };
    }
    if (row.tokens.length) rows.push(row);
    return rows;
  }
  return range();
}

/** The innermost brace expression at a cursor, for editor analysis. */
export function markupExpressionAt(source, line, column) {
  if (!source.includes('<')) return;
  const rows = source.split('\n');
  const offset = rows.slice(0, line - 1).reduce((sum, row) => sum + row.length + 1, 0) + column - 1;
  let found;
  const visit = node => {
    if (node.kind === 'expression' && node.start <= offset && node.end >= offset) {
      found = node;
      for (const token of node.tokens) if (token.type === 'markup') visit(token.tree);
    } else if (node.kind === 'element') { node.attributes.forEach(attribute => visit(attribute.value)); node.children.forEach(visit); }
  };
  try { for (const row of lexSource(source)) for (const token of row.tokens) if (token.type === 'markup') visit(token.tree); } catch { return; }
  return found;
}
