// The project's checks, read from its own files without an agent (ADR 0010):
// package.json scripts, Makefile targets, pyproject.toml tool sections, go.mod,
// Cargo.toml. A Makefile with `test` or `check` is the project's own entry point
// and wins; otherwise its usual targets join the other sources. A script or
// target that changes files, watches or starts things (`--fix`, `--write`,
// watch, docker, serve) is never a check. Null when nothing obvious is there:
// quick init then asks one short agent call.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PackageManager } from "../checks/run-checks.ts";

export type DetectedCheck = { name: string; run: string; when?: "merge"; needsApp?: boolean; timeoutSec?: number };
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

/** package.json scripts that run an end-to-end suite, best first (ADR 0021 §1). */
const E2E_SCRIPTS = ["test:e2e", "e2e", "test:integration", "cy:run"];
const CONFIG_EXT = ["ts", "js", "mjs", "cjs"];
/**
 * Pure: why an end-to-end command is no check, or null. It runs only on the trial merge (`when: merge`), a scratch
 * worktree Kitchen throws away, with nothing else running from it: starting containers is how many suites bring up
 * their database, so `docker` / `compose` is allowed there. Changing files, watching and serving are not.
 */
export const unsafeE2e = (body: string): string | null => {
  const why = unsafeCheck(body);
  return why === "starts containers" ? null : why;
};

/**
 * The project's end-to-end suite as a `when: merge` check, or why it was skipped: a script (`test:e2e`, `e2e`,
 * `test:integration`, `cy:run`), else a Playwright or Cypress config, else a Makefile `e2e` / `integration` target.
 * `needs_app` is set by init, which knows whether there is an app to start.
 */
export function detectE2e(repo: string): { check?: DetectedCheck; skipped?: { name: string; body: string; why: string }; from?: string } {
  const e2e = (run: string): DetectedCheck => ({ name: "e2e", run, when: "merge", timeoutSec: 900 });
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(read(repo, "package.json") ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {}
  const s = E2E_SCRIPTS.find((k) => typeof scripts[k] === "string");
  if (s) {
    const why = unsafeE2e(scripts[s]);
    if (why) return { skipped: { name: "e2e", body: scripts[s], why } };
    const found = packageManager((f) => exists(repo, f));
    const pm = found.pm === "yarn" && !yarnBerry(repo) ? "npm" : found.pm;
    return { check: e2e(pm === "npm" ? `npm run ${s}` : pm === "bun" ? `bun run ${s}` : `${pm} ${s}`), from: "package.json" };
  }
  const cfgFile = (tool: string) => CONFIG_EXT.map((x) => `${tool}.config.${x}`).find((f) => exists(repo, f));
  const pw = cfgFile("playwright");
  if (pw) return { check: e2e("npx playwright test"), from: pw };
  const cy = cfgFile("cypress");
  if (cy) return { check: e2e("npx cypress run"), from: cy };
  const mk = read(repo, "Makefile") ?? read(repo, "makefile");
  if (mk) {
    const rules = makeRules(mk);
    const t = ["e2e", "integration"].find((x) => rules.has(x));
    if (t) {
      const r = rules.get(t) as { recipe: string; deps: string[] };
      const why = unsafeE2e(`${r.recipe} ${r.deps.join(" ")}`);
      if (why) return { skipped: { name: `make ${t}`, body: r.recipe.trim().split("\n")[0] ?? "", why } };
      return { check: e2e(`make ${t}`), from: "Makefile" };
    }
  }
  return {};
}

/** The checks the repo's own files name, or null when nothing obvious is there. The e2e suite comes last, `when: merge`. */
export function detectChecks(repo: string): Detected | null {
  const d = unitChecks(repo);
  const e = detectE2e(repo);
  if (!e.check && !e.skipped) return d;
  const base: Detected = d ?? { checks: [], from: [] };
  return {
    ...base,
    checks: e.check ? [...base.checks, e.check] : base.checks,
    ...(e.skipped ? { skipped: [...(base.skipped ?? []), e.skipped] } : {}),
    from: e.from && !base.from.includes(e.from) ? [...base.from, e.from] : base.from,
  };
}

/**
 * ADR 0032 §4: each language the repo has, and its end-to-end suite, on its own (the Report's "What was checked" says
 * which one no kitchen.yaml check covers): its label, the file it was read from, the checks it names. A Makefile is an
 * entry point, not a language: it isn't one.
 */
export function detectSources(repo: string): { label: string; from: string; checks: DetectedCheck[] }[] {
  const named: [string, Detected | null][] = [
    ["node", fromPackageJson(repo)],
    ["python", fromPyproject(repo)],
    ["go", fromGo(repo)],
    ["rust", fromCargo(repo)],
  ];
  const out = named.flatMap(([label, d]) => (d?.checks.length ? [{ label, from: d.from[0] ?? "", checks: d.checks }] : []));
  const e = detectE2e(repo);
  if (e.check) out.push({ label: "end-to-end", from: e.from ?? "", checks: [e.check] });
  return out;
}

function unitChecks(repo: string): Detected | null {
  const make = fromMakefile(repo);
  const eco = [fromPackageJson(repo), fromPyproject(repo), fromGo(repo), fromCargo(repo)].filter((d): d is Detected => d !== null);
  // A Makefile with test or check is the project's own entry point: it wins (the ecosystem still says how to install and run one test).
  if (make?.checks.some((c) => c.name === "test" || c.name === "check"))
    return { ...merge([make, ...eco.map((d) => ({ ...d, checks: [], skipped: [] }))]), from: ["Makefile"] };
  const all = [...(make ? [make] : []), ...eco];
  return all.length ? merge(all) : null;
}

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

/**
 * Pure: the host ports a compose file publishes as fixed numbers (`"5432:5432"`, `127.0.0.1:3000:3000`, long syntax
 * `published: 3000`), as `service: spec`. Two jobs' stacks can't both bind one; `${PORT}:3000` can (ADR 0021 §4).
 */
export function fixedComposePorts(text: string): string[] {
  let doc: { services?: Record<string, { ports?: unknown[] }> };
  try {
    doc = (parseYaml(text) ?? {}) as typeof doc;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [svc, def] of Object.entries(doc.services ?? {})) {
    for (const p of Array.isArray(def?.ports) ? def.ports : []) {
      if (p && typeof p === "object") {
        const pub = (p as { published?: unknown }).published;
        if (pub !== undefined && /^\d+(-\d+)?$/.test(String(pub))) out.push(`${svc}: published ${pub}`);
        continue;
      }
      const spec = String(p);
      if (spec.includes("$")) continue;
      // [ip:]host:container[/proto]: a host part that is a number (or a range) is fixed; a bare container port is not.
      const parts = spec.replace(/\/\w+$/, "").split(":");
      if (parts.length >= 2 && /^\d+(-\d+)?$/.test(parts[parts.length - 2])) out.push(`${svc}: "${spec}"`);
    }
  }
  return out;
}

/** The compose file and its fixed published ports, when there is one that has any. */
export function composeWarning(repo: string): { file: string; ports: string[] } | null {
  for (const f of COMPOSE_FILES) {
    const t = read(repo, f);
    if (t === null) continue;
    const ports = fixedComposePorts(t);
    return ports.length ? { file: f, ports } : null;
  }
  return null;
}
