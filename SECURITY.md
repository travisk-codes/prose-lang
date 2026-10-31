# Security

## Trust model

- `prose <file> --run` compiles and executes the program with the ordinary
  permissions of the current Node.js process. Run only programs you trust.
- `prose check` loads the selected project's TypeScript package and reads its
  `tsconfig.json`. It does not execute the application, but it does load code from
  the project's `node_modules`; use it on trusted projects.
- Formatting, declaration generation, and the Vite plugin read source text and
  imported Prose signatures. They do not execute the program or its imports.
- The VS Code checker, hover, navigation, run, and debug features require
  Workspace Trust. The formatter and syntax highlighting remain available in
  restricted workspaces.
- The debugger starts Node with an inspector bound to `127.0.0.1` on an ephemeral
  port. `prose.run.nodePath` is machine-scoped so a workspace cannot redirect it.
- The browser playground runs compiled programs in a worker. That worker has the
  ordinary capabilities of a same-origin worker, including `fetch`.
- Source maps include the original Prose source. Review compiled output before
  serving it publicly.

## Reporting

Please report vulnerabilities through the repository's private security advisory
form rather than a public issue:

https://github.com/travisk-codes/prose-lang/security/advisories/new
