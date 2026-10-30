import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkProject } from './check-project.js';
import { signatureContexts } from './signature-help.js';

export function signatureHelpProject({ cwd = process.cwd(), project, signature, overlays = [], typescript } = {}) {
  const file = resolve(cwd, signature.file);
  const canonical = name => process.platform === 'win32' ? resolve(cwd, name).toLowerCase() : resolve(cwd, name);
  const open = overlays.find(([name]) => canonical(name) === canonical(file));
  const source = open ? open[1] : readFileSync(file, 'utf8');
  for (const context of signatureContexts(source, signature.line, signature.column)) {
    const result = checkProject({ cwd, project, typescript, targets: [file],
      overlays: [...overlays.filter(([name]) => canonical(name) !== canonical(file)), [file, context.source]],
      signatureProbe: { ...context, file } });
    if (result.exitCode === 2) return { diagnostics: result.diagnostics, exitCode: 2 };
    if (result.signatureHelp) return { signatureHelp: result.signatureHelp, diagnostics: [], exitCode: 0 };
  }
  return { diagnostics: [], exitCode: 0 };
}
