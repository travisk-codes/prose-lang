# Prose landing page

The source of the Prose landing page. Build it from the repository root:

```sh
npm.cmd install
npm.cmd run site
```

This writes `site/dist/index.html`, a single self-contained page (Git ignores `dist`).

| File | Contents |
| --- | --- |
| `template.html` | The page: layout, styles, copy, and the playground script, with `{{placeholders}}` for generated content |
| `build.mjs` | Fills the placeholders and writes the page |
| `hero.prose` | The program on the left page of the opening spread |
| `hero.js` | The same program written by hand in JavaScript, for the right page |
| `play.prose` | The playground's starting program |

The build keeps the page truthful:

- Code samples are highlighted with the VS Code extension's grammar and palette.
- Compiled output, generated declarations, and error messages come from the compiler in `src/`.
- `hero.js` must print exactly what `hero.prose` prints, or the build stops.
- The test count is read from a run of the test suite, which must pass.
- The playground embeds the compiler from `src/`, so it always matches this repository.
