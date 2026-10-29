import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, runInNewContext } from "node:vm";
import { inlineScript } from "./scripts.mjs";

test("the actual playground script remains valid when embedded in HTML", () => {
  const source = readFileSync(new URL("playground.js", import.meta.url), "utf8");
  assert.doesNotThrow(() => new Script(inlineScript(source)));
});

test("HTML escaping does not corrupt JavaScript comparison regex delimiters", () => {
  const source = '"<a>".replace(/</g, "&lt;").replace(/>/g, "&gt;")';
  assert.equal(runInNewContext(inlineScript(source)), "&lt;a&gt;");
});

test("script closing tags cannot end the HTML script and preserve string case", () => {
  const source = '"</ScRiPt><p>still a string</p>"';
  const escaped = inlineScript(source);
  assert.doesNotMatch(escaped, /<\/script/i);
  assert.equal(runInNewContext(escaped), "</ScRiPt><p>still a string</p>");
});
