import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { parseConfig } from "../config.ts";
import { detectChecks, makeTargetSafety, makeTargets, unsafeCheck } from "./detect-checks.ts";
import { checksYaml } from "./files.ts";

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
  assert.equal(d?.install, "npm");
  assert.equal(d?.testCmd, undefined, "the default npm test -- {file} fits");
  assert.deepEqual(d?.from, ["package.json"]);
});

test("package.json: the package manager comes from the lockfile; npm's placeholder test is no check; no dependencies, no prepare", () => {
  const pnpm = fixture("pnpm", {
    "package.json": JSON.stringify({ scripts: { test: "jest", lint: "eslint ." }, dependencies: { a: "1" } }),
    "pnpm-lock.yaml": "",
  });
  assert.deepEqual(runs(pnpm), ["lint: pnpm lint", "test: pnpm test"]);
  assert.equal(detectChecks(pnpm)?.install, "pnpm");
  assert.equal(detectChecks(pnpm)?.testCmd, "pnpm test {file}");
  const yarn = fixture("yarn", { "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "" });
  assert.deepEqual(runs(yarn), ["test: npm test"], "Yarn 1 (no Berry marker): its scripts run through npm");
  assert.equal(detectChecks(yarn)?.install, undefined);
  const placeholder = fixture("placeholder", { "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.equal(detectChecks(placeholder), null);
});

test("frozen installs only: no lockfile, no install (review M1); yarn is --immutable", () => {
  const loose = fixture("npm-unlocked", { "package.json": JSON.stringify({ scripts: { test: "vitest" }, devDependencies: { vitest: "1" } }) });
  assert.equal(detectChecks(loose)?.install, undefined);
  assert.equal(detectChecks(loose)?.unlockedDeps, true);
  const yarn = fixture("yarn-deps", { "package.json": JSON.stringify({ scripts: { test: "jest" }, dependencies: { a: "1" } }), "yarn.lock": "" });
  assert.equal(detectChecks(yarn)?.install, "yarn-classic", "an empty yarn.lock is no Berry lockfile: Yarn 1");
});

test("scripts and targets that change files, watch or start things are never checks (review M2)", () => {
  const dir = fixture("unsafe", {
    "package.json": JSON.stringify({
      scripts: { lint: "eslint . --fix", typecheck: "tsc --noEmit --watch", test: "vitest watch", build: "docker build ." },
    }),
  });
  assert.deepEqual(detectChecks(dir)?.checks, []);
  // Each one named, with why, so init can say what it left out (review R6).
  assert.deepEqual(
    detectChecks(dir)?.skipped?.map((x) => `${x.name} (\`${x.body}\` ${x.why})`),
    [
      "lint (`eslint . --fix` changes files)",
      "typecheck (`tsc --noEmit --watch` never ends)",
      "test (`vitest watch` never ends)",
      "build (`docker build .` starts containers)",
    ],
  );
  // `--no-watch` and `--fix-dry-run` change nothing and end.
  assert.deepEqual(runs(fixture("safe-flags", { "package.json": JSON.stringify({ scripts: { lint: "eslint . --fix-dry-run", test: "jest --no-watch" } }) })), [
    "lint: npm run lint",
    "test: npm test",
  ]);
  const fmt = fixture("unsafe-2", { "package.json": JSON.stringify({ scripts: { lint: "prettier --write .", test: "node --test" } }) });
  assert.deepEqual(runs(fmt), ["test: npm test"]);
  assert.deepEqual(makeTargets("test:\n\tdocker compose run app pytest\nlint:\n\truff check .\nbuild: serve\n"), ["lint"]);
  // A target is as unsafe as what it depends on (review R7).
  const mk = "image:\n\tdocker build -t app .\nunit: image\n\tpytest\ntest: unit\n\t@echo done\nlint:\n\truff check .\n";
  assert.deepEqual(makeTargets(mk), ["lint"]);
  assert.deepEqual(makeTargetSafety(mk).find((t) => t.target === "test")?.why, "starts containers (through image) (through unit)");
});

test("Makefile: with test or check it wins (the project's own entry point); otherwise its targets join the others (review M2)", () => {
  assert.deepEqual(makeTargets("build: deps\n\tgo build\ntest:\n\tgo test ./...\nlint :\n\tgolangci-lint run\nX := 1\n.PHONY: test\n"), [
    "lint",
    "test",
    "build",
  ]);
  assert.deepEqual(makeTargets("check:\n\tcargo clippy\n"), ["check"]);
  const dir = fixture("make", { Makefile: "test:\n\tpytest\nlint:\n\truff check .\n", "pyproject.toml": "[tool.pytest.ini_options]\n" });
  assert.deepEqual(runs(dir), ["lint: make lint", "test: make test"]);
  assert.equal(detectChecks(dir)?.testCmd, "python3 -m pytest -q {file}", "the test command still comes from the ecosystem");
  const lintOnly = fixture("make-lint", { Makefile: "lint:\n\tgolangci-lint run\n", "go.mod": "module x\n" });
  assert.deepEqual(runs(lintOnly), ["lint: make lint", "vet: go vet ./...", "test: go test ./..."]);
});

test("pyproject.toml: pytest, ruff and mypy when they have their own section (uv/poetry/.venv run them); unittest files without pytest", () => {
  const dir = fixture("py", {
    "pyproject.toml": '[project]\nname = "x"\n[tool.mypy]\nstrict = true\n[tool.pytest.ini_options]\nx = 1\n[tool.ruff]\nline-length = 100\n',
    "uv.lock": "",
  });
  assert.deepEqual(runs(dir), ["lint: uv run ruff check .", "typecheck: uv run mypy .", "test: uv run pytest -q"]);
  assert.equal(detectChecks(dir)?.testCmd, "uv run pytest -q {file}");
  const unit = fixture("py-unittest", { "pyproject.toml": '[project]\nname = "b"\ndependencies = []\n', "tests/test_cli.py": "import unittest\n" });
  assert.deepEqual(runs(unit), ["test: python3 -m unittest discover -s tests"]);
  assert.equal(detectChecks(unit)?.testCmd, "python3 -m unittest {file}");
  assert.equal(detectChecks(fixture("py-bare", { "pyproject.toml": '[project]\nname = "c"\n' })), null, "nothing configured: the agent is asked");
  // A mention in the dependencies is not a configuration (review L6).
  assert.equal(detectChecks(fixture("py-mention", { "pyproject.toml": '[project]\nname = "d"\ndependencies = ["pytest", "ruff", "mypy"]\n' })), null);
  const venv = fixture("py-venv", { "pyproject.toml": "[tool.pytest.ini_options]\n", ".venv/bin/python": "" });
  assert.deepEqual(runs(venv), ["test: .venv/bin/python -m pytest -q"]);
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
  assert.equal(cfg.checks_install, undefined, "no lockfile: never installed");
  const locked = detectChecks(
    fixture("yaml-lock", { "package.json": JSON.stringify({ scripts: { test: "node --test" }, dependencies: { a: "1" } }), "package-lock.json": "{}" }),
  );
  assert.ok(locked);
  const c2 = parseConfig(`version: 1\n${checksYaml(locked)}`);
  assert.equal(c2.checks_install, "npm");
  assert.equal(c2.checks_prepare, undefined);
  // Proposed by an agent and not accepted: commented out, so the config has no checks (review H1).
  const proposed = parseConfig(`version: 1\n${checksYaml(locked, { proposed: true })}`);
  assert.deepEqual(proposed.checkList, []);
  assert.equal(proposed.checks_install, undefined);
});

test("a 200-character command round-trips through kitchen.yaml, accepted or proposed (commented), on one line (review R1)", () => {
  const long = `node scripts/check.mjs ${"--flag-with-a-long-name=value ".repeat(6).trim()} && echo "it's \\"quoted\\": yes"`;
  assert.ok(long.length >= 200, String(long.length));
  const d = { checks: [{ name: "check", run: long }], testCmd: `${long} {file}`, from: ["x"] };
  const yaml = checksYaml(d);
  assert.ok(
    yaml.split("\n").every((l) => !l.startsWith("  ") || l.startsWith("  - {")),
    yaml,
  );
  const cfg = parseConfig(`version: 1\n${yaml}`);
  assert.equal(cfg.checkList[0].run, long);
  const proposed = checksYaml(d, { proposed: true });
  assert.ok(
    proposed.split("\n").every((l) => l === "" || l.startsWith("#")),
    proposed,
  );
  assert.deepEqual(parseConfig(`version: 1\n${proposed}`).checkList, []);
  // Uncommenting gives the same, valid config.
  const uncommented = proposed
    .split("\n")
    .map((l) => l.replace(/^# (?=checks:| {2}- |test_cmd:|checks_install:)/, ""))
    .join("\n");
  assert.equal(parseConfig(`version: 1\n${uncommented}`).checkList[0].run, long);
  assert.equal(unsafeCheck(long), null);
});

test("Yarn 1 or Berry decides the install: Berry by .yarnrc.yml, a __metadata block or packageManager yarn@2+ (review Y1)", () => {
  const pkg = JSON.stringify({ scripts: { test: "jest" }, dependencies: { a: "1" } });
  const v1 = fixture("yarn-v1", {
    "package.json": pkg,
    "yarn.lock": '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\na@1:\n  version "1.0.0"\n',
  });
  assert.equal(detectChecks(v1)?.install, "yarn-classic");
  assert.deepEqual(runs(v1), ["test: npm test"], "Yarn 1's scripts run through npm (Yarn 1 fails on the sandbox's EPERM on ~/.npmrc)");
  const berry = fixture("yarn-berry", {
    "package.json": pkg,
    "yarn.lock": '# This file is generated by running "yarn install"\n\n__metadata:\n  version: 8\n  cacheKey: 10c0\n',
  });
  assert.equal(detectChecks(berry)?.install, "yarn");
  assert.equal(detectChecks(fixture("yarn-rc", { "package.json": pkg, "yarn.lock": "", ".yarnrc.yml": "nodeLinker: node-modules\n" }))?.install, "yarn");
  const pm4 = fixture("yarn-pm", { "package.json": JSON.stringify({ ...JSON.parse(pkg), packageManager: "yarn@4.5.0" }), "yarn.lock": "" });
  assert.equal(detectChecks(pm4)?.install, "yarn");
  const pm1 = fixture("yarn-pm1", { "package.json": JSON.stringify({ ...JSON.parse(pkg), packageManager: "yarn@1.22.22" }), "yarn.lock": "" });
  assert.equal(detectChecks(pm1)?.install, "yarn-classic");
  assert.equal(parseConfig("checks_install: yarn-classic\n").checks_install, "yarn-classic");
});
