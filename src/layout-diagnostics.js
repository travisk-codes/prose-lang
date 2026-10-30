const word = (token, value) => token?.type === "word" && token.value === value;

// Add guidance only after parsing has failed. Examples illustrate supported
// layouts; they are never applied as edits or used to reinterpret the source.
export function explainLayoutError(error, source, readLines, continues) {
  if (error?.name !== "SyntaxError" || !error.line || error.layout?.explained) return error;
  const message = error.message.replace(/^Line \d+:\s*/, "");
  if (!error.layout && !/^(Unexpected indentation|Expected an indented body|Expected 'else'|Expected '\)'|Expected 'is'|Expected a type|Expected an expression|Expected a variable name|Unexpected token|Expected assignment)/.test(message)) return error;
  let lines;
  try { lines = readLines(); } catch { return error; }
  const physical = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = line => line.tokens.at(-1)?.source?.line ?? line.line;
  const current = lines.find(line => line.line <= error.line && end(line) >= error.line);
  const previous = [...lines].reverse().find(line => end(line) < error.line);
  const tokenAt = number => lines.flatMap(line => line.tokens).find(token => token.source?.line === number);
  const column = number => tokenAt(number)?.source.start + 1 || Math.max(1, (physical[number - 1]?.search(/\S/) ?? 0) + 1);
  const finish = (kind, start, explanation, example, others = []) => {
    const startLine = start?.line ?? error.line;
    const startColumn = start?.column ?? column(startLine);
    error.column ??= column(error.line);
    error.layout = { kind, explained: true, startLine, startColumn, example };
    error.relatedInformation = [{ line: startLine, column: startColumn, message: explanation }, ...others];
    error.message += " " + explanation + "\n\nExample layout:\n" + example;
    return error;
  };
  const valueExample = 'label is "yes"\n    if true\n    else "no"';
  const conditionExample = 'if true\nor false\n    print "chosen"';
  const sumExample = 'total is 1 +\n    2';
  const headerExample = 'function combine takes\n    first as number,\n    second as number,\ngiving number\n    return first + second';
  const kind = error.layout?.kind;
  const start = lines.find(line => line.line === error.layout?.start) ?? current;
  const afterStart = start && lines.find(line => line.line > end(start));
  if (kind === "body" && start.tokens.some(token => word(token, "function")) && word(afterStart?.tokens[0], "giving")) {
    return finish("function-header", start,
      `The giving clause on line ${afterStart.line} belongs to the function header on line ${start.line}. Keep it on that header, or keep a wrapped takes list open with parameter commas before an aligned giving clause.`, headerExample,
      [{ line: afterStart.line, column: column(afterStart.line), message: "This giving clause is outside the completed function header." }]);
  }
  if (kind === "body") {
    return finish(kind, start, `The block starts on line ${start.line}. Put its body farther to the right than the header, after any wrapped condition or header lines.`,
      start.tokens.some(token => word(token, "function")) ? 'function greet\n    return "hello"' : conditionExample);
  }
  if (kind === "leading-condition") return finish(kind, start,
    `The header on line ${start.line} already includes a body or starts an indented function value. Leading and/or must stay within the condition, before any body starts.`, conditionExample);
  if (kind === "conditional-value") return finish(kind, start,
    `Line ${start.line} must finish a value before an indented if can continue it. A function or object header needs its own body first.`, valueExample);
  if (kind === "object" || kind === "type") {
    return finish(kind, start, `The ${kind === "type" ? "type" : "object"} starts on line ${start.line}. Fields at the same level must align; indentation alone does not create a nested object.`,
      kind === "type" ? 'type Point is object\n    x as number\n    y as number' : 'point is object\n    x is 1\n    y is 2');
  }
  const first = current?.tokens.find(token => token.source.line === error.line);
  if (/^Expected 'is'/.test(message) && previous && end(previous) > previous.line && word(current?.tokens[1], "as") &&
      previous.tokens.some(token => word(token, "function")) && previous.tokens.some(token => word(token, "takes"))) {
    return finish("function-header", previous,
      `The function header on line ${previous.line} ended on line ${end(previous)}. If this line is another parameter, add a comma after the preceding parameter line. A typed local declaration in the body instead needs is and a value.`, headerExample,
      [{ line: end(previous), column: column(end(previous)), message: "Without a trailing comma, this parameter line closes the header." }]);
  }
  // A dangling giving line usually follows a parameter line that closed the
  // header. Keyword-shaped properties and function types are excluded.
  if (word(first, "giving") && !["is", "as"].some(value => word(current.tokens[1], value))) {
    const header = [...lines].reverse().find(line => line.line < error.line && line.tokens.some((token, index) =>
      word(token, "function") && ![".", ":", "as"].includes(line.tokens[index - 1]?.value) && !["is", "as", "taking"].includes(line.tokens[index + 1]?.value)));
    if (header) return finish("function-header", header,
      `The function header on line ${header.line} ended before this giving clause. Keep giving on the header, or keep a wrapped takes list open with a comma after each parameter and align giving with the header.`, headerExample);
  }
  if (current) {
    const open = [];
    for (const token of current.tokens) {
      if (token.type === "symbol" && token.value === "(") open.push(token);
      else if (token.type === "symbol" && token.value === ")") open.pop();
    }
    if (open.length && /^(Expected '\)'|Expected an expression)/.test(message)) {
      const opening = open.at(-1).source.line;
      return finish("parentheses", { line: opening, column: open.at(-1).source.start + 1 },
        `The parenthesis opened on line ${opening} is still open. Every continuation line, including a separate closing parenthesis, must be indented farther than the statement on line ${current.line}.`,
        'total is (\n    1 + 2\n    )');
    }
    const next = lines.find(line => line.line > end(current));
    if (next && continues(current.tokens) && next.indent <= current.indent && /^(Expected an expression|Expected a type|Expected a variable name)/.test(message)) {
      return finish("continuation-indent", current,
        `Line ${end(current)} leaves this statement unfinished. Indent line ${next.line} farther than the statement on line ${current.line} to continue it.`, sumExample,
        [{ line: next.line, column: column(next.line), message: "This line is not indented enough to continue the unfinished statement." }]);
    }
    if (/^Expected 'else'/.test(message) && current.tokens.some(token => word(token, "if"))) {
      const misplaced = next && word(next.tokens[0], "else") ? next : undefined;
      return finish("conditional-else", current,
        `The conditional value starting on line ${current.line} needs else and a value. On separate lines, indent both if and else farther than that value's statement; align else with the indented if.`, valueExample,
        misplaced ? [{ line: misplaced.line, column: column(misplaced.line), message: "This else is aligned as a block clause, so it cannot finish the indented conditional value." }] : []);
    }
    if (/^Expected an expression/.test(message) && word(current.tokens.at(-1), "else") && current.tokens.some(token => word(token, "if"))) {
      const clause = current.tokens.at(-1).source;
      return finish("conditional-else-value", { line: clause.line, column: clause.start + 1 },
        `The else on line ${clause.line} still needs a value. Put the fallback value after else to finish this conditional expression.`, valueExample);
    }
    const functionToken = current.tokens.findIndex(token => word(token, "function"));
    const bodyToken = current.tokens.find(token => token.source.line > current.line && ["return", "print", "if", "for", "while"].some(value => word(token, value)));
    if (functionToken >= 0 && bodyToken && /^Expected a variable name/.test(message)) return finish("header-comma", current,
      `A trailing comma keeps the parameter list open, so line ${bodyToken.source.line} is being read as another parameter. Omit the final parameter's comma when the body follows directly; keep it when a giving clause follows.`,
      'function combine takes\n    first,\n    second\n    return first + second');
  }
  if (first && ["and", "or"].some(value => word(first, value)) && previous) return finish("leading-value", previous,
    `Leading ${first.value} can continue an if, else if, or while condition. To wrap a value from line ${previous.line}, put ${first.value} at the end of that line and indent what follows.`,
    `ready is true ${first.value}\n    false`);
  if (kind === "indent" || /^Unexpected indentation/.test(message)) {
    const detail = previous ? `Line ${end(previous)} is already a complete statement.` : "This line does not follow a block header.";
    return finish("indent", previous ?? current, `${detail} Align a new statement with its block. To continue an expression, leave a comma, operator, or open parenthesis on the preceding line; extra indentation alone does not continue it.`, sumExample);
  }
  // A leading arithmetic operator cannot wrap a completed expression, even
  // when the line happens to align with the enclosing block.
  if (previous && first?.type === "symbol" && ["+", "-", "*", "/", "%", ","].includes(first.value)) return finish("leading-operator", previous,
    `Line ${end(previous)} already completed its statement. For a continued expression, put the operator or comma at the end of the preceding line and indent the next line.`, sumExample);
  return error;
}
