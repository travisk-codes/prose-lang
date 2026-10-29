// The extension ships the same formatter and parser as the CLI, with no runtime
// dependencies. This also runs before vsce packages or launches the extension.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

const output = new URL("./dist/formatter/", import.meta.url);
mkdirSync(output, { recursive: true });
for (const name of ["format.js", "transpile.js", "runtime.js"]) {
  copyFileSync(new URL(`../../src/${name}`, import.meta.url), new URL(name, output));
}
writeFileSync(new URL("package.json", output), '{"type":"module"}\n');
