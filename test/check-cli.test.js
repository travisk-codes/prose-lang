import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkProject } from "../src/check-project.js";

const require = createRequire(import.meta.url);
const tsPath = require.resolve("typescript");
const ts = require("typescript");
const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));

function fixture(config = {}, { compiler = true, noConfig = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "prose check 😀 "));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write("package.json", '{"type":"module"}');
  if (!noConfig) write("tsconfig.json", JSON.stringify({ include: ["src"], ...config, compilerOptions: {
    target: "es2023", module: "esnext", moduleResolution: "bundler", types: [],
    strict: false, strictNullChecks: false, noUnusedLocals: true, noUnusedParameters: true,
    ...config.compilerOptions
  } }));
  mkdirSync(join(root, "src"), { recursive: true });
  if (compiler) {
    // A physical package bridge, never a junction into another checkout.
    write("node_modules/typescript/package.json", '{"main":"index.cjs"}');
    write("node_modules/typescript/index.cjs", `module.exports = { ...require(${JSON.stringify(tsPath)}), version: "project-${ts.version}" };`);
  }
  return {
    root, write,
    run: (...args) => spawnSync(process.execPath, [cli, "check", ...args], { cwd: root, encoding: "utf8", timeout: 15000 }),
    close: () => rmSync(root, { recursive: true, force: true })
  };
}

function snapshot(root) {
  const files = {};
  const walk = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[file] = readFileSync(join(root, file), "utf8");
    }
  };
  walk("");
  return files;
}

test("check reports mapped Prose type errors as text and JSON, using the project's compiler", () => {
  const f = fixture();
  try {
    f.write("src/main.prose", 'export function wrong giving number\n    return "oops"');
    const result = f.run("--json");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.typescriptVersion, `project-${ts.version}`);
    assert.equal(report.files.length, 1);
    assert.deepEqual(report.diagnostics.map(({ line, column, code }) => [line, column, code]), [[2, 5, 2322]]);
    assert.equal(report.diagnostics[0].file, join(f.root, "src/main.prose"));
    const text = f.run("src/main.prose");
    assert.equal(text.status, 1);
    assert.match(text.stderr, /src[\\/]main\.prose:2:5 - TS2322:/);
    assert.match(text.stdout, /Checked 1 Prose file\. 1 error/);
    assert.doesNotMatch(text.stderr, /__prose_check__/);
  } finally { f.close(); }
});

test("--strict reports unchecked boundaries in text and JSON without changing default checks", () => {
  const f = fixture();
  try {
    f.write('src/main.prose', 'export function identity takes value\n    return value\nexport data is JSON.parse "{}"\nfail "Must not run"');
    const before = snapshot(f.root);
    assert.equal(f.run('src/main.prose').status, 0);
    const checked = f.run('--strict', '--json', 'src/main.prose');
    assert.equal(checked.status, 1, checked.stderr);
    const report = JSON.parse(checked.stdout);
    assert.equal(report.strict, true);
    assert.deepEqual(report.diagnostics.map(item => item.code), ['PROSE_UNCHECKED_RETURN', 'PROSE_UNCHECKED_PARAMETER', 'PROSE_UNCHECKED_EXPORT']);
    const text = f.run('--strict', 'src/main.prose');
    assert.match(text.stderr, /main\.prose:1:32 - PROSE_UNCHECKED_PARAMETER/);
    assert.match(text.stdout, /3 errors/);
    f.write('src/main.prose', 'export function identity takes value as number giving number\n    return value');
    assert.equal(f.run('--strict', 'src/main.prose').status, 0);
    delete before[join('src', 'main.prose')];
    const after = snapshot(f.root); delete after[join('src', 'main.prose')];
    assert.deepEqual(after, before);
  } finally { f.close(); }
});

test("check never executes application imports or writes emitted files, declarations, or build info", () => {
  const f = fixture({ compilerOptions: { incremental: true, tsBuildInfoFile: "cache/build.tsbuildinfo" } });
  try {
    f.write("src/effects.js", 'throw new Error("Application module executed"); export const marker = 1;');
    f.write("src/main.prose", 'use marker from "./effects.js"\nprint marker\nfail "Application code executed"');
    const before = snapshot(f.root);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No errors/);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.close(); }
});

test("fresh import declarations override stale files and imported Prose bodies are checked", () => {
  const f = fixture({ compilerOptions: { paths: { "@lib/*": ["./src/*"] } } });
  try {
    f.write("src/math.prose", 'export function amount giving number\n    return 42\nexport function broken giving number\n    return "bad"');
    f.write("src/math.d.prose.ts", 'export function amount(): string;');
    f.write("src/main.prose", 'use amount from "@lib/math.prose"\nexport function valid giving number\n    return amount run');
    const before = snapshot(f.root);
    const result = f.run("src/main.prose", "--json");
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.files.length, 2);
    assert.deepEqual(report.diagnostics.map(({ file, line, code }) => [file, line, code]), [[join(f.root, "src/math.prose"), 4, 2322]]);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.close(); }
});

test("default selection respects include/exclude and loads ambient project declarations", () => {
  const f = fixture({ include: ["src", "types"], exclude: ["src/excluded"] });
  try {
    f.write("types/environment.d.ts", 'interface Document { proseCount: number; }');
    f.write("src/main.prose", 'print document.prose_count');
    f.write("src/excluded/bad.prose", 'export count as number is "bad"');
    const result = f.run("--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).files.length, 1);
    const explicit = f.run("src/excluded/bad.prose", "--json");
    assert.equal(explicit.status, 1);
    assert.equal(JSON.parse(explicit.stdout).diagnostics[0].code, 2322);
  } finally { f.close(); }
});

test("project files lists select Prose inputs and -p accepts config paths with spaces", () => {
  const f = fixture({ files: ["src/one.prose"], include: [] });
  try {
    f.write("src/one.prose", 'print 1');
    f.write("src/two.prose", 'print unknown');
    const result = f.run("-p", join(f.root, "tsconfig.json"), "--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).files, [join(f.root, "src/one.prose")]);
  } finally { f.close(); }
});

test("cycles and duplicate selections check each imported Prose body once", () => {
  const f = fixture();
  try {
    f.write("src/a.prose", 'use b from "./b.prose"\nexport function a giving number\n    return b run');
    f.write("src/b.prose", 'use a from "./a.prose"\nexport function b giving number\n    return a run');
    const result = f.run("src/a.prose", "src/a.prose", "--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).files.length, 2);
  } finally { f.close(); }
});

test("projects without tsconfig use defaults and output/dependency folders are skipped", () => {
  const f = fixture({}, { noConfig: true });
  try {
    f.write("src/main.prose", 'export count as number is 3');
    f.write("dist/bad.prose", 'this is invalid prose!');
    f.write("node_modules/example/bad.prose", 'this is invalid prose!');
    const result = f.run("--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.project, null);
    assert.equal(report.files.length, 1);
  } finally { f.close(); }
});

test("syntax errors are source diagnostics and setup errors have exit status 2", () => {
  const f = fixture();
  try {
    f.write("src/bad.prose", 'if true\nprint 1');
    let result = f.run("--json");
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].source, "prose");
    assert.equal(JSON.parse(result.stdout).diagnostics[0].line, 1);
    for (const args of [["--bad", "--json"], ["--project", "--json"], ["--project", "missing.json", "--json"], ["missing.prose", "--json"], ["package.json", "--json"]]) {
      result = f.run(...args);
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(JSON.parse(result.stdout).exitCode, 2);
      assert.equal(result.stderr, "");
    }
    f.write("tsconfig.json", '{"compilerOptions": {"unknownOption": true}}');
    result = f.run("--json");
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 5023);
  } finally { f.close(); }
});

test("missing project TypeScript gives an actionable setup error", () => {
  const f = fixture({}, { compiler: false });
  try {
    f.write("src/main.prose", 'print 1');
    const result = f.run("--json");
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).diagnostics[0].message, /TypeScript is not installed.*npm.cmd install/);
  } finally { f.close(); }
});

test("checking errors in hoisted and wrapped annotations maps back to their Prose lines", () => {
  const f = fixture();
  try {
    f.write("src/types.prose", [
      'function wrapped takes', '    value as MissingParameter,', 'giving number', '    return 1',
      'if true', '    local as MissingLocal is 1',
      'type Shape is object', '    field as MissingField'
    ].join("\n"));
    const report = checkProject({ cwd: f.root, typescript: ts });
    assert.deepEqual(report.diagnostics.map(({ line, code, source }) => [line, code, source]), [
      [2, 2304, "typescript"], [6, 2304, "typescript"], [8, 2304, "typescript"]
    ]);
  } finally { f.close(); }
});

test("Prose dependencies reached through a TypeScript module are checked too", () => {
  const f = fixture();
  try {
    f.write("src/child.prose", 'export function value giving number\n    return "wrong"');
    f.write("src/bridge.ts", 'export { value } from "./child.prose";');
    f.write("src/main.prose", 'use value from "./bridge"\nprint value run');
    const result = f.run("src/main.prose", "--json");
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.files.length, 2);
    assert.deepEqual(report.diagnostics.map(({ file, line, code }) => [file, line, code]), [[join(f.root, "src/child.prose"), 2, 2322]]);
  } finally { f.close(); }
});

test("empty selections succeed and unsupported TypeScript versions explain the requirement", () => {
  const f = fixture();
  try {
    let result = f.run("--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).files, []);
    f.write("node_modules/typescript/index.cjs", `module.exports = { ...require(${JSON.stringify(tsPath)}), version: "4.9.5", versionMajorMinor: "4.9" };`);
    result = f.run("--json");
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).diagnostics[0].message, /Use TypeScript 5 or 6/);
  } finally { f.close(); }
});

test("noCheck cannot disable checking and invalid compiler combinations are setup errors even without inputs", () => {
  const f = fixture({ compilerOptions: { noCheck: true } });
  try {
    f.write("src/main.prose", 'export count as number is "wrong"');
    let result = f.run("--json");
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 2322);
    f.write("tsconfig.json", JSON.stringify({ include: [], compilerOptions: {
      module: "esnext", moduleResolution: "nodenext", types: []
    } }));
    result = f.run("--json");
    assert.equal(result.status, 2, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.files, []);
    assert.equal(report.diagnostics[0].code, 5110);
    assert.equal(report.diagnostics[0].source, "configuration");
  } finally { f.close(); }
});
