const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  const { checkProject, CheckSetupError } = await import("./dist/formatter/check-project.js");
  let result;
  try {
    result = checkProject(workerData);
  } catch (error) {
    result = {
      files: [], exitCode: 2,
      diagnostics: error instanceof CheckSetupError && error.diagnostics.length ? error.diagnostics : [{
        source: "configuration", code: "PROSE_CHECK_SETUP", severity: "error",
        file: null, line: null, column: null, message: error.message
      }]
    };
  }
  parentPort.postMessage(result);
})().catch(error => { throw error; });
