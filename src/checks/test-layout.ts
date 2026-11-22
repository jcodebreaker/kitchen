// Where a repo's tests live (dogfood finding 3: test proofs ignored the layout,
// and the builder widened vitest's `include` to run them). Read from the test
// runner's own config: vitest/jest config files or package.json `jest`, pytest's
// ini sections, a mocharc, else the runner `scripts.test` or kitchen.yaml's
// `test_cmd` names, with that runner's default globs. Null when no runner is
// recognised: then nothing is refused. Also what counts as a test file or a
// test/build config file (the builder policy, the low-risk review rule).
import fs from "node:fs";
import path from "node:path";

export type TestLayout = { runner: string; globs: string[]; source: string };

const JS = "{js,mjs,cjs,ts,mts,cts,jsx,tsx}";
export const DEFAULT_GLOBS: Record<string, string[]> = {
  vitest: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  jest: [`**/__tests__/**/*.${JS}`, `**/*.{test,spec}.${JS}`],
  "node --test": [
    "**/*.test.{js,mjs,cjs}",
    "**/*-test.{js,mjs,cjs}",
    "**/*_test.{js,mjs,cjs}",
    "**/test-*.{js,mjs,cjs}",
    "**/test.{js,mjs,cjs}",
    "**/test/**/*.{js,mjs,cjs}",
  ],
  mocha: ["test/*.{js,cjs,mjs}"],
  pytest: ["**/test_*.py", "**/*_test.py"],
  unittest: ["**/test*.py"],
};

/** String literals of the array after `key:` / `key =` in a config file's text (`include: ["src/**\/*.test.ts"]`). Pure. */
export function arrayAfter(text: string, key: string): string[] | null {
  const m = new RegExp(`\\b${key}["']?\\s*[:=]\\s*\\[([^\\]]*)\\]`).exec(text);
  if (!m) return null;
  const out = [...m[1].matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2]);
  return out.length ? out : null;
}

/** An ini section's `key = a b` (or one per line) values. Pure. */
export function iniValues(text: string, section: string, key: string): string[] | null {
  const lines = text.split("\n");
  let inSec = false;
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (h) {
      inSec = h[1].trim() === section;
      continue;
    }
    if (!inSec) continue;
    const kv = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(lines[i]);
    if (!kv) continue;
    let v = kv[1];
    // pyproject: a TOML array; ini: space-separated, maybe continued on indented lines.
    if (v.trim().startsWith("[")) return arrayAfter(`${key} = ${v}${lines.slice(i + 1).join("\n")}`, key);
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !/=/.test(lines[j]); j++) v += ` ${lines[j]}`;
    const out = v.split(/[\s,]+/).filter(Boolean);
    return out.length ? out : null;
  }
  return null;
}

const read = (dir: string, f: string) => {
  try {
    return fs.readFileSync(path.join(dir, f), "utf8");
  } catch {
    return null;
  }
};
const firstFile = (dir: string, names: string[]) => names.find((f) => fs.existsSync(path.join(dir, f))) ?? null;
const asDirGlob = (p: string) => (/[*?{[]/.test(p) ? p : p.replace(/^\.\//, "").replace(/\/$/, "").concat("/**"));

function pytestLayout(dir: string): TestLayout | null {
  for (const [file, section] of [
    ["pytest.ini", "pytest"],
    ["pyproject.toml", "tool.pytest.ini_options"],
    ["tox.ini", "pytest"],
    ["setup.cfg", "tool:pytest"],
  ] as const) {
    const t = read(dir, file);
    if (!t || !new RegExp(`^\\s*\\[${section.replace(/[.:]/g, "\\$&")}\\]`, "m").test(t)) continue;
    const files = iniValues(t, section, "python_files") ?? ["test_*.py", "*_test.py"];
    const paths = iniValues(t, section, "testpaths");
    const globs = paths ? paths.flatMap((p) => files.map((f) => `${asDirGlob(p)}/${f}`)) : files.map((f) => `**/${f}`);
    return { runner: "pytest", globs, source: file };
  }
  return null;
}

/** The runner a command line names (`npm test`, `npx vitest run {file}`, `python3 -m unittest`), or null. */
export function runnerOf(cmd: string): string | null {
  if (/\bvitest\b/.test(cmd)) return "vitest";
  if (/\bjest\b/.test(cmd)) return "jest";
  if (/\bnode\b[^|;&]*--test\b/.test(cmd)) return "node --test";
  if (/\bmocha\b/.test(cmd)) return "mocha";
  if (/\bpytest\b/.test(cmd)) return "pytest";
  if (/\bunittest\b/.test(cmd)) return "unittest";
  return null;
}

/** The repo's test layout, read at `dir` (a worktree). `testCmd`: kitchen.yaml's test_cmd. */
export function testLayout(dir: string, testCmd = ""): TestLayout | null {
  const vitestCfg = firstFile(
    dir,
    ["vitest.config", "vitest.workspace", "vite.config"].flatMap((b) => ["ts", "mts", "cts", "js", "mjs", "cjs"].map((e) => `${b}.${e}`)),
  );
  if (vitestCfg) {
    const t = read(dir, vitestCfg) ?? "";
    const inc = arrayAfter(t, "include");
    if (inc && (!vitestCfg.startsWith("vite.") || /\btest\s*:/.test(t))) return { runner: "vitest", globs: inc, source: vitestCfg };
    if (!vitestCfg.startsWith("vite.")) return { runner: "vitest", globs: DEFAULT_GLOBS.vitest, source: `${vitestCfg} (vitest's default include)` };
  }
  let pkg: { jest?: { testMatch?: unknown }; scripts?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(read(dir, "package.json") ?? "{}");
  } catch {}
  const jestCfg = firstFile(
    dir,
    ["js", "ts", "mjs", "cjs", "json"].map((e) => `jest.config.${e}`),
  );
  if (jestCfg || pkg.jest) {
    const m = jestCfg ? arrayAfter(read(dir, jestCfg) ?? "", "testMatch") : Array.isArray(pkg.jest?.testMatch) ? (pkg.jest.testMatch as string[]) : null;
    const globs = (m ?? DEFAULT_GLOBS.jest).map((g) => g.replace(/^<rootDir>\//, ""));
    return { runner: "jest", globs, source: jestCfg ?? "package.json jest" };
  }
  const py = pytestLayout(dir);
  if (py) return py;
  const mocharc = firstFile(dir, [".mocharc.json", ".mocharc.js", ".mocharc.cjs", ".mocharc.yml", ".mocharc.yaml"]);
  if (mocharc) {
    const t = read(dir, mocharc) ?? "";
    const spec = arrayAfter(t, "spec") ?? (/["']?spec["']?\s*[:=]\s*["']([^"']+)["']/.exec(t)?.slice(1, 2) || null);
    return { runner: "mocha", globs: (spec ?? DEFAULT_GLOBS.mocha).map((g) => g.replace(/^\.\//, "")), source: mocharc };
  }
  for (const [cmd, source] of [
    [pkg.scripts?.test ?? "", "package.json scripts.test"],
    [testCmd, "kitchen.yaml test_cmd"],
  ] as const) {
    const runner = runnerOf(cmd);
    if (!runner) continue;
    if (runner === "pytest") return { runner, globs: DEFAULT_GLOBS.pytest, source: `${source} (pytest's defaults)` };
    // `node --test test/` / `node --test 'src/**/*.test.js'`: the paths it is given are the layout.
    if (runner === "node --test") {
      const args = (/--test\b(.*)$/.exec(cmd)?.[1] ?? "")
        .split(/\s+/)
        .map((a) => a.replace(/^['"]|['"]$/g, ""))
        .filter((a) => a && !a.startsWith("-") && !a.includes("{file}") && !/[;&|]/.test(a));
      if (args.length) return { runner, globs: args.map((a) => (/\.[cm]?[jt]s$/.test(a) ? a : asDirGlob(a))), source };
    }
    return { runner, globs: DEFAULT_GLOBS[runner], source: `${source} (${runner}'s defaults)` };
  }
  return null;
}

/** Is this repo-relative path one the layout's globs match? */
export const inLayout = (file: string, layout: TestLayout): boolean => {
  const f = path.posix.normalize(file.replace(/^\.\//, ""));
  return layout.globs.some((g) => path.posix.matchesGlob(f, g.replace(/^\.\//, "")));
};

/** Test-runner config: the builder may not edit it (widening `include` to run a test placed elsewhere). */
export const TEST_RUNNER_CONFIG =
  /(^|\/)((vitest|jest|playwright|cypress|ava)\.(config|workspace)\.[cm]?[jt]s|jest\.config\.json|\.mocharc(\.[a-z]+)?|pytest\.ini|karma\.conf\.[cm]?[jt]s|\.nycrc(\.[a-z]+)?)$/;
/** Build and toolchain config: a low-risk diff that touches it gets the code lens. */
export const BUILD_CONFIG =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|babel\.config\.[cm]?[jt]s(on)?|\.babelrc|biome\.jsonc?|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|Makefile|Dockerfile|docker-compose\.ya?ml|pyproject\.toml|setup\.py|setup\.cfg|tox\.ini|requirements[^/]*\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?)$/;
/** A test file by its name or folder, whatever the runner. */
export const isTestFile = (f: string): boolean =>
  /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)test_[^/]*\.py$|_test\.(py|go)$/.test(f);
/** A file that is a test, or configures how tests run or the project builds. */
export const isTestOrBuildConfig = (f: string): boolean => isTestFile(f) || TEST_RUNNER_CONFIG.test(f) || BUILD_CONFIG.test(f);
