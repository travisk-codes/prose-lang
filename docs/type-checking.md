# Type checking

`prose check` checks Prose bodies with the project's installed TypeScript 5 or 6,
using its `tsconfig.json`. Diagnostics point back to Prose files, lines, and
columns. Checking does not run application code or write JavaScript,
declarations, maps, or TypeScript build info.

## Command

From the Prose checkout:

```powershell
node bin/prose.js check
node bin/prose.js check examples/arrays.prose
node bin/prose.js check src --project tsconfig.json
node bin/prose.js check --project ../my-app --json
node bin/prose.js check src --strict
npm.cmd run check -- examples/arrays.prose
```

When the CLI is installed as `prose`, use `prose check` with the same arguments.
Install TypeScript in the project being checked if needed:
`npm.cmd install --save-dev typescript`. The command resolves that project's
package, including a hoisted workspace dependency, rather than falling back to
Prose's development dependency.

- With no paths, check Prose files selected by the configuration's `files`,
  `include`, and `exclude` settings. Project ambient `.d.ts` files are included.
- Explicit files and folders select the roots regardless of `include`/`exclude`.
  Folder scans skip hidden entries, symlinks, `node_modules`, `dist`, `build`, and
  `coverage`.
- Imported Prose modules are checked too, including imports outside the selected
  roots and imports reached through TypeScript modules. TypeScript dependencies
  are resolved using the project's normal module and path-alias settings.
- `--project` (or `-p`) accepts a configuration file or a folder containing
  `tsconfig.json`. Otherwise the nearest parent configuration is discovered
  starting at the first input, or the current directory when no input is given.
  Inputs from different projects require an explicit `--project`.
- Without a configuration, scan the current directory or explicit inputs using
  ES2023, ES modules, bundler resolution, and the standard TypeScript libraries.

The checker forces TypeScript's strict family of checks even when the project
turns them off, overrides `noCheck`, disables unused-name lint, and filters
implicit-any and unknown-value diagnostics, since untyped Prose is allowed. Fresh `.d.prose.ts`
declarations exist only in memory and override stale on-disk copies. Imports
use declared export contracts; unannotated exports can still be `any`.

Text diagnostics go to standard error and a file/error count goes to standard
output. `--json` sends one JSON object to standard output with `files`,
`diagnostics`, `exitCode`, and, after successful setup, `project`, `projectRoot`,
`typescriptVersion`, and `ignored`. File paths are absolute. Each diagnostic has
`source`, `code`, `severity`, `file`, `line`, `column`, and `message`; lines and
columns are one-based. Project-wide diagnostics have null locations. An error
in synthetic checker code has `source: "checker"` and a null line/column rather
than a misleading generated location. JSON retains TypeScript's full message;
text output removes Prose's internal variable prefixes.

Common layout errors include a supported example in `message` and optional
`relatedInformation` entries with original `file`, `line`, `column`, and
`message` fields. VS Code exposes these as links to the statement or header
that explains the error. See [line-wrapping guidance](line-wrapping.md).

Exit status is **0** for clean checks (including an empty selection), **1** for
source errors, and **2** for setup/configuration errors. Syntax errors are Prose
diagnostics; type errors carry TypeScript diagnostic numbers.

## Programmatic checking

```javascript
import { checkProject, CheckSetupError } from "prose-lang/check";

try {
  const result = checkProject({ cwd: process.cwd(), targets: ["src"] });
  console.log(result.diagnostics);
  process.exitCode = result.exitCode;
} catch (error) {
  if (!(error instanceof CheckSetupError)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}
```

`project` selects a configuration file or folder; `cwd` defaults to the process
directory and `targets` defaults to an empty list. Hosts may supply a compatible
`typescript` compiler API instead of resolving the project's package.

Editor hosts can pass `overlays: [[absolutePath, sourceText], ...]` to check current
buffers without saving them. Prose imports and TypeScript/JavaScript dependencies
use these snapshots; configuration is still read from disk. This option is not
used by the CLI's saved-file checks.

`hoverTargets: [path, ...]` adds a `hovers` array to the result, for selected or
imported Prose files. Each item has `file`, one-based `line`, `column`, and
exclusive `endColumn` positions, plus Prose `code` and plain `documentation`.
Columns count UTF-16 code units. The project checker supplies these from the same
TypeScript program and source maps as diagnostics. Invalid Prose syntax returns
an empty array. Without `hoverTargets`, the result shape is unchanged.

`definitionTargets: [path, ...]` adds a `definitions` array. Each item has the same
original word range as a hover and a `targets` array of `file`, `line`, `column`,
exclusive `endColumn`, and optional `endLine` positions. Symbols respect lexical
scope. Hoisted bindings point to their first Prose assignment, and imported Prose
exports point to the original source rather than the virtual declaration. Hosts
can request hovers and definitions together to share analysis and token mapping.
All symbol and compiler objects stay internal; results are serializable.

## Optional stricter boundary checks

Run `prose check --strict` (or `node bin/prose.js check --strict`) to require
checked function parameters and public value contracts. Ordinary checking keeps
its existing behavior. TypeScript's strict settings are already enabled in both
modes; this flag adds Prose boundary checks.

| Code | What strict mode reports |
| --- | --- |
| `PROSE_UNCHECKED_PARAMETER` | Any in a named function or callback parameter's type, including inside containers and aliases |
| `PROSE_UNCHECKED_RETURN` | Any in an exported named function's return contract |
| `PROSE_UNCHECKED_EXPORT` | Any in an exported value's contract, including function values and public nested fields |

These are errors: the CLI exits with status 1, and VS Code shows the same codes
in Problems. JSON results include `strict: true` when enabled. Diagnostics point
to the parameter or export name in the original Prose source. Imported Prose
dependencies are checked under the same policy, with fresh declarations held in
memory. TypeScript/JavaScript dependencies are not newly linted for untyped
parameters; an unchecked part of a contract exposed by Prose is still reported.

For example, this function has an unchecked parameter and exported return:

```text
export function double takes value
    return value * 2
```

Its body infers a numeric result, but its public declaration has no `giving`
contract. Both boundaries become checked with:

```text
export function double takes value as number giving number
    return value * 2
```

Contextual inference also counts: a `map` callback on a list of numbers can have
a checked numeric parameter without an annotation. `unknown` and generic type
parameters are allowed. Explicit `any`, including `list of any`, remains
unchecked and is reported at these boundaries.

Exported literal values can already have concrete contracts. Other exported
values may need `as`: an unannotated function-valued export currently has an
`any` declaration even when its body is typed. Exported contracts are expanded
through named types and recursive public fields. Native generic arguments are
checked, while native implementation members and private/protected fields do
not make a concrete `Date` or typed map fail.

Enable the same policy in a workspace or folder's VS Code settings:

```json
{ "prose.check.strict": true }
```

It defaults to `false`, takes effect on saved-file checking, and shares
`prose.check.enabled` and Workspace Trust requirements. Roots with different
folder policies use separate jobs. For CI, add `--strict` to the project's check
script. API callers can pass `checkProject({ ..., strict: true })`.

This mode checks these boundaries; local dynamic values and operations keep the
existing checking rules and suppression policy. It does not prove index bounds
or validate external JSON at runtime. Unresolved annotations retain their normal
TypeScript diagnostics rather than gaining a second unchecked-boundary error.

## Understanding unchecked hover types

When a displayed type contains `any`, its hover explains that this part of the
value is unchecked. This includes function parameters and return types, list
elements, and fields shown in an object hover. Where the source can be traced,
the note distinguishes:

- A parameter with no annotation or inferred contextual type.
- A callback whose contextual function type already supplies `any`.
- An explicit `any` annotation, including unchecked parts of a container type.
- A library declaration such as `JSON.parse` that returns `any`.
- An imported Prose function without a `giving` return contract, or an imported
  value without a declared export type. The importing module sees that contract
  even when the exporting file's body infers something more specific.
- Empty-list, empty-object, unset, and null placeholders kept open for later use.

For example, hovering over `copy` or `result` traces back to `raw_input`:

```text
function forward takes raw_input
    copy is raw_input
    return copy
result is forward 3
```

Adding `as number` to `raw_input` lets these local values infer `number`, so
their unchecked-type notes disappear. For an imported function, add a `giving`
return contract to expose its checked result type to callers. An annotation
describes a contract for checking; it does not validate external JSON at runtime.

The explanation follows symbols and simple value flows, including aliases and
local returns. Tracing is bounded, shows at most three unchecked parts, and
does not guess a unique cause for a binding with several assignments or an
unsupported flow. In those cases it says the source could not be established.
Named types can hide additional unchecked fields that are not expanded in the
hover. This is a reminder about the displayed type, not a complete safety audit.

`unknown` stays distinct from `any`. An operation on an unknown receiver can
produce an unchecked result; its note explains that the receiver needs checking
or narrowing. An unresolved annotation points to type diagnostics rather than
being described as intentionally untyped.

Notes use current editor buffers, including unsaved imported files, and share
`prose.hover.enabled` with hover types. This feature adds no diagnostics, changes
no checking rules, and does not run or write application code.

## Checking output

`compile(source, { check: true })` produces the TypeScript used for checking.
It never replaces the JavaScript that runs a Prose program.

```javascript
const { code, map } = compile(source, {
  check: true,
  sourceMap: true,
  filename: "notes.prose",
  readModule
});
```

The result has the usual `code`, `map`, `module`, and `declarations` fields.
Checking output is always a TypeScript module, including files with no exports.
It includes declared helpers instead of executable runtime helpers. Do not run
it. `sourceMap: "inline"` embeds the map as well as returning it.

The compiler needs no TypeScript package to generate this output. TypeScript is
a development dependency for tests; the command loads the checked project's
own installed TypeScript only when checking is requested.

## Translation

| Prose | Checking output |
| --- | --- |
| `as` and `giving` | Parameter, local, return, and generic type annotations |
| Untyped callbacks | Bare parameters, preserving TypeScript contextual inference |
| A direct variable assigned once | `const` at its assignment |
| Reassigned or branch/loop variables | Function-scoped `let` declarations with flow inference |
| Scalar literals assigned in branches | Literal flow types retained without restricting later assignments |
| A pure callback comparing a field with `null` or `unset` | An inferred field predicate, preserving that proof through `filter` and later operations |
| An untyped empty variable | An unchecked placeholder that can later become text or a callback |
| An empty list | An evolving array; nested empty lists stay untyped |
| A nonempty list literal assigned without an annotation | A mutable array retaining known position types, including nested rows |
| Objects, `like`, and later fields | Object literals and spreads; later fields belong to the actual lexical binding |
| A returned unannotated object that gains fields | A declared type helper adds the new fields while preserving existing field types |
| Named properties and ordinary method calls | Native TypeScript property access and calls |
| `maybe` | Optional property access and calls, or a typed contextual helper |
| Literal numbered positions | Zero-based TypeScript indexing for the one-based Prose position |
| Contextual dots and computed keys | Conditional helper types distinguish sequence positions from literal properties |
| Position writes | Declared helpers enforce element types and readonly lists |
| `are` | Native destructuring, preserving the type of each tuple position |
| `for each` / `each of` | A typed iterable helper, including Map entries |
| `wait for`, `otherwise`, and error handling | `await`, `??`, and native TypeScript control flow |

Typed helper signatures use TypeScript's
[conditional types](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html).
A numeric visible variable indexes a list or text; a nonnumeric variable leaves
the literal property name intact, including methods. Ordinary object receivers
always use the literal name. Computed keys can also select sequence properties,
such as `words.("length")`. Runtime execution keeps its existing Prose helpers.

New fields on unannotated objects are intentionally untyped. Existing fields,
explicitly annotated shapes, and readonly positions retain their constraints.
An empty variable and unset/null object fields are unchecked placeholders.
Generic function values introduce free type variables and capture outer ones.

Branch assignments preserve literal choices, so a value assigned `"a"` or `"b"`
can satisfy that union without an extra annotation. Subsequent assignments still
update its inferred flow type; ordinary object fields keep their mutable types.

Unannotated list assignments retain each literal position's type. For example,
rows such as `("Middlemarch", 880, true)` keep text, number, and boolean positions
when destructured in `for each title, pages, done in shelf`. Objects built from
those values keep the corresponding field types through later callbacks.
These inferred lists remain mutable arrays: their length is a number, they can
grow, and positions beyond the literal's initial entries use its element union.
Explicit annotations, call arguments, and returned literals retain TypeScript's
usual contextual typing, including declared tuples.

A callback consisting of `point.value != null` tells the checker that retained
points have a non-null value. `point.value != unset` excludes only unset; either
comparison can also put the nullish value on the left. The proof survives a later
`map` or `reduce`. This applies to an inline `filter` callback with an inferred
first parameter type and a single returned comparison on its direct property.
Readonly modifiers remain intact. Optional fields stay optional when excluding
only null, and become required when excluding unset. Standalone callbacks, explicit annotations,
compound tests, truthiness tests, nested properties, and contextual sequence positions
retain their existing behavior.

## VS Code diagnostics

Prose Language 0.1.22 checks open, saved Prose files and their imported Prose
dependencies on open and save. Diagnostics appear as squiggles and in Problems.
Use **Prose: Check Saved Files** to run immediately or disable checking with
`prose.check.enabled`. Nested projects use separate configurations and workers.
Dirty buffers wait until save; newer edits invalidate earlier results.

The extension packages this same checker, loading the project's TypeScript in a
background worker only in trusted workspaces with files on disk. Project-wide
setup errors appear at the start of the config (or selected file if no config
exists) and in the Prose output channel. Highlighting and formatting do not
require TypeScript or Workspace Trust.

## Current limits

Editor [parameter hints](../editors/vscode/README.md#parameter-hints) use the
same types and current buffers to show call signatures and the active argument.
The parser preserves the distinction between argument commas and array commas.
Temporary cursor probes recover unfinished calls for analysis; normal compilation
still rejects missing arguments and ambiguous call boundaries.

Type-aware [member autocomplete](../editors/vscode/README.md#autocomplete) uses
the same project TypeScript and current editor buffers. It handles unfinished
`.`/`:` access through a temporary analysis probe. Suggestions use Prose spelling,
computed strings for exact keys, and explicit colons when a visible numeric
variable could shadow a selected sequence property. It does not validate the
runtime value or automatically call a completed method.

Hover types include [Prose/JavaScript convention notes](javascript-interop.md)
for text lengths, positions, native methods, and property spelling. These explain
runtime conventions; they do not add new type checks or prove index bounds.

- TypeScript still widens unannotated object fields and some collection elements.
  Literal unions can need `as` or `giving` annotations.
- More complex guards and relationships between separate lookups still need
  explicit narrowing. A successful lookup does not prove a repeated lookup safe.
- `any` and `unknown` values remain unchecked. New dynamic
  fields and empty placeholders also make deliberate holes in checking.
- Position helpers do not prove bounds, valid write gaps, or one-code-point
  string replacements. Out-of-range reads return unset at runtime. Contextual
  helper reads currently use ordinary array element types and do not yet adapt
  to `noUncheckedIndexedAccess`.
- Checking does not run automatically during builds. Project references are
  resolved by TypeScript but are not built.

`test/check.test.js` runs the real checker on representative good and bad
programs. `test/check-cli.test.js` covers project selection, imported modules,
fresh declarations, mapped diagnostics, exit codes, and read-only behavior.
`test/checking-extension.test.js` covers background workers, saved-file
diagnostics, cancellation, project isolation, trust, and disposal.
`test/hover.test.js` and `test/hovering-extension.test.js` cover inferred hover
types, original token ranges, live buffers, caching, cancellation, and trust.
`test/definition.test.js` covers lexical bindings, imports and re-exports, original
definition ranges, and avoiding synthetic compiler declarations.
The browser bundle and packaged formatter also carry the checking-output
dependency without loading TypeScript.
