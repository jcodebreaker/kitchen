// The project's checks, read from its own files without an agent (ADR 0010):
// package.json scripts, Makefile targets, pyproject.toml, go.mod, Cargo.toml.
// A Makefile with any of the usual targets wins (it is the project's own entry
// point); otherwise every ecosystem found adds its checks. Null when nothing
// obvious is there: quick init then asks one short agent call.
import fs from "node:fs";
import path from "node:path";

export type DetectedCheck = { name: string; run: string };
export type Detected = {
  checks: DetectedCheck[];
  /** Readies a fresh worktree (`npm ci`): set when the project has dependencies to install. */
  prepare?: string;
  /** How a `test <file>` proof runs, when it isn't the default (`npm test -- {file}`). */
  testCmd?: string;
  /** Where each check came from, for the summary: "package.json", "Makefile"… */
  from: string[];
};

const ORDER = ["lint", "typecheck", "test", "build"] as const;
const read = (repo: string, f: string): string | null => {
  try {
    return fs.readFileSync(path.join(repo, f), "utf8");
  } catch {
    return null;
  }
};
const exists = (repo: string, f: string) => fs.existsSync(path.join(repo, f));

/** Pure: the package manager a lockfile names (npm without one). */
export function packageManager(files: (f: string) => boolean): "npm" | "pnpm" | "yarn" | "bun" {
  if (files("pnpm-lock.yaml")) return "pnpm";
  if (files("yarn.lock")) return "yarn";
  if (files("bun.lock") || files("bun.lockb")) return "bun";
  return "npm";
}

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
  const pm = packageManager((f) => exists(repo, f));
  const run = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : pm === "bun" ? `bun run ${s}` : `${pm} ${s}`);
  const alias: Record<(typeof ORDER)[number], string[]> = {
    lint: ["lint"],
    typecheck: ["typecheck", "type-check", "check-types", "types"],
    test: ["test"],
    build: ["build"],
  };
  const checks: DetectedCheck[] = [];
  for (const k of ORDER) {
    const s = alias[k].find((a) => typeof scripts[a] === "string" && !(a === "test" && PLACEHOLDER_TEST.test(scripts[a])));
    if (s) checks.push({ name: k, run: run(s) });
  }
  const deps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
  const lock = exists(repo, "package-lock.json") || exists(repo, "npm-shrinkwrap.json");
  const prepare = !deps
    ? undefined
    : pm === "npm"
      ? lock
        ? "npm ci"
        : "npm install"
      : pm === "bun"
        ? "bun install --frozen-lockfile"
        : `${pm} install --frozen-lockfile`;
  const testCmd = pm === "npm" ? undefined : `${pm === "bun" ? "bun run" : pm} test {file}`;
  return checks.length ? { checks, ...(prepare ? { prepare } : {}), ...(testCmd ? { testCmd } : {}), from: ["package.json"] } : null;
}

/** Pure: the Makefile's targets among lint, typecheck (or check), test and build. */
export function makeTargets(makefile: string): string[] {
  const have = new Set([...makefile.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((m) => m[1]));
  return [...ORDER, "check"].filter((t) => have.has(t) && !(t === "check" && have.has("typecheck")));
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
  const uses = (tool: string) => new RegExp(`^\\[tool\\.${tool}[\\].]|["'\\s]${tool}\\b`, "m").test(text);
  const runner = exists(repo, "uv.lock") ? "uv run " : exists(repo, "poetry.lock") ? "poetry run " : "python3 -m ";
  const checks: DetectedCheck[] = [];
  if (uses("ruff")) checks.push({ name: "lint", run: `${runner}ruff check .` });
  if (uses("mypy")) checks.push({ name: "typecheck", run: `${runner}mypy .` });
  const testDir = ["tests", "test"].find((d) => fs.existsSync(path.join(repo, d)) && fs.readdirSync(path.join(repo, d)).some((f) => /^test_.*\.py$/.test(f)));
  let testCmd: string | undefined;
  if (uses("pytest")) {
    checks.push({ name: "test", run: `${runner}pytest -q` });
    testCmd = `${runner}pytest -q {file}`;
  } else if (testDir) {
    // No pytest configured: the standard library's runner finds unittest-style test_*.py files.
    checks.push({ name: "test", run: `python3 -m unittest discover -s ${testDir}` });
    testCmd = "python3 -m unittest {file}";
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

/** The checks the repo's own files name, or null when nothing obvious is there. */
export function detectChecks(repo: string): Detected | null {
  const make = fromMakefile(repo);
  const eco = [fromPackageJson(repo), fromPyproject(repo), fromGo(repo), fromCargo(repo)].filter((d): d is Detected => d !== null);
  if (make) return { ...make, ...(eco[0]?.prepare ? { prepare: eco[0].prepare } : {}), ...(eco[0]?.testCmd ? { testCmd: eco[0].testCmd } : {}) };
  if (!eco.length) return null;
  const seen = new Set<string>();
  const checks = eco
    .flatMap((d) => d.checks)
    .map((c) => {
      // Two ecosystems that both have a `test`: the second is `test-2`, so names stay unique.
      let name = c.name;
      for (let i = 2; seen.has(name); i++) name = `${c.name}-${i}`;
      seen.add(name);
      return { ...c, name };
    });
  const prepare = eco.find((d) => d.prepare)?.prepare;
  const testCmd = eco.find((d) => d.testCmd)?.testCmd;
  return { checks, ...(prepare ? { prepare } : {}), ...(testCmd ? { testCmd } : {}), from: eco.flatMap((d) => d.from) };
}
