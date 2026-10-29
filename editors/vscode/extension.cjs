const vscode = require("vscode");
const { createProvider } = require("./formatting.cjs");

exports.activate = context => {
  let formatter;
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    "prose", createProvider(vscode, async () => {
      formatter ??= Promise.all([import("./dist/formatter/format.js"), import("./dist/formatter/transpile.js")])
        .then(([{ format }, { sourceLines }]) => ({ format, sourceLines }));
      return formatter;
    })
  ));
};
