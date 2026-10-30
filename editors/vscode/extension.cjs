const vscode = require("vscode");
const { createProvider } = require("./formatting.cjs");
const { createDiagnostics } = require("./checking.cjs");
const { createLanguageFeatures } = require("./hovering.cjs");
const { createCompletions } = require("./completing.cjs");
const { createSignatureHelp } = require("./signatures.cjs");
const { createRefactoring } = require("./refactoring.cjs");

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
  context.subscriptions.push(createLanguageFeatures(vscode));
  context.subscriptions.push(createCompletions(vscode));
  context.subscriptions.push(createSignatureHelp(vscode));
  context.subscriptions.push(createRefactoring(vscode));
};
