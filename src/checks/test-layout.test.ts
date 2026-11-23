import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { lintSpec } from "./spec-lint.ts";
import { arrayAfter, iniValues, inLayout, isTestOrBuildConfig, type TestLayout, testLayout } from "./test-layout.ts";

const repo = (files: Record<string, string>) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-layout-"));
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), t);
  }
  return d;
};
const ok = (l: TestLayout | null, f: string) => {
  assert.ok(l, "a layout");
  return inLayout(f, l);
};

test("Kitchen's own repo: vitest's include, src/**/*.test.ts (dogfood 002/005 put tests in tests/ and test/)", () => {
  const l = testLayout(path.resolve(import.meta.dirname, "..", ".."), "npm test -- {file}");
  assert.deepEqual(l, { runner: "vitest", globs: ["src/**/*.test.ts"], source: "vitest.config.ts" });
  assert.ok(ok(l, "src/cli/status.test.ts"));
  assert.ok(!ok(l, "tests/status.test.ts"));
  assert.ok(!ok(l, "test/dismiss.test.ts"));
});

test("vitest/jest config, package.json jest, pytest ini sections, mocharc", () => {
  assert.deepEqual(testLayout(repo({ "vitest.config.mts": "export default { test: { include: ['web/**/*.spec.tsx'] } }" }))?.globs, ["web/**/*.spec.tsx"]);
  const vd = testLayout(repo({ "vitest.config.ts": "export default {}" }));
  assert.ok(ok(vd, "a/b.test.tsx") && ok(vd, "c.spec.mjs") && !ok(vd, "a/b.js"), "vitest's default include");
  assert.deepEqual(testLayout(repo({ "vite.config.ts": "export default { server: { include: ['x'] } }" })), null, "vite config without a test block");
  const j = testLayout(repo({ "package.json": JSON.stringify({ jest: { testMatch: ["<rootDir>/src/**/*.test.js"] } }) }));
  assert.ok(ok(j, "src/a/b.test.js") && !ok(j, "test/b.test.js"));
  assert.ok(ok(testLayout(repo({ "jest.config.js": "module.exports = {}" })), "lib/__tests__/a.ts"));
  const py = testLayout(repo({ "pyproject.toml": '[project]\nname = "x"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' }));
  assert.ok(ok(py, "tests/unit/test_cli.py") && !ok(py, "src/test_cli.py"));
  const ini = testLayout(repo({ "setup.cfg": "[tool:pytest]\ntestpaths =\n    tests\n    integration\npython_files = check_*.py\n" }));
  assert.deepEqual(ini?.globs, ["tests/**/check_*.py", "integration/**/check_*.py"]);
  assert.deepEqual(testLayout(repo({ ".mocharc.json": '{ "spec": ["spec/**/*.spec.js"] }' }))?.globs, ["spec/**/*.spec.js"]);
});

test("no config: the runner scripts.test or test_cmd names, with its defaults (the bench fixtures)", () => {
  // b-cli: python3 -m unittest
  const b = testLayout(repo({ "tests/test_cli.py": "", "pyproject.toml": "[project]\nname='b'\n" }), "python3 -m unittest {file}");
  assert.equal(b?.runner, "unittest");
  assert.ok(ok(b, "tests/test_purge.py") && !ok(b, "tests/purge_check.py"));
  // a-web: node --test {file}, no tests yet
  const a = testLayout(repo({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }) }), "node --test {file}");
  assert.equal(a?.runner, "node --test");
  assert.ok(ok(a, "test/theme.test.js") && ok(a, "theme.test.mjs") && !ok(a, "spec/theme.js"));
  // d-api: scripts.test is `node --test`
  assert.equal(testLayout(repo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }))?.runner, "node --test");
  assert.deepEqual(testLayout(repo({ "package.json": JSON.stringify({ scripts: { test: "node --test test/" } }) }))?.globs, ["test/**"]);
  assert.equal(testLayout(repo({ "README.md": "" }), "make check"), null, "unknown: nothing is refused");
});

test("config parsing helpers", () => {
  assert.deepEqual(arrayAfter('test: { "include": ["a/**", \'b\'] }', "include"), ["a/**", "b"]);
  assert.equal(arrayAfter("include: []", "include"), null);
  assert.deepEqual(iniValues("[pytest]\npython_files = t_*.py x_*.py\n[other]\npython_files = no\n", "pytest", "python_files"), ["t_*.py", "x_*.py"]);
});

test("spec-lint rule 8: a `test` proof's file must be in the repo's test layout", () => {
  const layout: TestLayout = { runner: "vitest", globs: ["src/**/*.test.ts"], source: "vitest.config.ts" };
  const md = (file: string) => `## Criteria\n- [C1] the status JSON serializer emits valid JSON\n  proof: test ${file}\n  expect: exit 0\n`;
  const L = (file: string, l: TestLayout | null = layout) => lintSpec(md(file), { kind: "feature", toolkit: { primitives: [], drives: {} }, testLayout: l });
  assert.equal(L("src/cli/status-json.test.ts").reason, undefined);
  assert.match(L("tests/status-json.test.ts").reason ?? "", /outside the repo's test layout \(vitest: src\/\*\*\/\*\.test\.ts/);
  assert.equal(L("tests/status-json.test.ts", null).reason, undefined, "an unknown layout refuses nothing");
});

test("what counts as tests or test/build config (the low-risk review rule)", () => {
  for (const f of [
    "src/a.test.ts",
    "test/x.js",
    "tests/test_cli.py",
    "vitest.config.ts",
    "package.json",
    "tsconfig.build.json",
    "pyproject.toml",
    "pkg/x_test.go",
  ])
    assert.ok(isTestOrBuildConfig(f), f);
  for (const f of ["src/cli.ts", "server.js", "tasks/cli.py", "README.md", "src/latest.ts"]) assert.ok(!isTestOrBuildConfig(f), f);
});
