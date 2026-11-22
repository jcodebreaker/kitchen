import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { parseConfig } from "../config.ts";
import { detectChecks, makeTargets } from "./detect-checks.ts";
import { checksYaml } from "./files.ts";
import { parseProposal } from "./quick.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-detect-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A fixture repo: file name → content. */
function fixture(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const runs = (dir: string) => detectChecks(dir)?.checks.map((c) => `${c.name}: ${c.run}`);

test("package.json (npm): lint, typecheck, test, build in that order; npm ci when there is a lockfile and dependencies", () => {
  const dir = fixture("npm", {
    "package.json": JSON.stringify({
      scripts: { build: "tsc", test: "vitest run", lint: "biome check .", "type-check": "tsc --noEmit", dev: "vite" },
      devDependencies: { vitest: "1" },
    }),
    "package-lock.json": "{}",
  });
  assert.deepEqual(runs(dir), ["lint: npm run lint", "typecheck: npm run type-check", "test: npm test", "build: npm run build"]);
  const d = detectChecks(dir);
  assert.equal(d?.prepare, "npm ci");
  assert.equal(d?.testCmd, undefined, "the default npm test -- {file} fits");
  assert.deepEqual(d?.from, ["package.json"]);
});

test("package.json: the package manager comes from the lockfile; npm's placeholder test is no check; no dependencies, no prepare", () => {
  const pnpm = fixture("pnpm", {
    "package.json": JSON.stringify({ scripts: { test: "jest", lint: "eslint ." }, dependencies: { a: "1" } }),
    "pnpm-lock.yaml": "",
  });
  assert.deepEqual(runs(pnpm), ["lint: pnpm lint", "test: pnpm test"]);
  assert.equal(detectChecks(pnpm)?.prepare, "pnpm install --frozen-lockfile");
  assert.equal(detectChecks(pnpm)?.testCmd, "pnpm test {file}");
  const yarn = fixture("yarn", { "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "" });
  assert.deepEqual(runs(yarn), ["test: yarn test"]);
  assert.equal(detectChecks(yarn)?.prepare, undefined);
  const placeholder = fixture("placeholder", { "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.equal(detectChecks(placeholder), null);
});

test("Makefile: its usual targets win over the ecosystem's scripts (the project's own entry point)", () => {
  assert.deepEqual(makeTargets("build: deps\n\tgo build\ntest:\n\tgo test ./...\nlint :\n\tgolangci-lint run\nX := 1\n.PHONY: test\n"), [
    "lint",
    "test",
    "build",
  ]);
  assert.deepEqual(makeTargets("check:\n\tcargo clippy\n"), ["check"]);
  const dir = fixture("make", { Makefile: "test:\n\tpytest\nlint:\n\truff check .\n", "pyproject.toml": "[tool.pytest.ini_options]\n" });
  assert.deepEqual(runs(dir), ["lint: make lint", "test: make test"]);
  assert.equal(detectChecks(dir)?.testCmd, "python3 -m pytest -q {file}", "the test command still comes from the ecosystem");
});

test("pyproject.toml: pytest, ruff and mypy when configured (uv/poetry run them); unittest files without pytest", () => {
  const dir = fixture("py", {
    "pyproject.toml": '[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest", "mypy"]\n[tool.ruff]\nline-length = 100\n',
    "uv.lock": "",
  });
  assert.deepEqual(runs(dir), ["lint: uv run ruff check .", "typecheck: uv run mypy .", "test: uv run pytest -q"]);
  assert.equal(detectChecks(dir)?.testCmd, "uv run pytest -q {file}");
  const unit = fixture("py-unittest", { "pyproject.toml": '[project]\nname = "b"\ndependencies = []\n', "tests/test_cli.py": "import unittest\n" });
  assert.deepEqual(runs(unit), ["test: python3 -m unittest discover -s tests"]);
  assert.equal(detectChecks(unit)?.testCmd, "python3 -m unittest {file}");
  assert.equal(detectChecks(fixture("py-bare", { "pyproject.toml": '[project]\nname = "c"\n' })), null, "nothing configured: the agent is asked");
});

test("go.mod and Cargo.toml: their standard commands", () => {
  assert.deepEqual(runs(fixture("go", { "go.mod": "module x\n" })), ["vet: go vet ./...", "test: go test ./..."]);
  assert.deepEqual(runs(fixture("rust", { "Cargo.toml": "[package]\nname='x'\n" })), ["build: cargo build --quiet", "test: cargo test --quiet"]);
});

test("two ecosystems in one repo: both, with unique names; nothing obvious: null", () => {
  const dir = fixture("mixed", { "package.json": JSON.stringify({ scripts: { test: "vitest" } }), "go.mod": "module x\n" });
  assert.deepEqual(runs(dir), ["test: npm test", "vet: go vet ./...", "test-2: go test ./..."]);
  assert.equal(detectChecks(fixture("empty", { "README.md": "hi" })), null);
});

test("the checks block kitchen.yaml gets parses as config (quoting included)", () => {
  const d = detectChecks(
    fixture("yaml", { "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint 'src/**'" }, dependencies: { a: "1" } }) }),
  );
  assert.ok(d);
  const cfg = parseConfig(`version: 1\n${checksYaml(d)}`);
  assert.deepEqual(
    cfg.checkList.map((c) => [c.name, c.run]),
    [
      ["lint", "npm run lint"],
      ["test", "npm test"],
    ],
  );
  assert.equal(cfg.checks_prepare, "npm install");
  assert.equal(cfg.checks_network, true);
});

test("the agent's proposal (checks.md) when nothing is obvious: at most 4 checks, none when it names none", () => {
  const d = parseProposal("CHECK: test | ./scripts/test.sh\nCHECK: lint | make -C tools lint\nPREPARE: none\nTEST_CMD: ./scripts/test.sh {file}\n");
  assert.deepEqual(d?.checks, [
    { name: "test", run: "./scripts/test.sh" },
    { name: "lint", run: "make -C tools lint" },
  ]);
  assert.equal(d?.prepare, undefined);
  assert.equal(d?.testCmd, "./scripts/test.sh {file}");
  assert.equal(parseProposal("PREPARE: none\nTEST_CMD: none\n"), null);
});
