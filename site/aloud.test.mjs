import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aloud, aloudHtml, symbolCount, wordCount } from "./aloud.mjs";

const sample = name => readFileSync(new URL(name, import.meta.url), "utf8");

test("every symbol is said by name, and a name's separators aren't symbols", () => {
  assert.deepEqual(aloud("chart_key(item) !== chartKey"), [
    { text: "chart key", symbol: false },
    { text: "open paren", symbol: true },
    { text: "item", symbol: false },
    { text: "close paren", symbol: true },
    { text: "not double equals", symbol: true },
    { text: "chart key", symbol: false }
  ]);
});

test("a symbol without a spoken name stops the build", () => {
  assert.throws(() => aloud("a + b"), /No spoken name for \+/);
});

test("the page's comparison counts what the samples actually contain", () => {
  const prose = sample("without.prose");
  const typescript = sample("without.ts");
  assert.equal(symbolCount(prose), 3);
  assert.equal(symbolCount(typescript), 20);
  assert.equal(wordCount(prose), 22);
  assert.equal(wordCount(typescript), 51);
});

test("symbols are marked so the page can set them apart", () => {
  assert.equal(aloudHtml("a != b"), "a <b>not equals</b> b");
});
