# Prose Language for Visual Studio Code

Syntax highlighting, formatting, and type checking for `.prose` files, with a softened rainbow
palette for dark backgrounds matching the Prose website.

Highlights keywords, function declarations and parameters, standard-library
calls, booleans, numbers, strings, escapes, operators, dot indexing, object literals, arrays, and colon property access.
A quoted string alone on a line receives comment coloring. Other strings
receive normal string coloring. Unterminated strings stop at the end of the
line, matching the compiler's single-line strings.

The grammar distinguishes function declarations and standard-library calls.
User-defined calls currently receive identifier coloring; resolving those
symbols across a document is a future semantic-highlighting feature.

The extension includes the Prose formatter, parser, and checker. Formatting reads source
text and imported signatures; it never executes the program or its imports.

## Formatting

Use **Format Document** (`Shift+Alt+F` on Windows). Prose Language is the default
formatter for Prose files unless your settings choose another provider.
The editor's tab size and spaces/tabs preference control indentation.
Set `prose.format.width` to change the preferred width (default 80, minimum 20).
You can enable format-on-save through VS Code's usual editor settings.

Existing line breaks and continuation indentation stay as written when all physical
lines of a statement or header fit the width. Only logical lines with an overlong
physical line are reflowed. Long function headers put each parameter on its own
indented line, with a trailing comma before an aligned `giving` line. Without
`giving`, the final parameter has no trailing comma. Short headers stay on one line.
Long conditions and conditional values use the layouts below. Other long lines
prefer breaks after `or` / `otherwise`, `and`, a lambda's `return`,
and outer argument or object-entry commas, ahead of breaks inside nested calls.
These continuation lines use one extra indentation level from the statement.

`if`, `else if`, and `while` conditions also accept a leading `and` or `or` on
the next line, aligned with the header or indented farther. The body starts
deeper than the first header line. Automatic reflow prefers leading `and` / `or`
aligned with the header, using continuation indentation inside parentheses.
A narrow width can still require a break after an operator. Fitting layouts keep
their existing breaks.

Conditional values can also put `if` and `else` on separate lines, indented more
than the `return`, assignment, or other expression they continue. Automatic reflow
puts both clauses on their own lines for trailing conditional values. Long clause
conditions also prefer leading `and` / `or`, aligned with the `if`. The formatter
preserves fitting layouts and keeps ordinary function bodies and block conditions
intact. Conditional values inside inline `then` bodies keep breaks compatible with
the enclosing header.

The formatter preserves parentheses, strings, patterns, accessors, documentation,
and program structure. It wraps only where Prose allows a continuation and
checks the parsed result before returning an edit. A long string or expression
with no safe break may exceed the width. Invalid syntax leaves the document
unchanged and reports an error. The editor formatter and CLI share their code.

## Type checking

Saved `.prose` files are checked when opened and saved. Errors have squiggles and
appear in VS Code's **Problems** panel with source **Prose** and the same diagnostic
codes and locations as `prose check`. Use **Prose: Check Saved Files** from the
Command Palette to recheck immediately. Set `prose.check.enabled` to `false` to
disable checking for a workspace or folder.

The open, saved Prose files are the roots; imported Prose dependencies are also
checked, including closed files. The nearest `tsconfig.json` selects each project,
so nested projects get separate checks. Saving Prose, TypeScript, JavaScript, or
JSON configuration refreshes checks. Checking runs in a background worker;
superseded checks are canceled. Editing clears affected markers until the next
save, and disk diagnostics are never applied to dirty buffers.

Install TypeScript 5 or 6 in the project (`npm.cmd install --save-dev typescript`).
The checker loads that package and the project's configuration, keeps fresh import
declarations in memory, and never runs application code or writes output files.
It shares the CLI's strict checking and untyped-value policy; see
[type checking](../../docs/type-checking.md) for current limits.

## Hover types

Hover over a variable, property, parameter, or function name to inspect its type.
Types use Prose names, such as `text`, `list of text`, and `maybe number`.
Functions show their parameters and return type, followed by documentation when
available. Object values show their fields. Named project types keep their names.

Hovers also explain Prose/JavaScript conventions at the relevant access: Unicode
code-point length versus JavaScript UTF-16 length, one-based Prose positions
versus zero-based native methods, explicit colon properties, and property-name
conversion. Numeric dot positions and quoted computed keys have hover reminders
too. Native-method hints require a known text/list receiver and a standard
library signature. See [Prose and JavaScript conventions](../../docs/javascript-interop.md).

Hovers read current Prose and TypeScript/JavaScript editor buffers, including
unsaved changes in imported files. They run on demand in a background worker;
moving between words reuses the project's snapshot. Editing, saving, changes on
disk, or changing settings invalidates it. Invalid Prose syntax produces no hover
instead of displaying an older type. Configuration is read from saved files.

Like checking, this needs Workspace Trust, a local project, and that project's
TypeScript 5 or 6. It does not run application code or write files. Hovers have an
independent `prose.hover.enabled` setting (default `true`), so disabling diagnostic
checks does not disable hover types. Setup details appear in the **Prose Language**
output channel. Imported Prose uses its declared export contracts; unannotated
exports can still show `any`.

## Go to Definition

Use **Go to Definition** (`F12` or `Ctrl+click`) on a variable, parameter, or
function name. Reassigned and loop variables jump to their first assignment;
parameters jump to their header. Imported Prose functions open their original
`.prose` source, including through TypeScript re-exports. TypeScript imports open
their real source or declaration files. A contextual numeric sequence index can
jump to its index variable; object properties do not jump to a same-named variable.

Definitions share the hover service's project snapshot and reflect unsaved edits,
including moved declarations in imported Prose files. They require Workspace
Trust and the project's TypeScript. Use `prose.definition.enabled` (default `true`)
to control navigation independently of hovers and diagnostic checking. Invalid
Prose syntax produces no target, and generated checking files are never targets.

Version 0.1.9 preserves scalar literal choices assigned in branches and infers
non-null or defined fields after a simple inline `filter` callback. Later `map`
and `reduce` calls retain that knowledge. These changes affect checking only;
the executable JavaScript and exported declarations stay the same.

Type checking requires **Workspace Trust** because it loads the project's
TypeScript package. Highlighting and formatting still work in Restricted Mode
and virtual workspaces. Diagnostics require saved files on disk. Setup problems
appear on the configuration's first line, or the selected file when no config
exists, and are recorded in the **Prose** output channel without popup messages.

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
`dist/prose-language-0.1.17.vsix` from the repository. Open a `.prose` file.
Its language mode should be **Prose**.

Or use the CLI:

```powershell
code.cmd --install-extension dist/prose-language-0.1.17.vsix --force
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
vsce.cmd package --no-dependencies --out ../../dist/prose-language-0.1.17.vsix
```

Packaging creates a local VSIX; it does not publish to the Marketplace.
