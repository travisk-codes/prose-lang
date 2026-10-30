// Markup is read separately from Prose tokens: child text is literal, while
// expressions in braces are handed back to the ordinary expression parser.
export function markupPosition(source, offset) {
  const prefix = source.slice(0, offset), last = prefix.lastIndexOf('\n');
  return { line: prefix.split('\n').length, start: offset - last - 1 };
}

const namedEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function entities(text, fail) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (written, name) => {
    if (name[0] !== '#') {
      if (Object.hasOwn(namedEntities, name)) return namedEntities[name];
      fail(`Unknown markup entity '${written}'. Use the character itself or a numeric entity.`);
    }
    const point = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!point || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) fail(`Invalid Unicode entity '${written}'.`);
    return String.fromCodePoint(point);
  });
}

export function markupText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let last = lines.length - 1;
  while (last >= 0 && !/[^\t ]/.test(lines[last])) last--;
  return lines.map((line, index) => {
    line = line.replace(/\t/g, ' ');
    if (index) line = line.replace(/^ +/, '');
    if (index < lines.length - 1) line = line.replace(/ +$/, '');
    return line && index < last ? line + ' ' : line;
  }).join('');
}

export function readMarkup(source, start) {
  let at = start;
  const fail = (message, offset = at) => {
    const position = markupPosition(source, offset);
    const error = new SyntaxError(`Line ${position.line}: ${message}`);
    Object.assign(error, { line: position.line, column: position.start + 1 }); throw error;
  };
  const space = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++; };
  function name(kind) {
    const found = /^[A-Za-z_][A-Za-z_0-9.-]*/.exec(source.slice(at));
    if (!found) fail(`Expected a ${kind} name.`);
    const node = { name: found[0], start: at }; at += found[0].length; return node;
  }
  function expression() {
    const open = at++, begin = at;
    let depth = 1;
    while (at < source.length) {
      if (source[at] === '"') {
        at++;
        while (at < source.length) {
          if (source[at] === '\\') at += 2;
          else if (source[at++] === '"') break;
        }
      } else if (source[at] === '<' && /[A-Za-z_>]/.test(source[at + 1] ?? '')) {
        try { const child = readMarkup(source, at); at = child.end; }
        catch { at++; } // The expression parser distinguishes comparisons.
      } else if (source[at] === '{') { depth++; at++; }
      else if (source[at] === '}') {
        if (!--depth) { const end = at++; return { kind: 'expression', start: begin, end }; }
        at++;
      } else at++;
    }
    fail("Unclosed markup expression. Expected '}'.", open);
  }
  function element() {
    const begin = at++;
    const tag = source[at] === '>' ? { name: '', start: at } : name('tag');
    if (tag.name && !/^[a-z][\w-]*$|^[A-Z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(tag.name)) fail(`Invalid tag name '${tag.name}'.`, tag.start);
    const attributes = [], seen = new Set();
    while (at < source.length) {
      const before = at; space();
      if (source.startsWith('/>', at)) { at += 2; return { kind: 'element', tag, attributes, children: [], start: begin, end: at }; }
      if (source[at] === '>') { at++; break; }
      if (!tag.name) fail("A fragment opens with '<>' and cannot have attributes.");
      if (at === before) fail('Put a space between markup attributes.');
      const attribute = name('attribute');
      if (attribute.name.includes('.')) fail('Attribute names cannot contain periods.', attribute.start);
      if (seen.has(attribute.name)) fail(`Duplicate attribute '${attribute.name}'.`, attribute.start);
      seen.add(attribute.name); space();
      const afterName = attribute.start + attribute.name.length;
      let value = { kind: 'literal', value: true, start: attribute.start };
      if (source[at] === '=') {
        at++; space();
        if (source[at] === '{') value = expression();
        else if (source[at] === '"' || source[at] === "'") {
          const quote = source[at++], open = at;
          while (at < source.length && source[at] !== quote) at++;
          if (at === source.length) fail('Unclosed markup attribute string.', open - 1);
          value = { kind: 'literal', value: entities(source.slice(open, at).replace(/\r\n?/g, '\n').replace(/\n\s+/g, ' '), message => fail(message, open)), start: open - 1 };
          at++;
        } else fail('Attribute values need quotes or a Prose expression in braces.');
      } else at = afterName;
      attributes.push({ ...attribute, value });
    }
    const children = [];
    while (at < source.length) {
      if (source.startsWith('</', at)) {
        at += 2; const closingTag = source[at] === '>' ? { name: '', start: at } : name('closing tag'), closing = closingTag.name;
        space(); if (source[at++] !== '>') fail("Expected '>' after the closing tag.");
        if (closing !== tag.name) fail(`Expected </${tag.name}>, found </${closing}>.`, at - closing.length - 3);
        return { kind: 'element', tag, closingTag, attributes, children, start: begin, end: at };
      }
      if (source[at] === '<') children.push(element());
      else if (source[at] === '{') children.push(expression());
      else {
        const begin = at;
        while (at < source.length && !['<', '{'].includes(source[at])) {
          if (source[at] === '}') fail("Literal '}' in markup must be written as &#125; or a string expression.");
          at++;
        }
        const value = entities(markupText(source.slice(begin, at)), message => fail(message, begin));
        if (value) children.push({ kind: 'literal', value, start: begin });
      }
    }
    fail(`Unclosed <${tag.name}>. Expected </${tag.name}>.`, begin);
  }
  return element();
}
