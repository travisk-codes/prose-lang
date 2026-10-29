// Escape only actual HTML script-closing tags. Escaping every </ also changes
// JavaScript regex delimiters such as /</g, which breaks the editor on startup.
export function inlineScript(source) {
  return source.replace(/<\/script/gi, closing => "<\\/" + closing.slice(2));
}
