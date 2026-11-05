# Changelog

## Unreleased

### Added

- [docs/grammar.md](docs/grammar.md), a layout-sensitive grammar reference with
  static semantics.
- Real Vite build and React render integration tests, and runtime error-path tests.
- Type declarations for the public API (`compile`, `format`, `checkProject`, and
  the Vite plugin), a `typecheck` script, and publishable package metadata.
- CI for Node 20.19/22/24 on Ubuntu, Node 22 on Windows, TypeScript 5, the site
  build, and the extension build.

### Fixed

- `types` now rejects explicit files that are not `.prose`, instead of treating
  the input path as its own declaration file.
- A property named `pattern` can be called with a string (`x.pattern "..."`).
- A property named `is`, `and`, or another continuation word no longer swallows
  the following indented body.
- A top-level `wait for` outside module output now reports an actionable error
  instead of emitting invalid script output.

### Changed

- The README is now a short introduction. The language reference moved to
  [docs/guide.md](docs/guide.md), and the notes on the CLI, formatter, debugging,
  Vite, and the compiler API to [docs/tools.md](docs/tools.md).
- A call now takes every comma after it, and parentheses end it early, whatever it
  calls. Parsing no longer infers argument counts, so a line can't change meaning
  when another file does, and `with` is optional for every call. Calls that aren't
  last in a list need parentheses: `print (add 1, 2), 3`.
- Prose functions still check how many arguments they get: too many is an error, and
  too few is an error unless the call uses `with`.
- Spacing alone decides a minus after a Prose function: `f -1` passes a negative
  argument, and `f - 1` subtracts.
- Removed the editor's call-boundary quick fixes, which the new rule makes unnecessary.
- Non-compiling design sketches moved to `examples/sketches/`, which folder
  searches skip. Example sweeps now require every top-level example to compile.
- The lexer, layout/continuation rules, expression grammar, name/AST helpers,
  shared syntax words, statement parser, export signature discovery, scopes, type spelling/declaration generation, and the compiler
  emitters moved out of `src/transpile.js` into focused modules.
- Node 20.19 is now the oldest supported version; Node 20.6 crashes when loading
  the TypeScript checker. The API type fixture moved to `type-tests/` so Node's
  test runner does not execute it as a test.

## 0.2.3

The current release.
