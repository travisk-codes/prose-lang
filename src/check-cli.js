import { relative } from "node:path";
import { checkProject, CheckSetupError } from "./check-project.js";

/** Run the public checker. All TypeScript loading happens after this command is selected. */
export function checkCommand(args) {
  const targets = [];
  let project;
  const json = args.includes("--json");
  const strict = args.includes("--strict");
  const report = diagnostics => {
    for (const diagnostic of diagnostics) {
      const file = diagnostic.file ? relative(process.cwd(), diagnostic.file) || diagnostic.file : "Project";
      const location = diagnostic.line ? `${file}:${diagnostic.line}:${diagnostic.column ?? 1}` : file;
      const code = typeof diagnostic.code === "number" ? `TS${diagnostic.code}` : diagnostic.code;
      console.error(`${location} - ${code}: ${diagnostic.message.replace(/\b_prose_([A-Za-z_0-9]+)/g, "$1")}`);
    }
  };
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--json" || arg === "--strict") continue;
      else if (arg === "--project" || arg === "-p") {
        if (project || !args[i + 1] || args[i + 1].startsWith("-")) throw new CheckSetupError("Expected one project path after --project.");
        project = args[++i];
      } else if (arg.startsWith("-")) throw new CheckSetupError(`Unknown check option: ${arg}`);
      else targets.push(arg);
    }
    const result = checkProject({ project, targets, strict });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      report(result.diagnostics);
      const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === "error").length;
      console.log(result.files.length ? `Checked ${result.files.length} Prose file${result.files.length === 1 ? "" : "s"}. ${errors ? `${errors} error${errors === 1 ? "" : "s"}.` : "No errors."}` : "No Prose files found.");
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    const diagnostics = error instanceof CheckSetupError && error.diagnostics.length ? error.diagnostics
      : [{ source: "configuration", code: "PROSE_CHECK_SETUP", severity: "error", file: null, line: null, column: null, message: error.message }];
    if (json) console.log(JSON.stringify({ files: [], diagnostics, exitCode: 2 }, null, 2));
    else report(diagnostics);
    process.exitCode = 2;
  }
}
