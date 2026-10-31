# Changelog

## Unreleased

### Added

- [docs/grammar.md](docs/grammar.md), a layout-sensitive grammar reference with
  the call-arity environment and static semantics.
- Real Vite build and React render integration tests, and runtime error-path tests.
- Type declarations for the public API (`compile`, `format`, `checkProject`, and
  the Vite plugin), a `typecheck` script, and publishable package metadata.
- CI for Node 20.6/22/24 on Ubuntu, Node 22 on Windows, TypeScript 5, the site
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

- Non-compiling design sketches moved to `examples/sketches/`, which folder
  searches skip. Example sweeps now require every top-level example to compile.
- The lexer, layout/continuation rules, expression grammar, name/AST helpers,
  shared syntax words, statement parser, export signature discovery, and arity
  inference moved out of `src/transpile.js` into focused modules.

## 0.2.3

The current release.
