# Checking output: stage 1

`compile(source, { check: true })` produces TypeScript for checking. It never
replaces the JavaScript that runs a Prose program. This stage supplies the
checking output, typed helper declarations, and source maps; the public
`prose check` command, friendly diagnostic wording, build gate, and editor
diagnostics are later stages of the design.

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
a development dependency for tests; the measurement harness loads the checked
project's own installed TypeScript.

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

The harness checks all `.prose` files under `src/`, using the project's
`tsconfig.json` and TypeScript package. It forces the
[strict family of checks](https://www.typescriptlang.org/tsconfig/strict.html),
disables unused-name lint, and filters the draft's implicit-any and unknown-value
diagnostics. Checking output and fresh `.d.prose.ts` declarations are virtual;
existing files are not updated and application code is never executed. Remaining
diagnostics produce exit status 1 and include mapped Prose lines and columns.

See [the Datums results](type-checking-datums.md) for the remaining diagnostic
groups and the annotation issue found during the handoff.

## Limits for the next stages

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
- This stage does not install diagnostics in VS Code or make checking a build
  gate. Those follow the project-level command and diagnostic wording stages.

`test/check.test.js` runs the real checker, tests representative good and bad
programs, and checks that diagnostics map back to Prose. The browser bundle and
packaged formatter also carry the checking-output dependency.
