// The project's checks, read from its own files without an agent (ADR 0010):
// package.json scripts, Makefile targets, pyproject.toml tool sections, go.mod,
// Cargo.toml. A Makefile with `test` or `check` is the project's own entry point
// and wins; otherwise its usual targets join the other sources. A script or
// target that changes files, watches or starts things (`--fix`, `--write`,
// watch, docker, serve) is never a check. Null when nothing obvious is there:
// quick init then asks one short agent call.
import fs from "node:fs";
import path from "node:path";

export type DetectedCheck = { name: string; run: string };
export type Detected = {
  checks: DetectedCheck[];
  /** A frozen install that readies a fresh worktree (`npm ci`): only with a lockfile. */
  prepare?: string;
  /** The project has dependencies to install but no lockfile: Kitchen never installs then (review M1). */
  unlockedDeps?: boolean;
  /** How a `test <file>` proof runs, when it isn't the default (`npm test -- {file}`). */
  testCmd?: string;
  /** Where each check came from, for the summary: "package.json", "Makefile"… */
  from: string[];
};

const ORDER = ["lint", "typecheck", "test", "build"] as const;
/** A command that changes the tree, never ends, or starts services: not a check. */
const UNSAFE = /--fix\b|--write\b|--watch\b|\bwatch\b|\bdocker\b|\bserve\b/;
export const unsafeCheck = (body: string) => UNSAFE.test(body);

const read = (repo: string, f: string): string | null => {
  try {
    return fs.readFileSync(path.join(repo, f), "utf8");
  } catch {
    return null;
  }
};
const exists = (repo: string, f: string) => fs.existsSync(path.join(repo, f));

/** Pure: the package manager a lockfile names (npm without one), and whether there is a lockfile. */
export function packageManager(files: (f: string) => boolean): { pm: "npm" | "pnpm" | "yarn" | "bun"; locked: boolean } {
  if (files("pnpm-lock.yaml")) return { pm: "pnpm", locked: true };
  if (files("yarn.lock")) return { pm: "yarn", locked: true };
  if (files("bun.lock") || files("bun.lockb")) return { pm: "bun", locked: true };
  return { pm: "npm", locked: files("package-lock.json") || files("npm-shrinkwrap.json") };
}

/** Frozen installs only: the lockfile decides, nothing is resolved anew. */
const FROZEN = { npm: "npm ci", pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --immutable", bun: "bun install --frozen-lockfile" } as const;

const PLACEHOLDER_TEST = /no test specified/;

function fromPackageJson(repo: string): Detected | null {
  const text = read(repo, "package.json");
  if (text === null) return null;
  let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
  try {
    pkg = JSON.parse(text);
  } catch {
    return null;
  }
  const scripts = pkg.scripts ?? {};
  const { pm, locked } = packageManager((f) => exists(repo, f));
  const run = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : pm === "bun" ? `bun run ${s}` : `${pm} ${s}`);
  const alias: Record<(typeof ORDER)[number], string[]> = {
    lint: ["lint"],
    typecheck: ["typecheck", "type-check", "check-types", "types"],
    test: ["test"],
    build: ["build"],
  };
  const checks: DetectedCheck[] = [];
  for (const k of ORDER) {
    const s = alias[k].find((a) => typeof scripts[a] === "string" && !unsafeCheck(scripts[a]) && !(a === "test" && PLACEHOLDER_TEST.test(scripts[a])));
    if (s) checks.push({ name: k, run: run(s) });
  }
  if (!checks.length) return null;
  const deps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
  const testCmd = pm === "npm" ? undefined : `${pm === "bun" ? "bun run" : pm} test {file}`;
  return {
    checks,
    ...(deps && locked ? { prepare: FROZEN[pm] } : {}),
    ...(deps && !locked ? { unlockedDeps: true } : {}),
    ...(testCmd ? { testCmd } : {}),
    from: ["package.json"],
  };
}

/** Pure: the Makefile's usual targets (lint, typecheck, test, build, check) whose recipe is safe to run as a check. */
export function makeTargets(makefile: string): string[] {
  const recipes = new Map<string, string>();
  let cur: string | null = null;
  for (const line of makefile.split("\n")) {
    const m = /^([A-Za-z][\w-]*)\s*:(?!=)(.*)$/.exec(line);
    if (m) {
      cur = m[1];
      recipes.set(cur, `${recipes.get(cur) ?? ""}${m[2]}\n`);
    } else if (cur && /^\t/.test(line)) recipes.set(cur, `${recipes.get(cur)}${line}\n`);
    else if (line.trim() && !line.startsWith("#")) cur = null;
  }
  return [...ORDER, "check"].filter((t) => recipes.has(t) && !unsafeCheck(recipes.get(t) ?? "") && !(t === "check" && recipes.has("typecheck")));
}

function fromMakefile(repo: string): Detected | null {
  const text = read(repo, "Makefile") ?? read(repo, "makefile");
  if (text === null) return null;
  const targets = makeTargets(text);
  return targets.length ? { checks: targets.map((t) => ({ name: t, run: `make ${t}` })), from: ["Makefile"] } : null;
}

function fromPyproject(repo: string): Detected | null {
  const text = read(repo, "pyproject.toml");
  if (text === null) return null;
  // Configured means its own section (`[tool.ruff]`, `[tool.pytest.ini_options]`), not any mention.
  const section = (tool: string) => new RegExp(`^\\[tool\\.${tool}[\\].]`, "m").test(text);
  // The repo's own virtualenv when it has one, so the tools installed there are found.
  const venv = [".venv", "venv"].find((d) => exists(repo, `${d}/bin/python`));
  const runner = exists(repo, "uv.lock") ? "uv run " : exists(repo, "poetry.lock") ? "poetry run " : `${venv ? `${venv}/bin/python` : "python3"} -m `;
  const py = venv ? `${venv}/bin/python` : "python3";
  const checks: DetectedCheck[] = [];
  if (section("ruff") || exists(repo, "ruff.toml")) checks.push({ name: "lint", run: `${runner}ruff check .` });
  if (section("mypy") || exists(repo, "mypy.ini")) checks.push({ name: "typecheck", run: `${runner}mypy .` });
  const testDir = ["tests", "test"].find((d) => fs.existsSync(path.join(repo, d)) && fs.readdirSync(path.join(repo, d)).some((f) => /^test_.*\.py$/.test(f)));
  let testCmd: string | undefined;
  if (section("pytest") || exists(repo, "pytest.ini") || exists(repo, "conftest.py")) {
    checks.push({ name: "test", run: `${runner}pytest -q` });
    testCmd = `${runner}pytest -q {file}`;
  } else if (testDir) {
    // No pytest configured: the standard library's runner finds unittest-style test_*.py files.
    checks.push({ name: "test", run: `${py} -m unittest discover -s ${testDir}` });
    testCmd = `${py} -m unittest {file}`;
  }
  return checks.length ? { checks, ...(testCmd ? { testCmd } : {}), from: ["pyproject.toml"] } : null;
}

function fromGo(repo: string): Detected | null {
  if (!exists(repo, "go.mod")) return null;
  return {
    checks: [
      { name: "vet", run: "go vet ./..." },
      { name: "test", run: "go test ./..." },
    ],
    // A Go test file only runs with its package.
    testCmd: 'go test "./$(dirname {file})"',
    from: ["go.mod"],
  };
}

function fromCargo(repo: string): Detected | null {
  if (!exists(repo, "Cargo.toml")) return null;
  return {
    checks: [
      { name: "build", run: "cargo build --quiet" },
      { name: "test", run: "cargo test --quiet" },
    ],
    // An integration test file (tests/<name>.rs) is its own test target.
    testCmd: 'cargo test --quiet --test "$(basename {file} .rs)"',
    from: ["Cargo.toml"],
  };
}

/** Several sources into one list: names stay unique (`test`, `test-2`), the first prepare and test command win. */
function merge(ds: Detected[]): Detected {
  const seen = new Set<string>();
  const checks = ds
    .flatMap((d) => d.checks)
    .map((c) => {
      let name = c.name;
      for (let i = 2; seen.has(name); i++) name = `${c.name}-${i}`;
      seen.add(name);
      return { ...c, name };
    });
  const prepare = ds.find((d) => d.prepare)?.prepare;
  const testCmd = ds.find((d) => d.testCmd)?.testCmd;
  return {
    checks,
    ...(prepare ? { prepare } : {}),
    ...(ds.some((d) => d.unlockedDeps) ? { unlockedDeps: true } : {}),
    ...(testCmd ? { testCmd } : {}),
    from: ds.flatMap((d) => d.from),
  };
}

/** The checks the repo's own files name, or null when nothing obvious is there. */
export function detectChecks(repo: string): Detected | null {
  const make = fromMakefile(repo);
  const eco = [fromPackageJson(repo), fromPyproject(repo), fromGo(repo), fromCargo(repo)].filter((d): d is Detected => d !== null);
  // A Makefile with test or check is the project's own entry point: it wins (the ecosystem still says how to install and run one test).
  if (make?.checks.some((c) => c.name === "test" || c.name === "check"))
    return { ...merge([make, ...eco.map((d) => ({ ...d, checks: [] }))]), from: ["Makefile"] };
  const all = [...(make ? [make] : []), ...eco];
  return all.length ? merge(all) : null;
}
