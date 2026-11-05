# Prose landing page

Playground runtime errors report their original Prose line and column and show
a mapped stack trace in Output. The generated worker program also carries an
inline source map for browser developer tools. Runtime helpers remain unmapped.

The source of the Prose landing page. Build it from the repository root:

```sh
npm.cmd install
npm.cmd run site
```

This writes `site/dist/index.html`, a single self-contained page (Git ignores `dist`). It makes no outside requests and its links are relative, so it can be hosted under any path, such as `homaro.co/prose`.

For local design work while compiler tests are in progress, use:

```sh
node site/build.mjs --preview
```

Preview builds show a development banner and the actual passing/failing test counts. The normal build still requires the full suite to pass before publishing.

| File | Contents |
| --- | --- |
| `template.html` | The page's layout, styles, and copy, with `{{placeholders}}` for generated content |
| `playground.js` | Editor highlighting, scrolling, example selection, execution, and keyboard controls |
| `scripts.mjs` | Safely embeds JavaScript inside the generated HTML |
| `scripts.test.mjs` | Regression checks for inline script escaping and playground syntax |
| `syntax.mjs` | Shared JavaScript and TypeScript highlighting for the build and live playground |
| `syntax.test.mjs` | Checks highlighting, HTML escaping, and browser/build consistency |
| `vendor/prism/` | Bundled Prism grammars and their MIT license |
| `compiler-entry.js` | Browser entry point; esbuild bundles it from the compiler modules in `src/` |
| `compiler.mjs` | Builds that browser compiler bundle for the page and its tests |
| `build.mjs` | Bundles the compiler, fills the placeholders, and writes the page |
| `without.prose` | The function in the opening comparison, as it is in Datums |
| `without.ts` | The TypeScript it replaced, line-wrapped to fit beside it |
| `aloud.mjs` | Reads a sample out loud with every symbol named, and counts its symbols and words |
| `aloud.test.mjs` | Pins the counts the comparison shows |
| `play.prose` | The playground's starting program |

The build keeps the page truthful:

- Prose samples use the VS Code extension's grammar. JavaScript and TypeScript use bundled Prism grammars. All share the site's Prose palette, including live output in the Compiled tab. Dark mode uses the editor's colors, and light mode uses deeper versions that keep a 4.5:1 contrast on the page; the CSS variables for both live in `template.html`.
- Compiled output, generated declarations, and error messages come from the compiler in `src/`.
- `without.ts` must give the same result as `without.prose` on the same charts, or the build stops.
- The comparison's readings and counts are generated from those two files, with one rule for both languages.
- The test count is read from a run of the test suite, which must pass.
- The playground embeds an esbuild bundle of the compiler modules in `src/`, so it
  always matches this repository.

The playground runs automatically by default. Turn off **Auto-run** to edit first, then use **Run** or Ctrl/Cmd+Enter. **Reset** restores the selected example. Tab inserts four spaces in the editor; Shift+Tab moves focus out.

Compiler layout errors include explanatory examples. Error status text preserves
their line breaks and indentation using the code font.

The textarea owns scrolling. Its highlighted layer shares the same system monospace font, padding, and line height, follows its scroll offsets, and resizes with it. Keep token styles from changing font weight or italics inside this overlay: different glyph widths can move the visible text away from the caret.

Identifier underscores and access dots use `c-separator` at 55% opacity so the words stand out, in Prose and in the compiled JavaScript and TypeScript. The VS Code extension uses the equivalent solid color.

For a quick site-only check, run `node --test site/scripts.test.mjs site/syntax.test.mjs`. When changing editor layout, also check clicking into colored text after horizontal/vertical scrolling and after resizing between desktop and mobile widths.
