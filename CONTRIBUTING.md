# Contributing

## Setup

Prose requires Node.js 20.6 or newer.

```sh
npm install
npm test
npm run typecheck
```

The compiler and CLI have no runtime dependencies; `npm install` is only needed
for the test suite, checking, and the site/editor builds.

## Checks

| Command | What it covers |
| --- | --- |
| `npm test` | Compiler, formatter, checker, editor providers, Vite plugin, site scripts, and package integrations |
| `npm run typecheck` | The public API declarations in `src/*.d.ts` |
| `node site/build.mjs` | The single-file landing page and playground; production builds require a green suite |
| `node editors/vscode/build.mjs` | Copies the formatter, parser, checker, and runtime into `editors/vscode/dist` |

CI runs the suite on Node 20.6, 22, and 24 on Ubuntu, Node 22 on Windows, and a
TypeScript 5 job.

## Layout

- `src/transpile.js` — lexer, parser, name resolution, arity inference, emitters,
  declarations, and source maps.
- `src/format.js` — the formatter; it reparses its output and refuses changes that
  alter program meaning.
- `src/check-project.js` and `src/check-*.js` — the TypeScript-backed checker and
  the editor analyses built on it.
- `src/vite.js`, `src/node-hooks.js` — integration entry points.
- `editors/vscode/` — the extension; `dist/` is generated and ignored.
- `site/` — the landing page and playground builder.
- `docs/grammar.md` — the grammar reference; update it when syntax changes.

## Examples

Runnable examples live at the top level of `examples/`; the test suite compiles
every one of them and formats them. Design sketches that are not expected to
compile belong in `examples/sketches/`, which folder searches skip.

## Adding a language feature

Language changes usually touch several layers:

1. `src/transpile.js` — tokens, parser, scopes, emitter, and (if applicable)
   checking output.
2. `src/format.js` — layout and spacing, when the feature affects line breaks.
3. `src/*.d.ts` — public API types, when an exported signature changes.
4. Tests — compiler behavior, errors, formatting stability, source maps, and
   editor features where relevant.
5. `README.md` and `docs/grammar.md` — user-facing syntax and semantics.

Run `node --check` on edited JavaScript files as a quick syntax check.
