// Reads code out loud, the way you'd dictate it: every word, and every symbol by
// name. The landing page reads both of its samples with this one rule, so neither
// language gets a kinder reading, and the counts on the page can't drift from the code.
const names = {
  "!==": "not double equals", "!=": "not equals", "=>": "arrow", "=": "equals",
  "(": "open paren", ")": "close paren", "[": "open bracket", "]": "close bracket",
  ",": "comma", ":": "colon", ".": "dot"
};

// chart_key and chartKey are said the same way, so a name's own separators aren't symbols.
const spoken = name => name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

export function aloud(source) {
  return source.match(/[A-Za-z_]\w*|!==|!=|=>|\S/g).map(token => {
    if (/^[A-Za-z_]/.test(token)) return { text: spoken(token), symbol: false };
    if (!names[token]) throw new Error(`No spoken name for ${token}`);
    return { text: names[token], symbol: true };
  });
}

export const symbolCount = source => aloud(source).filter(part => part.symbol).length;

export const wordCount = source =>
  aloud(source).flatMap(part => part.text.split(" ")).length;

export const aloudHtml = source => aloud(source)
  .map(({ text, symbol }) => symbol ? `<b>${text}</b>` : text)
  .join(" ");
