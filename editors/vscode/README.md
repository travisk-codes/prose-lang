# Prose Language for Visual Studio Code

Syntax highlighting for `.prose` files. Colors come from your existing VS Code theme.

Highlights keywords, function declarations and parameters, standard-library
calls, booleans, numbers, strings, escapes, operators, dot indexing, object literals, arrays, and colon property access.
A quoted string alone on a line receives comment coloring. Other strings
receive normal string coloring. Unterminated strings stop at the end of the
line, matching the compiler's single-line strings.

The grammar distinguishes function declarations and standard-library calls.
User-defined calls currently receive identifier coloring; resolving those
symbols across a document is a future semantic-highlighting feature.

This is a declarative extension with no executable extension code.
Async and await are colored for the MusicTicker design sketch; the compiler
does not implement those features yet.

## Install

In VS Code, run **Extensions: Install from VSIX...** and choose
`dist/prose-language-0.1.2.vsix` from the repository. Open a `.prose` file.
Its language mode should be **Prose**.

Or use the CLI:

```powershell
code.cmd --install-extension dist/prose-language-0.1.2.vsix --force
```

Reload the VS Code window if a previously open file retains its old coloring.

## Develop and test

Run `npm.cmd install` and `npm.cmd test` from the repository root. Grammar tests
run through VS Code's TextMate and Oniguruma tokenizer libraries.

To preview changes in a separate VS Code extension development window:

```powershell
code.cmd --extensionDevelopmentPath=D:\prose-lang\editors\vscode D:\prose-lang
```

Use **Developer: Inspect Editor Tokens and Scopes** to inspect token scopes.

To package the extension using Microsoft's standard packaging tool:

Install Microsoft's optional [vsce packaging tool](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
then run the following from `editors/vscode` after creating the root `dist` folder:

```powershell
vsce.cmd package --no-dependencies --out ../../dist/prose-language-0.1.2.vsix
```

Packaging creates a local VSIX; it does not publish to the Marketplace.
