import test from "node:test";
import assert from "node:assert/strict";
import { Script, runInNewContext } from "node:vm";
import { syntaxSource, highlightCode } from "./syntax.mjs";
import { inlineScript } from "./scripts.mjs";

test("JavaScript samples highlight comments, keywords, and template expressions", () => {
  const html = highlightCode('// A reading list\nconst label = `Book ${pages + 1}`;');
  for (const token of ["comment", "keyword", "template-string", "interpolation", "number"]) {
    assert.match(html, new RegExp(`class="token ${token}(?: |")`));
  }
});

test("syntax highlighting escapes user text instead of creating HTML elements", () => {
  const source = 'const html = "</script><img src=x onerror=alert(1)>&";';
  const html = highlightCode(source);
  assert.doesNotMatch(html, /<\/?(?:script|img)\b/i);
  const text = html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  assert.equal(text, source);
});

test("the embedded browser bundle matches build highlighting, including TypeScript", () => {
  const script = inlineScript(syntaxSource);
  assert.doesNotThrow(() => new Script(script));
  const Prism = runInNewContext(script + "\nPrism;");
  for (const [source, language] of [
    ['const re = /<\\/script>/g;\nconsole.log(`${re.test("</script>")}`);', "javascript"],
    ["export type Book = { title: string; pages: number };", "typescript"]
  ]) {
    assert.equal(Prism.highlight(source, Prism.languages[language], language), highlightCode(source, language));
  }
});
