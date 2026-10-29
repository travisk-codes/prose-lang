// One replacement for the changed region preserves markers outside it and avoids
// replacing the whole document when only indentation or a line break has changed.
function changedRange(before, after) {
  if (before === after) return null;
  let start = 0, end = before.length, replacementEnd = after.length;
  while (start < end && start < replacementEnd && before[start] === after[start]) start++;
  while (end > start && replacementEnd > start && before[end - 1] === after[replacementEnd - 1]) {
    end--; replacementEnd--;
  }
  // Do not put an edit boundary between a CR and LF or a Unicode surrogate pair.
  const splitsPair = (text, at) => at > 0 && at < text.length &&
    ((text[at - 1] === "\r" && text[at] === "\n") ||
      (/[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at])));
  if (splitsPair(before, start) || splitsPair(after, start)) start--;
  if (splitsPair(before, end) || splitsPair(after, replacementEnd)) { end++; replacementEnd++; }
  return { start, end, text: after.slice(start, replacementEnd) };
}

function createProvider(vscode, loadFormatter) {
  return {
    async provideDocumentFormattingEdits(document, options, cancellation) {
      const version = document.version;
      const source = document.getText();
      try {
        const { format, sourceLines } = await loadFormatter();
        const modules = new Map();
        // Read imported Prose signatures as text; formatting never executes imports.
        for (const { tokens } of sourceLines(source)) {
          const typeOnly = tokens[1]?.value === "type" && tokens[2]?.type === "word" && tokens[2]?.value !== "from";
          if (tokens[0]?.value !== "use" || typeOnly) continue;
          const specifier = tokens.at(-1)?.value;
          if (typeof specifier !== "string" || !specifier.endsWith(".prose") || modules.has(specifier)) continue;
          const uri = vscode.Uri.joinPath(document.uri, "..", specifier);
          const open = vscode.workspace.textDocuments.find(other => other.uri.toString() === uri.toString());
          modules.set(specifier, open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
        }
        if (cancellation.isCancellationRequested || document.version !== version) return [];
        const width = vscode.workspace.getConfiguration("prose", document.uri).get("format.width", 80);
        const formatted = format(source, {
          width, tabWidth: options.tabSize, insertSpaces: options.insertSpaces,
          endOfLine: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
          readModule: path => {
            if (!modules.has(path)) throw new Error(`Can't read ${path}.`);
            return modules.get(path);
          }
        });
        if (cancellation.isCancellationRequested || document.version !== version) return [];
        const change = changedRange(source, formatted);
        return change ? [vscode.TextEdit.replace(
          new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text
        )] : [];
      } catch (error) {
        if (!cancellation.isCancellationRequested && document.version === version) {
          void vscode.window.showErrorMessage(`Prose couldn't format this file: ${error.message}`);
        }
        return [];
      }
    }
  };
}

module.exports = { changedRange, createProvider };
