import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "../src/transpile.js";

// Compiled markup imports "react", so the module must live where bare imports
// reach this repository's node_modules.
test("markup renders through real React with attributes and spreads", async () => {
  const folder = mkdtempSync(join(process.cwd(), ".prose-react-"));
  try {
    writeFileSync(join(folder, "package.json"), '{"type":"module"}');
    const source = [
      "export function Greeting takes props",
      '    return <div class_name="greeting" data-id={props.id}>',
      '        <span title={props.title}>Hello {props.name}</span>',
      "    </div>",
      "export function Panel takes props",
      "    return <section {like props.extra} hidden>{props.children}</section>"
    ].join("\n");
    const { code } = compile(source, { filename: join(folder, "component.prose") });
    const file = join(folder, "component.js");
    writeFileSync(file, code);

    const module = await import(pathToFileURL(file).href);
    assert.equal(renderToStaticMarkup(createElement(module.Greeting, {
      id: "x", title: "Hi", name: "Ada"
    })), '<div class="greeting" data-id="x"><span title="Hi">Hello Ada</span></div>');
    assert.equal(renderToStaticMarkup(createElement(module.Panel, {
      extra: { className: "panel", "aria-label": "side" }, children: "Body"
    })), '<section class="panel" aria-label="side" hidden="">Body</section>');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
