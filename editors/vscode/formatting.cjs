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
        const modules = new Map([[document.uri.toString(), source]]), failures = new Map(), buffers = [];
        // Read imported Prose signatures as text; formatting never executes imports.
        async function dependencies(text, parent) {
          let lines;
          try { lines = sourceLines(text); } catch { return; } // The formatter reports syntax errors itself.
          for (const { tokens, indent } of lines) {
            if (cancellation.isCancellationRequested) return;
            const typeOnly = tokens[1]?.value === "type" && tokens[2]?.type === "word" && tokens[2]?.value !== "from";
            if (indent || tokens[0]?.value !== "use" || typeOnly) continue;
            const specifier = tokens.at(-1)?.value;
            if (typeof specifier !== "string" || !specifier.endsWith(".prose")) continue;
            const uri = vscode.Uri.joinPath(parent, "..", specifier), key = uri.toString();
            if (modules.has(key) || failures.has(key)) continue;
            try {
              const open = vscode.workspace.textDocuments.find(other => other.uri.toString() === key);
              const child = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
              if (open) buffers.push({ document: open, version: open.version });
              modules.set(key, child);
              await dependencies(child, uri);
            } catch (error) { failures.set(key, error); }
          }
        }
        await dependencies(source, document.uri);
        const stale = () => document.version !== version || buffers.some(buffer => buffer.document.version !== buffer.version);
        if (cancellation.isCancellationRequested || stale()) return [];
        const width = vscode.workspace.getConfiguration("prose", document.uri).get("format.width", 80);
        const formatted = format(source, {
          width, tabWidth: options.tabSize, insertSpaces: options.insertSpaces,
          endOfLine: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
          readModule: path => {
            const key = vscode.Uri.joinPath(document.uri, "..", path).toString();
            if (failures.has(key)) throw failures.get(key);
            if (!modules.has(key)) throw new Error(`Can't read ${path}.`);
            return modules.get(key);
          }
        });
        if (cancellation.isCancellationRequested || stale()) return [];
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
