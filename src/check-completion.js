import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkProject } from "./check-project.js";
import { completionContext } from "./completions.js";

/** Complete a member or in-scope name against current buffers. Probes are analysis-only. */
export function completeProject({ cwd = process.cwd(), project, completion, overlays = [], typescript } = {}) {
  const file = resolve(cwd, completion.file);
  const canonical = name => process.platform === 'win32' ? resolve(cwd, name).toLowerCase() : resolve(cwd, name);
  const open = overlays.find(([name]) => canonical(name) === canonical(file));
  const source = open ? open[1] : readFileSync(file, 'utf8');
  const context = completionContext(source, completion.line, completion.column);
  if (!context) return { items: [], diagnostics: [], exitCode: 0 };
  const result = checkProject({ cwd, project, typescript, targets: [file],
    overlays: [...overlays.filter(([name]) => canonical(name) !== canonical(file)), [file, context.source]],
    completionProbe: { ...context, file } });
  return { items: result.completions ?? [], diagnostics: result.exitCode === 2 ? result.diagnostics : [], exitCode: result.exitCode === 2 ? 2 : 0 };
}
