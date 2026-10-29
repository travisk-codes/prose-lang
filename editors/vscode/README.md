# Prose Language for Visual Studio Code

Syntax highlighting and formatting for `.prose` files, with a softened rainbow
palette for dark backgrounds matching the Prose website.

Highlights keywords, function declarations and parameters, standard-library
calls, booleans, numbers, strings, escapes, operators, dot indexing, object literals, arrays, and colon property access.
A quoted string alone on a line receives comment coloring. Other strings
receive normal string coloring. Unterminated strings stop at the end of the
line, matching the compiler's single-line strings.

The grammar distinguishes function declarations and standard-library calls.
User-defined calls currently receive identifier coloring; resolving those
symbols across a document is a future semantic-highlighting feature.

The extension includes the Prose formatter and parser. Formatting reads source
text and imported signatures; it never executes the program or its imports.

## Formatting

Use **Format Document** (`Shift+Alt+F` on Windows). Prose Language is the default
formatter for Prose files unless your settings choose another provider.
The editor's tab size and spaces/tabs preference control indentation.
Set `prose.format.width` to change the preferred width (default 80, minimum 20).
You can enable format-on-save through VS Code's usual editor settings.

The formatter preserves parentheses, strings, patterns, accessors, documentation,
and program structure. It wraps only where Prose allows a continuation and
checks the parsed result before returning an edit. A long string or expression
with no safe break may exceed the width. Invalid syntax leaves the document
unchanged and reports an error. The editor formatter and CLI share their code.

## Prose colors

The extension supplies Prose-only token colors through VS Code configuration
defaults. It leaves the workbench theme and other languages alone. Existing
user token-color settings take precedence.

Each kind of word gets its own softened hue, in rainbow order:

- Red control flow (`if`, `for each`, `return`).
- Orange numbers and amber `true`, `false`, `null`, and `unset`.
- Yellow `function` and function names (bold), and yellow string escapes.
- Lime parameters (italic) and loop variables.
- Green strings with emerald quotes.
- Mauve regular expression patterns.
- Teal object properties and accessors, and cyan standard-library calls.
- Blue bindings (names being assigned) and pale blue variables.
- Indigo `object` and `array`, and purple language words (`is`, `with`, `takes`).
- Pink operators, and rose types and capitalized names such as `Map` and `Math`.

Comments stay a muted italic gray so code stands out. Parentheses take VS
Code's own bracket pair colors when bracket pair colorization is on, which is
the default.
Dots and underscores stay dim so the words stand out.

Change individual colors using `editor.tokenColorCustomizations` in VS Code
settings. All palette selectors are scoped to `source.prose`.

## Install

In VS Code, run **Extensions: Install from VSIX...** and choose
`dist/prose-language-0.1.7.vsix` from the repository. Open a `.prose` file.
Its language mode should be **Prose**.

Or use the CLI:

```powershell
code.cmd --install-extension dist/prose-language-0.1.7.vsix --force
```

Reload the VS Code window if a previously open file retains its old coloring.

## Develop and test

Run `npm.cmd install` and `npm.cmd test` from the repository root. Grammar tests
run through VS Code's TextMate and Oniguruma tokenizer libraries.

To preview changes in a separate VS Code extension development window:

```powershell
node editors/vscode/build.mjs
code.cmd --extensionDevelopmentPath=D:\prose-lang\editors\vscode D:\prose-lang
```

Use **Developer: Inspect Editor Tokens and Scopes** to inspect token scopes.

To package the extension using Microsoft's standard packaging tool:

Install Microsoft's optional [vsce packaging tool](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
then run the following from `editors/vscode` after creating the root `dist` folder:

```powershell
vsce.cmd package --no-dependencies --out ../../dist/prose-language-0.1.7.vsix
```

Packaging creates a local VSIX; it does not publish to the Marketplace.
