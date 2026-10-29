import { continues, parse, sourceLines } from "./transpile.js";

const unaryAfter = new Set([
  "is", "are", "print", "return", "with", "then", "else", "if", "while",
  "in", "to", "and", "or", "not", "otherwise", "mod", "xor", "by",
  "remainder", "fail", "giving", "as", "of"
]);
const symbol = (token, value) => token?.type === "symbol" && token.value === value;
const accessor = token => symbol(token, ".") || symbol(token, ":");
const unaryMinus = (tokens, i) => symbol(tokens[i], "-") &&
  (!tokens[i - 1] || (tokens[i - 1].type === "symbol" && !symbol(tokens[i - 1], ")")) ||
    (tokens[i - 1].type === "word" && unaryAfter.has(tokens[i - 1].value) && !accessor(tokens[i - 2])));

function spaceBefore(tokens, i) {
  if (!i) return "";
  const previous = tokens[i - 1], token = tokens[i];
  // `matrix.1 .2` needs this space: joining it would lex 1.2 as one number.
  if (previous.type === "number" && symbol(token, ".")) return " ";
  if (accessor(previous) || accessor(token) || symbol(token, ",") || symbol(token, ")") || symbol(previous, "(")) return "";
  if (unaryMinus(tokens, i - 1) && !symbol(token, "-")) return "";
  return " ";
}

// Line locations affect diagnostics, but not the program being formatted. Documentation,
// call boundaries, parentheses, types, and all other syntax must survive unchanged.
const meaning = program => JSON.stringify(program, (key, value) => key === "line" ? undefined : value);

function wrap(tokens, depth, { width, tabWidth, insertSpaces }) {
  const indent = level => (insertSpaces ? " ".repeat(tabWidth) : "\t").repeat(level);
  const parts = tokens.map((token, i) => spaceBefore(tokens, i) + token.source.raw);
  const breaks = new Set();
  let depthInParentheses = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (symbol(tokens[i - 1], "(")) depthInParentheses++;
    if (symbol(tokens[i - 1], ")")) depthInParentheses--;
    // A minus at the edge of a physical line can change the parser's distinction
    // between subtraction and a negative call argument. Keep its operand with it.
    if (symbol(tokens[i - 1], "-") || symbol(tokens[i], "-") || symbol(tokens[i], ",") || symbol(tokens[i], ")") ||
        accessor(tokens[i]) || accessor(tokens[i - 1])) continue;
    if (depthInParentheses > 0 || continues(tokens.slice(Math.max(0, i - 2), i))) breaks.add(i);
  }
  const lines = [];
  let start = 0;
  while (start < parts.length) {
    const level = depth + (start ? 1 : 0);
    let end = start, length = level * tabWidth, fitting = null;
    while (end < parts.length) {
      length += (end === start ? parts[end].trimStart() : parts[end]).length;
      if (length > width) break;
      end++;
      if (breaks.has(end)) fitting = end;
    }
    if (end < parts.length) {
      // If an indivisible piece exceeds the width, keep it whole and break at
      // the first safe opportunity afterwards. Width is a target, not a rewrite.
      end = fitting ?? [...breaks].find(point => point > start && point >= end) ?? parts.length;
    }
    lines.push(indent(level) + parts.slice(start, end).join("").trimStart());
    start = end;
  }
  return lines;
}

/** Format valid Prose without changing its parsed meaning. Imports need readModule,
 * just as compile does. Strings, patterns, parentheses, and accessor choices are kept.
 */
export function format(source, options = {}) {
  const { width = 80, tabWidth = 4, insertSpaces = true, readModule } = options;
  if (!Number.isInteger(width) || width < 20) throw new RangeError("Format width must be an integer of at least 20.");
  if (!Number.isInteger(tabWidth) || tabWidth < 1 || tabWidth > 16) throw new RangeError("Tab width must be an integer from 1 to 16.");
  const program = parse(source, { readModule });
  const output = [], indents = [0];
  let previousEnd = 0;
  for (const line of sourceLines(source, { locations: true })) {
    while (line.indent < indents.at(-1)) indents.pop();
    if (line.indent > indents.at(-1)) indents.push(line.indent);
    if (output.length && line.line > previousEnd + 1) output.push("");
    output.push(...wrap(line.tokens, indents.length - 1, { width, tabWidth, insertSpaces }));
    previousEnd = line.tokens.at(-1).source.line;
  }
  const eol = options.endOfLine ?? (source.includes("\r\n") ? "\r\n" : "\n");
  if (!["\n", "\r\n"].includes(eol)) throw new RangeError("Line ending must be LF or CRLF.");
  const formatted = output.length ? output.join(eol) + eol : "";
  let unchanged = false;
  try { unchanged = meaning(parse(formatted, { readModule })) === meaning(program); } catch { /* Refuse unsafe edits. */ }
  if (!unchanged) throw new Error("Formatting would change this program's meaning; the source was left unchanged.");
  return formatted;
}
