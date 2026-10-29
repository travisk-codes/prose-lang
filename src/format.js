import { continues, parse, sourceLines } from "./transpile.js";

const unaryAfter = new Set([
  "is", "are", "print", "return", "with", "then", "else", "if", "while",
  "in", "to", "and", "or", "not", "otherwise", "mod", "xor", "by",
  "remainder", "fail", "giving", "as", "of"
]);
const symbol = (token, value) => token?.type === "symbol" && token.value === value;
const accessor = token => symbol(token, ".") || symbol(token, ":");
const word = (token, value) => token?.type === "word" && token.value === value;
const position = token => `${token?.source.line}:${token?.source.start}`;
const unaryMinus = (tokens, i) => symbol(tokens[i], "-") &&
  (!tokens[i - 1] || (tokens[i - 1].type === "symbol" && !symbol(tokens[i - 1], ")")) ||
    (tokens[i - 1].type === "word" && unaryAfter.has(tokens[i - 1].value) && !accessor(tokens[i - 2])));

function spaceBefore(tokens, i) {
  if (!i) return "";
  const previous = tokens[i - 1], token = tokens[i];
  // `matrix.1 .2` needs this space: joining it would lex 1.2 as one number.
  if (previous.type === "number" && symbol(token, ".") && tokens[i + 1]?.type === "number") return " ";
  if (accessor(previous) || accessor(token) || symbol(token, ",") || symbol(token, ")") || symbol(previous, "(")) return "";
  if (unaryMinus(tokens, i - 1) && !symbol(token, "-")) return "";
  return " ";
}

// Line locations affect diagnostics, but not the program being formatted. Documentation,
// call boundaries, parentheses, types, and all other syntax must survive unchanged.
const meaning = program => JSON.stringify(program, (key, value) => key === "line" ? undefined : value);

const text = tokens => tokens.map((token, i) => spaceBefore(tokens, i) + token.source.raw).join("");
const indentation = (depth, { tabWidth, insertSpaces }) => (insertSpaces ? " ".repeat(tabWidth) : "\t").repeat(depth);
const columns = (line, { tabWidth }) => line.replace(/\t/g, " ".repeat(tabWidth)).length;

// Argument locations distinguish an outer call's commas from those belonging to a
// nested call, even when the nested call doesn't need parentheses.
function argumentDepths(program, lines) {
  const previous = new Map();
  for (const { tokens } of lines) tokens.forEach((token, i) => previous.set(position(token), tokens[i - 1]));
  const depths = new Map();
  function visit(node, depth = 0) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(child => visit(child, depth)); return; }
    const args = node.args ?? node.elements;
    if (args) for (const arg of args.slice(1)) {
      const comma = arg.location && previous.get(position({ source: arg.location }));
      if (symbol(comma, ",")) depths.set(position(comma), depth);
    }
    for (const [key, child] of Object.entries(node)) {
      // An indented callback body contains new statements, not nested arguments
      // of the call that received the callback.
      const nextDepth = Array.isArray(child) && ["body", "otherwise", "handler"].includes(key) ? 0
        : depth + (key === "args" || key === "elements" ? 1 : 0);
      visit(child, nextDepth);
    }
  }
  visit(program);
  return depths;
}

function wrap(tokens, prefix, options, argumentDepth = new Map()) {
  const { width } = options;
  const continuation = prefix + indentation(1, options);
  const parts = tokens.map((token, i) => spaceBefore(tokens, i) + token.source.raw);
  const breaks = [];
  let depthInParentheses = 0;
  const lambdaHeaders = [];
  for (let i = 1; i < tokens.length; i++) {
    const previous = tokens[i - 1];
    if (symbol(previous, "(")) depthInParentheses++;
    if (symbol(previous, ")")) depthInParentheses--;
    if (word(previous, "function") && !accessor(tokens[i - 2])) lambdaHeaders.push(depthInParentheses);
    const lambdaReturn = word(previous, "return") && lambdaHeaders.at(-1) === depthInParentheses;
    if (lambdaReturn) lambdaHeaders.pop();
    // A minus at the edge of a physical line can change the parser's distinction
    // between subtraction and a negative call argument. Keep its operand with it.
    if (symbol(tokens[i - 1], "-") || symbol(tokens[i], "-") || symbol(tokens[i], ",") || symbol(tokens[i], ")") ||
        accessor(tokens[i]) || accessor(tokens[i - 1])) continue;
    if (depthInParentheses <= 0 && !continues(tokens.slice(Math.max(0, i - 2), i))) continue;
    let priority = 7;
    if (word(previous, "or") || word(previous, "otherwise")) priority = 0;
    else if (word(previous, "and")) priority = 1;
    else if (lambdaReturn) priority = 2;
    else if (symbol(previous, ",")) priority = lambdaHeaders.length ? 6 : 3 + 8 * (argumentDepth.get(position(previous)) ?? 0);
    else if (previous.type === "symbol" && !symbol(previous, "(")) priority = 4;
    else if (["mod", "xor", "by"].some(value => word(previous, value))) priority = 4;
    else if (continues(tokens.slice(Math.max(0, i - 2), i))) priority = 5;
    breaks.push({ point: i, priority: depthInParentheses * 8 + priority });
  }
  const points = [{ point: 0 }, ...breaks, { point: tokens.length }];
  const worst = Math.max(0, ...breaks.map(entry => entry.priority));
  const lengths = [0];
  parts.forEach(part => lengths.push(lengths.at(-1) + part.length));
  const best = new Array(points.length);
  best[points.length - 1] = { cost: new Array(worst + 2).fill(0) };
  const cheaper = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  // Compare whole layouts. First avoid overflow, then minimize the tightest
  // breaks used, working back to the loosest. A late comma must not displace an
  // earlier `or` or lambda `return` just because it fills the first line.
  for (let start = points.length - 2; start >= 0; start--) {
    const from = points[start].point;
    for (let end = points.length - 1; end > start; end--) {
      const to = points[end].point;
      const length = columns(from ? continuation : prefix, options) + lengths[to] - lengths[from] - (parts[from].length - parts[from].trimStart().length);
      // Only an indivisible piece may exceed the width (e.g. a string).
      if (length > width && end > start + 1) continue;
      const cost = best[end].cost.slice();
      cost[0] += Math.max(0, length - width);
      if (end < points.length - 1) cost[1 + worst - points[end].priority]++;
      if (!best[start] || cheaper(cost, best[start].cost)) best[start] = { cost, end };
    }
  }
  const output = [];
  for (let start = 0; start < points.length - 1;) {
    const end = best[start].end, from = points[start].point;
    output.push((from ? continuation : prefix) + parts.slice(from, points[end].point).join("").trimStart());
    start = end;
  }
  return output;
}

function wrapHeader(tokens, header, prefix, options) {
  if (columns(prefix + text(tokens), options) <= options.width) return [prefix + text(tokens)];
  const takes = tokens.findIndex(token => word(token, "takes"));
  // Without parameters there is no comma to carry a separate `giving` line.
  if (takes < 0) return wrap(tokens, prefix, options);
  let giving = -1;
  if (header.returns) {
    // Reuse the parser's type grammar to find the header's `giving`, rather than
    // confusing it with `giving` inside a parameter's function type.
    giving = tokens.findIndex((token, i) => {
      if (!word(token, "giving")) return false;
      const prefix = tokens.slice(0, symbol(tokens[i - 1], ",") ? i - 1 : i);
      try {
        const [candidate] = parse(text(prefix) + "\n    return unset");
        return !candidate.returns && meaning(candidate.params) === meaning(header.params) && meaning(candidate.types) === meaning(header.types);
      } catch { return false; }
    });
  }
  const output = [prefix + text(tokens.slice(0, takes + 1))];
  const end = giving < 0 ? tokens.length : giving;
  let start = takes + 1, parentheses = 0;
  for (let i = start; i <= end; i++) {
    if (symbol(tokens[i], "(")) parentheses++;
    if (symbol(tokens[i], ")")) parentheses--;
    if (i !== end && !(symbol(tokens[i], ",") && !parentheses)) continue;
    if (i > start) {
      // Without `giving`, a trailing comma would continue into the body.
      const comma = i < end || giving >= 0;
      output.push(prefix + indentation(1, options) + text(tokens.slice(start, i)) + (comma ? "," : ""));
    }
    start = i + 1;
  }
  if (giving >= 0) output.push(...wrap(tokens.slice(giving), prefix, options));
  return output;
}

function keepLines(line, physical, statementPrefix, options) {
  const groups = [];
  for (const token of line.tokens) {
    if (groups.at(-1)?.[0].source.line !== token.source.line) groups.push([]);
    groups.at(-1).push(token);
  }
  return groups.flatMap((tokens, i) => {
    const original = physical[tokens[0].source.line - 1];
    const prefix = i ? /^\s*/.exec(original)[0] : statementPrefix;
    const normalized = prefix + text(tokens);
    // Normalizing spacing or indentation must not push a fitting line over width.
    const kept = columns(normalized, options) <= options.width ? normalized : original.trimEnd();
    const blanks = i ? tokens[0].source.line - groups[i - 1].at(-1).source.line - 1 : 0;
    return [...new Array(blanks).fill(""), kept];
  });
}

function statementPrefixes(lines, physical, options) {
  const prefixes = new Map(), indents = [0];
  let block = [], keepIndentation = false;
  const finish = () => {
    if (keepIndentation) for (const line of block) prefixes.set(line, /^\s*/.exec(physical[line.line - 1])[0]);
    block = [];
    keepIndentation = false;
  };
  for (const line of lines) {
    if (!line.indent) finish();
    while (line.indent < indents.at(-1)) indents.pop();
    if (line.indent > indents.at(-1)) indents.push(line.indent);
    const prefix = indentation(indents.length - 1, options);
    prefixes.set(line, prefix);
    block.push(line);
    const original = physical[line.line - 1];
    const first = line.tokens.filter(token => token.source.line === line.line);
    // Keep a block's indentation coherent if expanding it would make a fitting
    // physical line overflow. Otherwise the next format would reflow that line.
    if (columns(original, options) <= options.width && columns(prefix + text(first), options) > options.width) keepIndentation = true;
    // The parser counts a tab as four spaces, independent of the editor's tab size.
    const parserWidth = { tabWidth: 4 }, parserIndent = columns(prefix, parserWidth);
    if (parserIndent !== line.indent && line.tokens.some(token => token.source.line !== line.line &&
      columns(/^\s*/.exec(physical[token.source.line - 1])[0], parserWidth) <= parserIndent)) keepIndentation = true;
  }
  finish();
  return prefixes;
}

/** Format valid Prose without changing its parsed meaning. Imports need readModule,
 * just as compile does. Strings, patterns, parentheses, and accessor choices are kept.
 */
export function format(source, options = {}) {
  const { width = 80, tabWidth = 4, insertSpaces = true, readModule } = options;
  if (!Number.isInteger(width) || width < 20) throw new RangeError("Format width must be an integer of at least 20.");
  if (!Number.isInteger(tabWidth) || tabWidth < 1 || tabWidth > 16) throw new RangeError("Tab width must be an integer from 1 to 16.");
  const program = parse(source, { readModule, sourceMap: true });
  const lines = sourceLines(source, { locations: true });
  const physical = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const settings = { width, tabWidth, insertSpaces };
  const argumentDepth = argumentDepths(program, lines);
  const headers = new Map(program.filter(node => node.type === "function").map(node => [node.line, node]));
  const prefixes = statementPrefixes(lines, physical, settings);
  const output = [];
  let previousEnd = 0;
  for (const line of lines) {
    if (output.length && line.line > previousEnd + 1) output.push("");
    const prefix = prefixes.get(line);
    const fits = line.tokens.every(token => columns(physical[token.source.line - 1], settings) <= width);
    output.push(...(fits ? keepLines(line, physical, prefix, settings) : headers.has(line.line)
      ? wrapHeader(line.tokens, headers.get(line.line), prefix, settings)
      : wrap(line.tokens, prefix, settings, argumentDepth)));
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
