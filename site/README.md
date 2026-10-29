# Prose landing page

Playground runtime errors report their original Prose line and column and show
a mapped stack trace in Output. The generated worker program also carries an
inline source map for browser developer tools. Runtime helpers remain unmapped.

The source of the Prose landing page. Build it from the repository root:

```sh
npm.cmd install
npm.cmd run site
```

This writes `site/dist/index.html`, a single self-contained page (Git ignores `dist`).

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
| `build.mjs` | Fills the placeholders and writes the page |
| `hero.prose` | The program on the left page of the opening spread |
| `hero.js` | The same program written by hand in JavaScript, for the right page |
| `play.prose` | The playground's starting program |

The build keeps the page truthful:

- Prose samples use the VS Code extension's grammar. JavaScript and TypeScript use bundled Prism grammars. All share the site's softened Prose palette, including live output in the Compiled tab; its CSS variables live in `template.html`.
- Compiled output, generated declarations, and error messages come from the compiler in `src/`.
- `hero.js` must print exactly what `hero.prose` prints, or the build stops.
- The test count is read from a run of the test suite, which must pass.
- The playground embeds the compiler from `src/`, so it always matches this repository.

The playground runs automatically by default. Turn off **Auto-run** to edit first, then use **Run** or Ctrl/Cmd+Enter. **Reset** restores the selected example. Tab inserts four spaces in the editor; Shift+Tab moves focus out.

The textarea owns scrolling. Its highlighted layer shares the same system monospace font, padding, and line height, follows its scroll offsets, and resizes with it. Keep token styles from changing font weight or italics inside this overlay: different glyph widths can move the visible text away from the caret.

For a quick site-only check, run `node --test site/scripts.test.mjs site/syntax.test.mjs`. When changing editor layout, also check clicking into colored text after horizontal/vertical scrolling and after resizing between desktop and mobile widths.
