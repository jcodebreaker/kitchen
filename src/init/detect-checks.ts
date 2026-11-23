// The project's checks, read from its own files without an agent (ADR 0010):
// package.json scripts, Makefile targets, pyproject.toml tool sections, go.mod,
// Cargo.toml. A Makefile with `test` or `check` is the project's own entry point
// and wins; otherwise its usual targets join the other sources. A script or
// target that changes files, watches or starts things (`--fix`, `--write`,
// watch, docker, serve) is never a check. Null when nothing obvious is there:
// quick init then asks one short agent call.
import fs from "node:fs";
import path from "node:path";
import type { PackageManager } from "../checks/run-checks.ts";

export type DetectedCheck = { name: string; run: string };
export type Detected = {
  checks: DetectedCheck[];
  /** The package manager of a frozen install from the lockfile (kitchen.yaml `checks_install`): only with a lockfile. */
  install?: PackageManager;
  /** Scripts or targets left out because they aren't safe as a check, with why (said at init, review R6). */
  skipped?: { name: string; body: string; why: string }[];
  /** The project has dependencies to install but no lockfile: Kitchen never installs then (review M1). */
  unlockedDeps?: boolean;
  /** How a `test <file>` proof runs, when it isn't the default (`npm test -- {file}`). */
  testCmd?: string;
  /** Where each check came from, for the summary: "package.json", "Makefile"… */
  from: string[];
};

const ORDER = ["lint", "typecheck", "test", "build"] as const;
/** What makes a command unsafe as a check (it changes the tree, never ends, or starts things), and the words for it. */
const UNSAFE: [RegExp, string][] = [
  [/(?<![\w-])--(fix|write)(?![\w-])/, "changes files"],
  // `watch` and `--watch`, never `--no-watch`.
  [/(?<![\w-])(--)?watch(?![\w-])/, "never ends"],
  [/(?<![\w-])docker(?![\w-])/, "starts containers"],
  [/(?<![\w-])serve(?![\w-])/, "starts a server"],
];
/** Pure: why a command is no check, or null. */
export const unsafeCheck = (body: string): string | null => UNSAFE.find(([re]) => re.test(body))?.[1] ?? null;

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

/**
 * Yarn Berry (2+), not Yarn 1: a `.yarnrc.yml`, a `__metadata:` block in yarn.lock, or `packageManager: "yarn@2+"`.
 * Yarn 1 ignores Berry's install flags (it would run every postinstall while it downloads, review Y1).
 */
export function yarnBerry(repo: string): boolean {
  if (exists(repo, ".yarnrc.yml")) return true;
  if (/^__metadata:/m.test(read(repo, "yarn.lock") ?? "")) return true;
  try {
    const pm = (JSON.parse(read(repo, "package.json") ?? "{}") as { packageManager?: string }).packageManager ?? "";
    return /^yarn@([2-9]|\d{2,})\./.test(pm);
  } catch {
    return false;
  }
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
  const found = packageManager((f) => exists(repo, f));
  const { locked } = found;
  // Yarn 1 fails under the sandbox on reading ~/.npmrc; `npm run` runs the same scripts on the node_modules it made.
  const classic = found.pm === "yarn" && !yarnBerry(repo);
  const pm = classic ? "npm" : found.pm;
  const run = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : pm === "bun" ? `bun run ${s}` : `${pm} ${s}`);
  const alias: Record<(typeof ORDER)[number], string[]> = {
    lint: ["lint"],
    typecheck: ["typecheck", "type-check", "check-types", "types"],
    test: ["test"],
    build: ["build"],
  };
  const checks: DetectedCheck[] = [];
  const skipped: NonNullable<Detected["skipped"]> = [];
  for (const k of ORDER) {
    const have = alias[k].filter((a) => typeof scripts[a] === "string" && !(a === "test" && PLACEHOLDER_TEST.test(scripts[a])));
    const s = have.find((a) => !unsafeCheck(scripts[a]));
    if (s) checks.push({ name: k, run: run(s) });
    else for (const a of have) skipped.push({ name: k, body: scripts[a], why: unsafeCheck(scripts[a]) as string });
  }
  if (!checks.length) return skipped.length ? { checks, skipped, from: ["package.json"] } : null;
  const deps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
  const testCmd = pm === "npm" ? undefined : `${pm === "bun" ? "bun run" : pm} test {file}`;
  return {
    checks,
    ...(deps && locked ? { install: classic ? "yarn-classic" : pm } : {}),
    ...(skipped.length ? { skipped } : {}),
    ...(deps && !locked ? { unlockedDeps: true } : {}),
    ...(testCmd ? { testCmd } : {}),
    from: ["package.json"],
  };
}

/** Pure: each target's recipe lines and prerequisites. */
function makeRules(makefile: string): Map<string, { recipe: string; deps: string[] }> {
  const rules = new Map<string, { recipe: string; deps: string[] }>();
  let cur: string | null = null;
  for (const line of makefile.split("\n")) {
    const m = /^([A-Za-z][\w.-]*)\s*:(?!=)([^;]*)(?:;(.*))?$/.exec(line);
    if (m) {
      cur = m[1];
      const r = rules.get(cur) ?? { recipe: "", deps: [] };
      r.deps.push(...m[2].split(/\s+/).filter(Boolean));
      if (m[3]) r.recipe += `${m[3]}\n`;
      rules.set(cur, r);
    } else if (cur && /^\t/.test(line)) (rules.get(cur) as { recipe: string }).recipe += `${line}\n`;
    else if (line.trim() && !line.startsWith("#")) cur = null;
  }
  return rules;
}

/**
 * Pure: the usual targets (lint, typecheck, test, build, check) and why each is unsafe, or null when it is safe. A
 * target is as unsafe as anything it depends on (`test: image` where `image` runs docker, review R7).
 */
export function makeTargetSafety(makefile: string): { target: string; why: string | null; body: string }[] {
  const rules = makeRules(makefile);
  const why = (t: string, seen: Set<string>): { why: string | null; body: string } => {
    const r = rules.get(t);
    if (!r || seen.has(t)) return { why: null, body: "" };
    seen.add(t);
    const own = unsafeCheck(r.recipe) ?? unsafeCheck(r.deps.join(" "));
    if (own) return { why: own, body: (r.recipe.trim() || `${t}: ${r.deps.join(" ")}`).split("\n")[0] };
    for (const d of r.deps) {
      const w = why(d, seen);
      if (w.why) return { why: `${w.why} (through ${d})`, body: w.body };
    }
    return { why: null, body: "" };
  };
  return [...ORDER, "check"].filter((t) => rules.has(t) && !(t === "check" && rules.has("typecheck"))).map((t) => ({ target: t, ...why(t, new Set()) }));
}

/** Pure: the usual targets that are safe to run as a check. */
export const makeTargets = (makefile: string): string[] =>
  makeTargetSafety(makefile)
    .filter((t) => !t.why)
    .map((t) => t.target);

function fromMakefile(repo: string): Detected | null {
  const text = read(repo, "Makefile") ?? read(repo, "makefile");
  if (text === null) return null;
  const all = makeTargetSafety(text);
  const ok = all.filter((t) => !t.why);
  const skipped = all.filter((t) => t.why).map((t) => ({ name: `make ${t.target}`, body: t.body, why: t.why as string }));
  if (!ok.length && !skipped.length) return null;
  return { checks: ok.map((t) => ({ name: t.target, run: `make ${t.target}` })), ...(skipped.length ? { skipped } : {}), from: ["Makefile"] };
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
  const install = ds.find((d) => d.install)?.install;
  const testCmd = ds.find((d) => d.testCmd)?.testCmd;
  const skipped = ds.flatMap((d) => d.skipped ?? []);
  return {
    checks,
    ...(install ? { install } : {}),
    ...(skipped.length ? { skipped } : {}),
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
    return { ...merge([make, ...eco.map((d) => ({ ...d, checks: [], skipped: [] }))]), from: ["Makefile"] };
  const all = [...(make ? [make] : []), ...eco];
  return all.length ? merge(all) : null;
}
