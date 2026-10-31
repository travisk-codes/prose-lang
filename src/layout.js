// Logical lines, indentation, and continuation rules.
import { Expression } from "./expression.js";
import { lexSource } from "./lexer.js";
import { markupPosition } from "./markup.js";
import { isWord } from "./syntax.js";

const continuingSymbols = new Set([",", "+", "-", "*", "/", "%", "=", "!=", "<", ">", "<=", ">="]);
const continuingWords = new Set(["and", "or", "otherwise", "mod", "xor", "is", "are", "with", "giving", "of", "by", "return", "takes"]);

export function continues(tokens) {
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "symbol" && token.value === "(") depth++;
    else if (token.type === "symbol" && token.value === ")") depth--;
  }
  const last = tokens.at(-1);
  const propertyWord = tokens.length > 1 && [".", ":"].includes(tokens.at(-2)?.value);
  const conditionalEnd = last.type === "word" && ["if", "else"].includes(last.value) && tokens.length > 1 && !propertyWord;
  return depth > 0 || (last.type === "symbol" && continuingSymbols.has(last.value)) ||
    (last.type === "word" && continuingWords.has(last.value) && !propertyWord) || conditionalEnd;
}

// Exclude object/type fields named `if` or `while` from conditional headers.
function conditionStart(tokens) {
  const start = isWord(tokens[0], "if") || isWord(tokens[0], "while") ? 1
    : isWord(tokens[0], "else") && isWord(tokens[1], "if") ? 2 : 0;
  return !start || ["is", "as"].some(word => isWord(tokens[start], word)) ? 0 : start;
}

// Once function argument counts are known, make sure no inline body has started.
function conditionOnly(line, functions, analysis, scope, loose) {
  const start = conditionStart(line.tokens);
  if (!start) return false;
  const expr = new Expression(line.tokens.slice(start), line.line, functions, analysis, scope, loose);
  expr.parse();
  return !expr.peek() && !expr.blockFunctions.length;
}

// Locate the value in an expression statement, assignment, return, or print.
// Block headers must retain their indented bodies, including nested if blocks.
const blockHeaders = new Set(["if", "else", "while", "for", "function", "type", "use", "try", "on", "skip", "stop"]);
function valueStart(tokens) {
  const start = isWord(tokens[0], "export") ? 1 : 0;
  const field = isWord(tokens[start + 1], "is") || isWord(tokens[start + 1], "as");
  if (!field && blockHeaders.has(tokens[start]?.value)) return -1;
  if (!field && ["return", "print", "fail"].some(word => isWord(tokens[start], word))) {
    return start + 1 < tokens.length ? start + 1 : -1;
  }
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].type === "symbol" && tokens[i].value === "(") depth++;
    else if (tokens[i].type === "symbol" && tokens[i].value === ")") depth--;
    else if (!depth && isWord(tokens[i], "is") && ![".", ":"].includes(tokens[i - 1]?.value)) return i + 1;
  }
  return start;
}

function valueOnly(line, functions, analysis, scope, loose) {
  const start = valueStart(line.tokens);
  if (start < 0 || start >= line.tokens.length) return false;
  const expr = new Expression(line.tokens.slice(start), line.line, functions, analysis, scope, loose);
  const value = expr.list();
  const objectBody = value.type === "object" && !value.inline && !value.grouped;
  return !expr.peek() && !expr.blockFunctions.length && !objectBody;
}

// Before signatures are known, recognize pending lambda bodies conservatively.
function canWrapValue(line) {
  try { return valueOnly(line); }
  catch {
    const start = valueStart(line.tokens);
    return start >= 0 && !line.tokens.slice(start).some(token => isWord(token, "function"));
  }
}

function pendingConditional(tokens) {
  const start = valueStart(tokens);
  if (start < 0) return false;
  let pending = 0;
  for (let i = start; i < tokens.length; i++) {
    // Properties called if/else are names, including inline object entries.
    if ([".", ":"].includes(tokens[i - 1]?.value) || ["is", "as"].some(word => isWord(tokens[i + 1], word))) continue;
    if (isWord(tokens[i], "if")) pending++;
    else if (isWord(tokens[i], "else")) pending--;
  }
  return pending > 0;
}

// The source's lines with their indentation. A line with a parenthesis still open, or that ends in
// a comma or an operator, continues on the lines after it that are indented more.
// Conditions also accept leading and/or at the header's indentation or deeper.
// Indented if/else may continue a conditional value without opening a block.
export function sourceLines(source, { locations = false, embedded = false } = {}) {
  const lines = [];
  let open = null;
  const physical = source.split(/\r?\n/);
  lexSource(source).forEach(({ line: physicalLine, tokens }) => {
    const index = physicalLine - 1, text = physical[index].replace(/^\uFEFF/, '');
    const prefix = /^\s*/.exec(text)[0];
    const indent = prefix.replace(/\t/g, "    ").length;
    // A header's parameters can each take a line, with its giving line back at the header's
    // indentation, like a closing bracket.
    const closes = indent === open?.indent && isWord(tokens[0], "giving");
    const previous = lines.at(-1);
    const deeper = previous && indent > previous.indent;
    const pending = deeper && pendingConditional(previous.tokens);
    const startsValue = deeper && isWord(tokens[0], "if") &&
      !["is", "as"].some(word => isWord(tokens[1], word)) && canWrapValue(previous);
    const endsValue = pending && isWord(tokens[0], "else") &&
      !["is", "as"].some(word => isWord(tokens[1], word));
    const leading = previous && indent >= previous.indent &&
      (isWord(tokens[0], "and") || isWord(tokens[0], "or")) && (conditionStart(previous.tokens) || pending);
    if (open && (indent > open.indent || closes)) {
      open.tokens.push(...tokens);
    } else if (startsValue || endsValue || leading) {
      const wasOpen = Boolean(open);
      open = previous;
      if (startsValue) {
        if (!open.conditionalValues) Object.defineProperty(open, "conditionalValues", { value: [] });
        open.conditionalValues.push({ at: open.tokens.length, line: index + 1 });
      } else if (leading && conditionStart(open.tokens) && !wasOpen) {
        if (!open.leading) Object.defineProperty(open, "leading", { value: [] });
        open.leading.push({ at: open.tokens.length, line: index + 1 });
      }
      open.tokens.push(...tokens);
    } else {
      open = { line: index + 1, indent, tokens };
      lines.push(open);
    }
    if (!continues(open.tokens)) open = null;
  });
  if (embedded) for (const line of lines) line.tokens = line.tokens.flatMap(function flatten(token) {
    if (token.type !== 'markup') return [token];
    const found = [];
    function visit(node) {
      if (node.kind === 'expression') found.push(...node.tokens.flatMap(flatten));
      if (node.kind === 'element') {
        const tag = value => {
          if (!value || !/^[A-Z_]/.test(value.name)) return;
          let start = value.start;
          for (const [index, part] of value.name.split('.').entries()) {
            if (index) { found.push({ type: 'symbol', value: '.', source: { ...markupPosition(sourceText, start), raw: '.' } }); start++; }
            found.push({ type: 'word', value: part, source: { ...markupPosition(sourceText, start), raw: part } });
            start += part.length;
          }
        };
        const sourceText = token.markupSource;
        tag(node.tag); node.attributes.forEach(attribute => visit(attribute.value)); node.children.forEach(visit); tag(node.closingTag);
      }
    }
    visit(token.tree); return found;
  });
  if (!locations) for (const line of lines) for (const token of line.tokens) delete token.source;
  return lines;
}


export { conditionOnly, valueOnly };
