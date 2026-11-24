// The project's own end-to-end suite, as the verify skill's "Your tests" section describes it (ADR 0021 §2): where
// the specs are, the page objects / fixtures / helpers they share, the login and seed helpers by name, and how to
// run one spec against the app QA started. Found from file names and a light read, no agent; nothing runs.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

export type Suite = {
  tool: "playwright" | "cypress" | "other";
  /** The suite's config file, when there is one. */
  config: string | null;
  /** Where the specs live (relative), or null when none was found. */
  dir: string | null;
  specs: string[];
  specCount: number;
  /** Folders (`e2e/pages/`) and files (`e2e/fixtures.ts`) the specs share. */
  helpers: string[];
  /** Exported helpers that log in or seed, named with their file: `loginAs (e2e/fixtures.ts)`. */
  login: string[];
  /** The whole suite (the `when: merge` check's command) and one spec (`{file}`). */
  run: string;
  one: string;
  /** The env names the config reads for the app's URL (`BASE_URL`). */
  urlEnv: string[];
  /** The config starts its own server (Playwright `webServer`). */
  webServer: boolean;
};

const EXT = ["ts", "js", "mjs", "cjs"];
const SPEC = /\.(spec|test|cy|e2e)\.[cm]?[jt]sx?$/;
const HELPER_DIR = /^(pages|page-objects|pageobjects|pom|fixtures|helpers|support|utils|setup)$/i;
const HELPER_FILE = /(\.(page|po)\.[cm]?[jt]sx?$)|(^(fixtures?|helpers?|test-utils|utils|commands|global[.-]setup|auth\.setup|setup)\.[cm]?[jt]sx?$)/i;
const LOGIN = /log_?in|sign_?in|auth|seed|reset|session/i;
const SKIP = new Set(["node_modules", ".git", ".kitchen", ".worktrees", "dist", "build", "coverage", "test-results", "playwright-report"]);

const read = (repo: string, f: string) => {
  try {
    return fs.readFileSync(path.join(repo, f), "utf8");
  } catch {
    return null;
  }
};
const isDir = (repo: string, d: string) => {
  try {
    return fs.statSync(path.join(repo, d)).isDirectory();
  } catch {
    return false;
  }
};

/** Every file and folder under `dir` (relative to the repo), a few levels deep. */
function walk(repo: string, dir: string, depth = 5): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const go = (d: string, n: number) => {
    if (n > depth || files.length > 400) return;
    let es: fs.Dirent[];
    try {
      es = fs.readdirSync(path.join(repo, d), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const p = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) {
        dirs.push(p);
        go(p, n + 1);
      } else files.push(p);
    }
  };
  go(dir, 0);
  return { files, dirs };
}

/** The suite, or null when the repo has none Kitchen can see. */
export function detectSuite(repo: string, cfg: Pick<Config, "checkList">): Suite | null {
  let deps: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(read(repo, "package.json") ?? "{}") as { dependencies?: object; devDependencies?: object };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {}
  const cfgFile = (tool: string) => EXT.map((x) => `${tool}.config.${x}`).find((f) => fs.existsSync(path.join(repo, f))) ?? null;
  const pw = cfgFile("playwright");
  const cy = cfgFile("cypress");
  const check = cfg.checkList.find((c) => c.when === "merge");
  const tool: Suite["tool"] | null = pw || "@playwright/test" in deps ? "playwright" : cy || "cypress" in deps ? "cypress" : check ? "other" : null;
  if (!tool) return null;
  const config = tool === "playwright" ? pw : tool === "cypress" ? cy : null;
  const text = config ? (read(repo, config) ?? "") : "";
  const declared = tool === "playwright" ? /testDir\s*:\s*["'`](?:\.\/)?([^"'`]+?)\/?["'`]/.exec(text)?.[1] : undefined;
  const candidates =
    tool === "cypress"
      ? ["cypress/e2e", "cypress/integration", "cypress"]
      : ["e2e", "tests/e2e", "test/e2e", "playwright", "tests/integration", "test/integration", "integration", "tests", "test"];
  const dir = [declared, ...candidates].find((d): d is string => !!d && isDir(repo, d)) ?? null;
  const roots = [...new Set([dir, "e2e", "tests", "test", "cypress", "playwright"].filter((d): d is string => !!d && isDir(repo, d)))];
  const seen = new Set<string>();
  const files: string[] = [];
  const dirs: string[] = [];
  for (const r of roots) {
    const w = walk(repo, r);
    for (const f of w.files)
      if (!seen.has(f)) {
        seen.add(f);
        files.push(f);
      }
    for (const d of [r, ...w.dirs])
      if (!seen.has(`${d}/`)) {
        seen.add(`${d}/`);
        dirs.push(d);
      }
  }
  const specs = dir ? files.filter((f) => (f === dir || f.startsWith(`${dir}/`)) && SPEC.test(f)) : [];
  const helperDirs = dirs.filter((d) => HELPER_DIR.test(path.basename(d)));
  const helperFiles = files.filter((f) => HELPER_FILE.test(path.basename(f)) && !SPEC.test(f));
  const helpers = [...helperDirs.map((d) => `${d}/`), ...helperFiles].slice(0, 14);
  const login: string[] = [];
  const scan = [...new Set([...helperFiles, ...files.filter((f) => helperDirs.some((d) => f.startsWith(`${d}/`)))])].filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  for (const f of scan.slice(0, 40)) {
    const t = read(repo, f) ?? "";
    if (t.length > 200_000) continue;
    const names = [
      ...[...t.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/g)].map((m) => m[1]),
      ...[...t.matchAll(/export\s+(?:const|let)\s+(\w+)/g)].map((m) => m[1]),
      // Playwright fixtures (`test.extend({ loggedIn: … })`) and Cypress commands (`Cypress.Commands.add("login", …)`).
      ...[...t.matchAll(/Cypress\.Commands\.add\(\s*["'`](\w+)["'`]/g)].map((m) => `cy.${m[1]}`),
      ...[...(/\.extend<?[^(]*\(\s*\{([\s\S]*?)\}\s*\)/.exec(t)?.[1] ?? "").matchAll(/^\s{2,4}(\w+)\s*:/gm)].map((m) => `fixture ${m[1]}`),
    ];
    for (const n of new Set(names)) if (LOGIN.test(n) && login.length < 8) login.push(`${n} (${f})`);
  }
  const run = check?.run ?? (tool === "playwright" ? "npx playwright test" : tool === "cypress" ? "npx cypress run" : "");
  const one =
    tool === "playwright"
      ? "npx playwright test {file}"
      : tool === "cypress"
        ? "npx cypress run --spec {file}"
        : /^(npm run|pnpm|yarn|bun run)\s/.test(run)
          ? `${run} -- {file}`
          : `${run} {file}`;
  const urlEnv = [...new Set([...text.matchAll(/process\.env\.(\w*(?:BASE_URL|BASEURL|APP_URL)\w*)/g)].map((m) => m[1]))];
  return {
    tool,
    config,
    dir,
    specs: specs.slice(0, 5),
    specCount: specs.length,
    helpers,
    login,
    run,
    one,
    urlEnv,
    webServer: tool === "playwright" && /\bwebServer\s*:/.test(text),
  };
}

/** The verify skill's "Your tests" section (markdown, no trailing newline). */
export function suiteSection(s: Suite | null): string {
  if (!s)
    return "## Your tests\n\nNo end-to-end suite was found in the repo (no `test:e2e` script, Playwright or Cypress config). The checks in kitchen.yaml are the project's tests; drive the app with `kitchen qa` as below.";
  const name = s.tool === "playwright" ? "Playwright" : s.tool === "cypress" ? "Cypress" : "end-to-end";
  const code = (x: string) => `\`${x}\``;
  const env =
    s.tool === "cypress" ? "CYPRESS_BASE_URL=<url>" : `${[...new Set(["BASE_URL", "PLAYWRIGHT_BASE_URL", ...s.urlEnv])].map((e) => `${e}=<url>`).join(" ")}`;
  const keep =
    s.tool === "playwright"
      ? " --reporter=line --output <evidence folder>/pw"
      : s.tool === "cypress"
        ? " --config video=false,screenshotsFolder=<evidence folder>/cy"
        : "";
  const one = `${env} ${s.one.replace("{file}", "<spec>")}${keep} > <evidence folder>/<criterion>-spec.txt 2>&1`;
  return [
    "## Your tests",
    "",
    `The project's own ${name} suite already knows how to drive ${s.dir ? `this app` : "the app"}: read it before you drive, and reuse it. Kitchen runs the whole suite (${code(s.run || "its command")}) on every merge into staging (kitchen.yaml \`checks:\`, \`when: merge\`).`,
    "",
    `- Where: ${s.dir ? `${code(`${s.dir}/`)} (${s.specCount} spec${s.specCount === 1 ? "" : "s"}${s.specs.length ? `, e.g. ${s.specs.map(code).join(", ")}` : ""})` : "no spec folder found"}${s.config ? `. Config: ${code(s.config)}${s.urlEnv.length ? ` (reads ${s.urlEnv.map(code).join(", ")} for the app's URL)` : ""}` : ""}.`,
    s.helpers.length
      ? `- Page objects, fixtures, helpers: ${s.helpers.map(code).join(", ")}. Take your selectors and steps from them (the role names, labels and test ids the suite already relies on) instead of finding your own.`
      : "- No page objects, fixtures or helpers were found by name: read a spec for its selectors.",
    s.login.length
      ? `- Logging in and seeding: ${s.login.map(code).join(", ")}. When a criterion needs a user or data, do what these do (the same form, the same requests).`
      : "- No login or seed helper was found by name: read how a spec sets up its user and data.",
    `- Run one spec against the app you started (${code("<url>")} is what ${code("kitchen qa up")} printed): ${code(one)}. When a criterion matches an existing spec, its output is your evidence: cite the file.${s.webServer ? " The config has a `webServer`: if it doesn't reuse a running server it starts its own, so set its URL env to yours." : ""}`,
    "- Never edit the suite: no new spec, no changed selector, fixture or snapshot. A spec the ticket asks for is the builder's.",
  ].join("\n");
}
