// The browser compiler for the playground. esbuild bundles this entry into the
// page, so the downloaded compiler is exactly the modules the CLI uses.
export { compile } from "../src/transpile.js";
export { inlineSourceMap, mapStackTrace } from "../src/source-map.js";
