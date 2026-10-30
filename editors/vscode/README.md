# Prose Language for Visual Studio Code

Semantic and syntax highlighting, formatting, Run Current File, type checking, autocomplete, parameter hints,
references, and rename
for `.prose` files, with a softened rainbow
palette for dark backgrounds matching the Prose website.

Highlights keywords, function declarations and parameters, standard-library
calls, booleans, numbers, strings, escapes, operators, dot indexing, object literals, arrays, and colon property access.
A quoted string alone on a line receives comment coloring. Other strings
receive normal string coloring. Unterminated strings stop at the end of the
line, matching the compiler's single-line strings.

The grammar supplies immediate coloring while semantic highlighting refines names
using their types and bindings. Function values and aliases receive function
coloring, parameters keep their scoped identity, and known numeric dot selectors
follow their index variable's role.

The extension includes the Prose formatter, parser, and checker. Formatting reads source
text and imported signatures; it never executes the program or its imports.

## Running files

Open the file's folder in VS Code, then open a `.prose` file and click the
**play button** in the editor title, or
choose **Prose: Run Current File** from the Command Palette. The command saves
the active file first, then runs it with the existing `--run` CLI in a VS Code
task terminal. Output stays visible after the program ends. Use **Tasks:
Terminate Task** to stop a running program; repeated clicks do not start duplicate
copies of the same file.

The command uses the nearest Prose development checkout or installed
`node_modules/prose-lang` CLI, falling back to the CLI bundled with the extension.
The working directory is the nearest package directory, then the file's workspace
folder. Relative module imports remain relative to the source
file, as with the CLI. Programs can import Prose and JavaScript files.

Running requires Workspace Trust and **Node 20.6 or newer** on PATH. Set
`prose.run.nodePath` to a Node executable path if needed; supply the executable
only, without arguments. No TypeScript installation is required to run a file.

Imports use their saved contents. Save imported files to run their latest changes;
the command saves only the selected file. A canceled or failed save stops the run.
Untitled and virtual documents cannot run. Execution starts only when you invoke
Run Current File. Opening a file, formatting, and editor analysis never run it.

## Semantic highlighting

Semantic highlighting uses the project's TypeScript and current editor buffers,
including unsaved imported files. It recognizes function declarations, function
values and aliases, callable parameters at call sites, ordinary parameters,
variable declarations and assignments, property names, loop variables, and native
functions. Reassignment follows the type at that occurrence.

The semantic roles map back to the existing Prose TextMate color scopes: functions
are yellow and bold, parameters lime and italic, loop variables lime, bindings
blue, reads pale blue, properties teal, and standard-library/native functions cyan.
Only word segments receive semantic spans. Underscores, dots, colons, strings,
comments, and other punctuation keep their grammar styling. Ambiguous contextual
dots keep grammar coloring until their meaning is known.

The feature runs in a background worker and never executes program code or writes
files. New edits, settings changes, and dependency changes invalidate old tokens.
Invalid Prose syntax clears semantic colors until analysis can succeed; ordinary
type errors can still have useful highlighting. Setup problems appear in
**Prose Highlighting** Output.

This requires Workspace Trust, a local `.prose` file, and the project's TypeScript
5 or 6. Set `prose.semanticHighlighting.enabled` to `false` to use grammar coloring
alone. This setting is independent of diagnostic checking and other editor
features. VS Code's `editor.semanticHighlighting.enabled` also controls display;
its default follows the theme.

Existing `editor.tokenColorCustomizations` rules for Prose apply through semantic
scope fallbacks. For a semantic-only override, use a selector such as
`proseFunction:prose` in `editor.semanticTokenColorCustomizations.rules`.
The registered types are `proseFunction`, `proseParameter`, `proseVariable`,
`proseBinding`, `proseProperty`, `proseIterator`, and `proseBuiltin`. See
[VS Code's semantic highlighting guide](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide#theming)
for theme and customization controls.

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

Common indentation and wrapping errors explain the expected layout and show an
example. In Problems, related information links back to the relevant statement,
header, opening parenthesis, or misplaced clause. See
[line-wrapping guidance](../../docs/line-wrapping.md).

## Type checking

Open `.prose` files are checked when opened, saved, and after a 350 ms pause in
typing. Errors have squiggles and
appear in VS Code's **Problems** panel with source **Prose** and the same diagnostic
codes and locations as `prose check`. Use **Prose: Check Open Files** from the
Command Palette to recheck immediately. Set `prose.check.enabled` to `false` to
disable checking for a workspace or folder.

Enable `prose.check.strict` to also report `any` in function parameters and
exported return/value contracts. This opt-in policy matches CLI `prose check
--strict`; it defaults to `false`. The errors use `PROSE_UNCHECKED_PARAMETER`,
`PROSE_UNCHECKED_RETURN`, and `PROSE_UNCHECKED_EXPORT` codes in Problems.
Typed callback inference counts, and imported Prose dependencies follow the
same policy. See [stricter boundary checks](../../docs/type-checking.md#optional-stricter-boundary-checks).

The open local Prose files are the roots; imported Prose dependencies are also
checked, including closed files. The nearest `tsconfig.json` selects each project,
so nested projects get separate checks. Checks use the current text of open
Prose, TypeScript, JavaScript, and JSON files, including unsaved imports. Closed
dependencies are read from disk. Editing clears affected markers immediately;
after the typing pause, a background worker checks the latest buffer snapshot.
New edits cancel superseded workers, and older results cannot replace a newer
buffer's diagnostics. Opening or closing an imported buffer and dependency changes
on disk also refresh checks. Project configuration remains read from saved files;
save `tsconfig.json` changes to apply them. Untitled and virtual documents are
excluded. Analysis never saves or executes program code.

Install TypeScript 5 or 6 in the project (`npm.cmd install --save-dev typescript`).
The checker loads that package and the project's configuration, keeps fresh import
declarations in memory, and never runs application code or writes output files.
It shares the CLI's strict checking and untyped-value policy; see
[type checking](../../docs/type-checking.md) for current limits.

## Quick fixes

Use **Quick Fix** (`Ctrl+.` on Windows) on a call with an unknown parameter count
and an ambiguous comma. For example:

```prose
function apply takes action
    return action 1, 2
```

**Use with for arguments** changes the return to `action with 1, 2`.
**Make an array (put the call in parentheses)** changes it to `(action 1), 2`.
Neither action is preferred, and there is no Fix All action for this ambiguity.
Choose the reading you mean.

The compiler reports `PROSE_CALL_BOUNDARY` at the ambiguous comma. Fixes use
parser positions, compile each proposed result, and verify whether that comma
becomes an argument separator or an array separator. Receivers, computed members,
constructors, `maybe`, wrapped lines, and Unicode positions keep their boundaries.
An alternative is offered only when it parses as advertised; other Prose syntax
errors or more involved nesting can prevent a fix. Normal type checking can still
report other errors after the ambiguity is resolved.

Fixes read current buffers, including unsaved Prose dependencies. Diagnostic
checking supplies automatic lightbulbs; manually invoking Quick Fix also analyzes
a dirty file or a file with checking disabled. The edits are prepared only when
selected, with source versions and dependency contents rechecked. Changed or
canceled requests cannot supply stale edits. Applying a fix uses VS Code's normal
undoable workspace edit and leaves saving to the editor.

This requires Workspace Trust, a local file, and the project's TypeScript 5 or 6.
Set `prose.quickFixes.enabled` to `false` to disable these actions independently
of checking and other editor features. Setup details appear in **Prose Quick
Fixes** Output. Analysis never executes the program or imported modules.
This version targets unknown-count call/comma ambiguity; other diagnostics retain
their existing guidance.

## Autocomplete

Start typing a variable, parameter, or function name, or press **Ctrl+Space** in
an expression. Suggestions include names already in scope, with their types and
function signatures. For example, `cip` can suggest `cipher` and show its
parameters. Callbacks include their inferred parameters and captured variables;
shadowed names use the nearest binding. Function values, aliases, loop variables,
and already imported values are included. Suggestions insert the original Prose
name only, replacing the full partial word even when the cursor is in its middle.
They do not add imports, arguments, parentheses, or `run`.

Type `.` or `:` after a value, or press **Ctrl+Space** within a partial member
name, to suggest fields and methods from its current type. Native methods use
Prose spelling when it round-trips to the JavaScript name: `to_upper_case` and
`to_iso_string`. Suggestions show types, function signatures, and available
documentation. Completing a method inserts its name; add arguments or `run`
according to the usual call rules.

Completion works on unfinished access such as `book.` and within typed callbacks
and loops. Current buffers, including unsaved imported Prose and TypeScript
files, supply the types. A temporary analysis probe completes the expression
without changing or executing the source. New edits and cancellation prevent
stale suggestions from being inserted.

Exact JavaScript keys that cannot be represented as a bare Prose name use a
computed string suggestion, such as `("user_id")`. If a numeric or untyped
variable could turn `words.map` into an index, selecting the `map` method inserts
`words:map`. Its detail explains that property escape.

Autocomplete requires Workspace Trust, a local file, and the project's TypeScript
5 or 6. It has an independent `prose.completion.enabled` setting (default `true`);
disabling diagnostic checking does not disable completions. Setup failures
appear in **Prose Completion** Output. Strings, patterns, type-name contexts,
unknown receivers, and unrelated syntax errors do not produce guessed members.
Identifier suggestions exclude declaration names, property keys, type-only names,
and compiler helpers. Unrelated Prose syntax errors can prevent suggestions.

## Parameter hints

While writing a call, spaces, commas, and opening parentheses trigger a parameter
tooltip. Use **Trigger Parameter Hints** (`Ctrl+Shift+Space` on Windows) to open
it manually. The current argument is highlighted in the function's signature:

```prose
function cipher takes message as text, rotate as number, giving text
    return message

cipher "hello",
```

Here the tooltip highlights `rotate as number`. It supports named Prose
functions, function values, typed function parameters, imported functions,
native methods, and explicit `with` calls. Optional and rest parameters,
overloads, and available documentation appear in the tooltip. Types use Prose
spelling, and the method name keeps its source spelling.

The existing parser selects the call and argument, including nested and wrapped
calls. A comma that starts another array element does not advance a completed
call's parameter. Unknown parameter counts still require `with` for several
arguments, following the normal language rules. Unfinished strings are supported;
unrelated syntax errors can prevent hints. Unknown or untyped callees do not
receive guessed signatures.

Parameter hints use current buffers, including unsaved imported files, in a
background worker. Temporary cursor probes fill only the unfinished call for
analysis; source files and executable output are unchanged. No program or import
is executed. Edits and cancellation discard stale results. This requires Workspace
Trust, a local file, and the project's TypeScript 5 or 6.

Set `prose.signatureHelp.enabled` to `false` to disable hints independently of
autocomplete, hover, and diagnostic checking. Setup problems appear in
**Prose Parameters** Output. VS Code's `editor.parameterHints.enabled` setting
also controls automatic parameter tooltips.

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

If the displayed type contains `any`, the hover also explains which part is
unchecked and traces common sources: untyped parameters, aliases and local
returns, explicit annotations, library return types, imported Prose contracts,
and empty placeholders. Ambiguous or unsupported flows receive an honest
fallback. `unknown` is kept distinct. See
[unchecked hover types](../../docs/type-checking.md#understanding-unchecked-hover-types).

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
and virtual workspaces. Diagnostics require local file-backed buffers. Setup problems
appear on the configuration's first line, or the selected file when no config
exists, and are recorded in the **Prose** output channel without popup messages.

## References and rename

Use **Find All References** (`Shift+F12`) on a variable, parameter, or function
name to find its declaration, reads, and assignments. Local bindings stay within
their file. Exports and direct `.prose` imports link references across the project,
including closed consumers. You can start from the declaration, a `use` statement,
or a call in an importing file.
References follow lexical scope, including closures, reassignment, destructuring,
loop variables, and exception bindings.

Use **Rename Symbol** (`F2`) to rename a variable, parameter, or function. Renaming
an export or direct Prose import updates the declaration, matching `use` names,
and consumer references together. Same-named bindings in other scopes and
unrelated modules stay separate.
Object shorthand preserves its property name: renaming `name` to `person_name`
changes `object name` into `object name is person_name`. Strings and property
keys keep their spelling. Known numeric dot indexes follow the renamed binding.

Rename validates the edited program before returning edits. It rejects invalid
names, collisions, captured bindings, and changes that would turn a property
into a contextual index. If an existing dot could mean either an index or a
property, make the intended access explicit before renaming. Broad object
contracts can still hold arrays, so these cases are handled conservatively.
Types, globals, and property-key rename are not supported. Parameters inside
exported functions can be renamed locally.

The project search covers the nearest `tsconfig.json` directory, or the workspace
folder when there is no configuration. Consumers need not be listed in the config's
`include`. Nested projects, symbolic links, hidden directories, `node_modules`,
`dist`, `build`, `coverage`, and generated checking/declaration files are skipped.
Direct relative or absolute paths ending in `.prose` are supported. A known
JavaScript/TypeScript consumer, re-export, or Prose path-alias consumer of the
selected export prevents a partial rename. Reference results cover supported
Prose consumers; other import forms can still have local references.

Both features read current buffers, including unsaved dependencies, in a
background worker. They require valid Prose syntax, Workspace Trust, a local
file, and the project's TypeScript 5 or 6. Connected modules must have valid Prose
syntax; unrelated malformed bodies are ignored during consumer discovery.
Analysis never runs program code or
writes source files; VS Code applies an accepted rename as a normal undoable
workspace edit. Editing or cancellation discards stale results. Closed-file
contents and the source inventory are checked again before returning project edits.

Use `prose.references.enabled` and `prose.rename.enabled` to control these features
independently. Both default to `true`; disabling diagnostic checking does not
disable them. Setup problems appear in **Prose Refactoring** Output.

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
`dist/prose-language-0.1.26.vsix` from the repository. Open a `.prose` file.
Its language mode should be **Prose**.

Or use the CLI:

```powershell
code.cmd --install-extension dist/prose-language-0.1.26.vsix --force
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
vsce.cmd package --no-dependencies --out ../../dist/prose-language-0.1.26.vsix
```

Packaging creates a local VSIX; it does not publish to the Marketplace.
