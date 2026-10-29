import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The same grammars color static samples during the build and live compiled
// output in the browser. Keep automatic DOM highlighting disabled.
const license = readFileSync(new URL("vendor/prism/LICENSE", import.meta.url), "utf8");
export const syntaxSource = `/* Prism 1.30.0\n${license}\n*/\nvar Prism = { manual: true, disableWorkerMessageHandler: true };\n` +
  ["core", "clike", "javascript", "typescript"].map(name =>
    readFileSync(new URL(`vendor/prism/components/prism-${name}.min.js`, import.meta.url), "utf8")
  ).join("\n");

const Prism = runInNewContext(syntaxSource + "\nPrism;");

export function highlightCode(source, language = "javascript") {
  return Prism.highlight(source, Prism.languages[language], language);
}
