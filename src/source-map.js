// Source Map v3 (ECMA-426). Columns count UTF-16 code units.
const base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value) {
  let bits = value < 0 ? -value * 2 + 1 : value * 2;
  let result = "";
  do {
    let digit = bits % 32;
    bits = Math.floor(bits / 32);
    if (bits) digit += 32;
    result += base64Digits[digit];
  } while (bits);
  return result;
}

/** Carries nested source ranges through the emitter's string templates. All
 * private markers are removed before JavaScript leaves the compiler.
 */
export function sourceMapBuilder(source, filename) {
  let prefix = "\0prose-map:";
  while (source.includes(prefix)) prefix = "\0" + prefix;
  const locations = [];
  return {
    mark(location, code, name) {
      if (!code) return code;
      const id = locations.push(location ? { ...location, name } : null) - 1;
      return `${prefix}${id};${code}${prefix}-;`;
    },
    finish(marked) {
      const pieces = [], lines = [[]], stack = [], names = [], nameIndexes = new Map();
      let column = 0, previousOriginalLine = 0, previousOriginalColumn = 0, previousName = 0;
      const point = () => {
        const row = lines.at(-1);
        const segment = { column, location: stack.at(-1) ?? null };
        if (row.at(-1)?.column === column) row[row.length - 1] = segment;
        else row.push(segment);
      };
      for (let pos = 0; pos < marked.length;) {
        if (marked.startsWith(prefix, pos)) {
          const end = marked.indexOf(";", pos + prefix.length);
          const id = marked.slice(pos + prefix.length, end);
          if (id === "-") stack.pop();
          else stack.push(locations[Number(id)]);
          point();
          pos = end + 1;
        } else {
          const char = marked[pos++];
          pieces.push(char);
          if (char === "\r" || char === "\u2028" || char === "\u2029" || (char === "\n" && marked[pos - 2] !== "\r")) {
            lines.push([]); column = 0;
            if (stack.at(-1)) point();
          } else if (char !== "\n") column++;
        }
      }
      const mappings = lines.map(row => {
        let previousColumn = 0;
        return row.map(({ column, location }) => {
          let segment = vlq(column - previousColumn);
          previousColumn = column;
          if (location) {
            segment += vlq(0) + vlq(location.line - 1 - previousOriginalLine) + vlq(location.start - previousOriginalColumn);
            previousOriginalLine = location.line - 1;
            previousOriginalColumn = location.start;
            if (location.name) {
              if (!nameIndexes.has(location.name)) { nameIndexes.set(location.name, names.length); names.push(location.name); }
              const index = nameIndexes.get(location.name);
              segment += vlq(index - previousName);
              previousName = index;
            }
          }
          return segment;
        }).join(",");
      }).join(";");
      return { code: pieces.join(""), map: { version: 3, sources: [filename], sourcesContent: [source], names, mappings } };
    }
  };
}

/** Inline maps work in Node and browser tools without a separate .map file. */
export function inlineSourceMap(map, lineOffset = 0) {
  const payload = lineOffset ? { ...map, mappings: ";".repeat(lineOffset) + map.mappings } : map;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    encoded += base64Digits[a >> 2] + base64Digits[((a & 3) << 4) | ((b ?? 0) >> 4)] +
      (b === undefined ? "=" : base64Digits[((b & 15) << 2) | ((c ?? 0) >> 6)]) +
      (c === undefined ? "=" : base64Digits[c & 63]);
  }
  return "//# sourceMappingURL=data:application/json;charset=utf-8;base64," + encoded;
}

function readVlq(segment, state) {
  let value = 0, factor = 1, digit;
  do {
    digit = base64Digits.indexOf(segment[state.pos++]);
    if (digit < 0) throw new Error("Invalid source map segment.");
    value += (digit & 31) * factor;
    factor *= 32;
  } while (digit & 32);
  return value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2);
}

/** Generated positions are zero based; returned original positions are one based.
 * Empty lines and unmapped scaffolding never inherit a previous statement.
 */
export function sourceMapLookup(map) {
  let source = 0, line = 0, column = 0, name = 0;
  const rows = map.mappings.split(";").map(row => {
    let generated = 0;
    return row ? row.split(",").map(segment => {
      const state = { pos: 0 };
      generated += readVlq(segment, state);
      if (state.pos === segment.length) return { generated, original: null };
      source += readVlq(segment, state);
      line += readVlq(segment, state);
      column += readVlq(segment, state);
      const original = { source: map.sources[source], line: line + 1, column: column + 1 };
      if (state.pos < segment.length) { name += readVlq(segment, state); original.name = map.names[name]; }
      return { generated, original };
    }) : [];
  });
  return (line, column) => {
    const row = rows[line] ?? [];
    let low = 0, high = row.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (row[middle].generated <= column) low = middle + 1;
      else high = middle;
    }
    return row[low - 1]?.original ?? null;
  };
}

/** Map V8 and Firefox frame locations. new Function adds two wrapper lines;
 * execution directly from a file needs no lineOffset.
 */
export function mapStackTrace(stack, map, { generatedFile, lineOffset = 0 } = {}) {
  const lookup = sourceMapLookup(map);
  const escaped = generatedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped + ":(\\d+):(\\d+)", "g");
  let location = null;
  const text = String(stack).replace(pattern, (match, line, column) => {
    const original = lookup(Number(line) - lineOffset - 1, Number(column) - 1);
    if (!original) return match;
    location ??= original;
    return `${original.source}:${original.line}:${original.column}`;
  });
  return { stack: text, location };
}
