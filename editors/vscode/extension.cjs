const vscode = require("vscode");
const { createProvider } = require("./formatting.cjs");
const { createDiagnostics } = require("./checking.cjs");
const { createHovers } = require("./hovering.cjs");

exports.activate = context => {
  let formatter;
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    "prose", createProvider(vscode, async () => {
      formatter ??= Promise.all([import("./dist/formatter/format.js"), import("./dist/formatter/transpile.js")])
        .then(([{ format }, { sourceLines }]) => ({ format, sourceLines }));
      return formatter;
    })
  ));
  context.subscriptions.push(createDiagnostics(vscode));
  context.subscriptions.push(createHovers(vscode));
};
