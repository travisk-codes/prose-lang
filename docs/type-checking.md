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
node bin/prose.js check --project D:/Datums/datums --json
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
turns them off, overrides `noCheck`, disables unused-name lint, and filters the draft's implicit-any
and unknown-value diagnostics in generated Prose code. Fresh `.d.prose.ts`
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
| An untyped empty variable | An unchecked placeholder that can later become text or a callback |
| An empty list | An evolving array; nested empty lists stay untyped |
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

## Reproduce the Datums measurement

From this checkout:

```powershell
node scripts/measure-check.mjs D:/Datums/datums
node scripts/measure-check.mjs D:/Datums/datums --json
```

The harness delegates to the public checker, explicitly selecting all `.prose`
files under `src/` and preserving the audit's relative-path JSON format. Both
commands reproduce 28 diagnostics across 46 Datums modules with TypeScript
6.0.3, without modifying application files.

See [the Datums results](type-checking-datums.md) for the remaining diagnostic
groups and the annotation issue found during the handoff.

## VS Code diagnostics

Prose Language 0.1.8 checks open, saved Prose files and their imported Prose
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

- TypeScript still widens unannotated object fields and branch assignments.
  Literal unions can need `as` or `giving` annotations.
- Some JavaScript idioms need stronger narrowing to satisfy TypeScript, such as
  filtering nullable object fields and then projecting them in another callback.
- `any` and `unknown` remain unchecked under the draft's policy. New dynamic
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
The browser bundle and packaged formatter also carry the checking-output
dependency without loading TypeScript.
