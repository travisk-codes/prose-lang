# Tools

Commands here are written for a clone of this repository, as
`node bin/prose.js`. Prose isn't on npm yet, so another project depends on a clone
by its path, which also gives it the `prose` command:

```sh
npm install --save-dev ../prose-lang
npx prose program.prose --run
```

On Windows PowerShell, use `npm` and `npx.cmd` if the execution policy blocks
`npm.ps1`.

- [Running programs](#running-programs)
- [Checking and declarations](#checking-and-declarations)
- [Formatting](#formatting)
- [Source maps and debugging](#source-maps-and-debugging)
- [Vite](#vite)
- [Compiler API](#compiler-api)
- [VS Code](#vs-code)

## Running programs

```sh
node bin/prose.js examples/fizzbuzz.prose --run
node bin/prose.js examples/fizzbuzz.prose > fizzbuzz.js
node fizzbuzz.js
```

The CLI writes JavaScript to standard output by default. Add `--run` to
execute it with Node.js; any `.prose` files it imports are compiled as they
load. Run programs you trust; execution has ordinary Node.js permissions.

`package.json` has shortcuts for several examples, such as `npm run example:tour`.

## Checking and declarations

`node bin/prose.js check <folder>` checks Prose without running it or writing
files, and `node bin/prose.js types <folder>` writes TypeScript declarations. See
[Types](guide.md#types) for annotations and [Type checking](type-checking.md) for
the details.

## Formatting

The formatter standardizes indentation and spacing while keeping your line breaks
and continuation indentation whenever every physical line of a statement or header
fits the width. It reflows a logical line only when one of its physical lines is too
long. Its default width is 80 columns:

```sh
node bin/prose.js format examples/reading_list.prose --width 80
node bin/prose.js format src --check
npm run format -- examples/fizzbuzz.prose
```

Files and folders are accepted; folders are searched recursively, skipping
hidden entries, `node_modules`, and `sketches`. Formatting updates files in place. `--check`
reports files that would change and exits with status 1 without writing them.
Already formatted files are left alone. A syntax error stops the batch before
any files are written; unfinished design sketches need valid syntax first.
Layout errors include an explanation and example; see
[wrapping lines and reading layout errors](line-wrapping.md).

When a function header needs reflowing, each parameter gets its own indented line,
with a trailing comma, and `giving` returns to the header's indentation:

```prose
export function create_note_tags takes
    body as text,
    title as maybe text,
    labels as maybe list of text,
giving list of DatumTag
```

A header that fits on one line stays there. Without `giving`, the last parameter
has no trailing comma, so the function body starts separately. Long conditions
and conditional values use the layouts below. Other long lines
prefer breaks after `or` / `otherwise`, then `and`, then a lambda's `return`, then
commas between outer call arguments or object entries. Nested calls and opening
parentheses stay together when a looser break works. These continuation lines
use one extra indentation level from the statement's first line.

Conditions in `if`, `else if`, and `while` may also continue with leading `and`
or `or`, aligned with the header or indented farther. The body remains deeper
than the first header line:

```prose
if number < 0
or number >= 10
    print "Outside the range"
```

These breaks keep the usual precedence and short-circuit behavior. When a condition
needs reflowing, the formatter prefers leading `and` / `or`, aligned with its header.
Operators inside parentheses use continuation indentation. A very narrow width may
require a break after an operator instead. Fitting layouts retain their breaks.
A leading operator cannot continue a condition after its body has started.

When a trailing conditional value needs reflowing, its `if` and `else` clauses each
start a new line, one indentation level deeper than the statement:

```prose
labels is books.map function takes book
    return book.title + " (long)"
        if book.pages > 500
        else book.title
```

Long conditions within these clauses also prefer leading `and` / `or`, aligned
with the `if`. This layout works for returns, assignments, `print`, and object
property values. Parentheses and function bodies keep their existing boundaries.
Conditional values inside inline `then` bodies keep continuation breaks compatible
with the enclosing header.

The formatter keeps strings, patterns, parentheses, and the choice of `.` or `:`.
It reparses the result and checks that the program's structure and documentation
are unchanged. Strings, long names, and expressions without a safe break may
exceed the requested width. Existing LF or CRLF line endings are retained.

For a preview, use standard input; `--stdin-filepath` resolves Prose imports
relative to the named file:

```sh
cat examples/reading_list.prose |
    node bin/prose.js format - --stdin-filepath examples/reading_list.prose
```

In VS Code, use **Format Document** (`Shift+Alt+F` on Windows). The extension
uses the same formatter, follows the editor's indentation settings, and accepts
`"prose.format.width": 80`. Formatting does not enable format-on-save; that
remains an editor preference. The formatter reads imported Prose signatures
without running any program code.

From JavaScript, import `format` from `prose-lang/format` (or `./src/format.js`
inside this repository) and call `format(source, { width: 80, readModule })`.
As with the compiler, `readModule(path)` supplies the text of imported Prose
files when their function signatures are needed.

## Source maps and debugging

`node bin/prose.js program.prose --run` enables source maps automatically.
Runtime errors show stack frames pointing to the original `.prose` files,
including imported modules and asynchronous functions. Syntax errors retain
their short file-and-line messages.

JavaScript printed by the CLI includes an inline source map with the original
Prose text. To use it after saving the output, enable Node's source-map support:

```sh
node bin/prose.js examples/fizzbuzz.prose > fizzbuzz.js
node --enable-source-maps fizzbuzz.js
```

The Vite plugin returns maps for each transformed Prose file. Vite can compose
them with later transforms; use `build: { sourcemap: true }` to include maps in
a production build. In the playground, a runtime error displays its Prose line
and column, with the mapped stack trace in Output. Browser developer tools can
also read the worker program's inline map.

The compiler API accepts `sourceMap: true` to return a separate map, or
`sourceMap: "inline"` to append it to the JavaScript as well:

```javascript
const { code, map } = compile(source, {
    filename: "notes.prose",
    sourceMap: true
});
```

Maps follow [ECMA-426](https://tc39.es/ecma426/) and are off by default in the
compiler API (`map` is then `null`). They include
the original source and locations at statement and expression starts, including
continuation lines. Generated runtime helpers and local declarations remain
unmapped. Debugger breakpoints use the Prose locations; debugger locals still
use the generated JavaScript bindings.

If registering the Node loader yourself, start Node with `--enable-source-maps`
or call `process.setSourceMapsEnabled(true)` before importing Prose files.

## Vite

To use `.prose` files in a [Vite](https://vite.dev) project (including Vitest),
add Prose as a development dependency, as above, and add its plugin to the Vite
configuration:

```ts
import prose from 'prose-lang/vite'

export default defineConfig({
  plugins: [prose()],
})
```

Import Prose modules with their extension: `import { nextDay } from './dates.prose'`.
The plugin compiles each file and shares one copy of the runtime helpers among
them. When a Prose file's exported functions change, the files that import it
are recompiled. For TypeScript, generate a declaration file beside each Prose
file, such as `dates.d.prose.ts` (see [Types](guide.md#types)), and enable
`allowArbitraryExtensions` in `tsconfig.json`.

## Compiler API

`compile` and `transpile` come from `src/transpile.js`, or `prose-lang` in a project
that depends on Prose. `compile(source, options)` returns
`{ code, map, module, declarations }`; `transpile(source, options)` returns only
the code. Options:

- `runtime`: a module path to import the runtime helpers from instead of
  embedding them.
- `readModule(path)`: returns the source of an imported `.prose` file, for
  reading its exported functions. Compiling a file that imports one without
  this option is an error. The CLI and the Vite plugin provide it.
- `sourceMap`: `true` for a separate map, `"inline"` to embed it too, or `false`
  (the default) to omit it.
- `filename`: the original source path or URL recorded in a map; defaults to
  `program.prose`. The CLI and Vite plugin supply it automatically.
- `check`: `true` to generate TypeScript for type checking instead of executable
  JavaScript. See [Type checking](type-checking.md).

To run `.prose` files in your own Node.js program, register the module hook in
`src/node-hooks.js` with `module.register`; the CLI's `--run` does this.

The compiler parses expressions and indentation into an AST, resolves
every name, then emits a standalone JavaScript script or an ES module. The full
grammar reference is in [grammar.md](grammar.md).

## VS Code

The extension in `editors/vscode` adds highlighting, error squiggles from the same
checker as the CLI, autocomplete, parameter hints, hover types, go to definition,
references, rename, formatting, and running and debugging with breakpoints. Its
[README](../editors/vscode/README.md) describes each feature and how to
[build and install it](../editors/vscode/README.md#install).
