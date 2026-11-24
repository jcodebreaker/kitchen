// The kitchen.yaml `checks`, run as plain shell commands in a directory (a job worktree, staging's merge
// worktree, the person's checkout at init). Kitchen runs them itself: an agent's word that they passed counts for
// nothing. A fresh worktree has no dependencies, so `checks_install` / `checks_prepare` run first, once per worktree
// until a dependency file changes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CheckSpec, Config } from "../config.ts";

/** `yarn`: Yarn Berry (2+); `yarn-classic`: Yarn 1. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "yarn-classic" | "bun";
export type CheckRun = { name: string; run: string; ok: boolean; exit: number | null; secs: number; tail: string };
export type ChecksResult = { ok: boolean; results: CheckRun[] };

const INSTALL: Record<PackageManager, string> = {
  npm: "npm ci",
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --immutable",
  "yarn-classic": "yarn install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
};

/** Pure: what readies a worktree, as one shell line, or undefined. */
export function prepareOf(cfg: Pick<Config, "checks_install" | "checks_prepare">): string | undefined {
  const steps = [...(cfg.checks_install ? [INSTALL[cfg.checks_install]] : []), ...(cfg.checks_prepare ? [cfg.checks_prepare] : [])];
  return steps.length ? steps.join(" && ") : undefined;
}

export const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "go.sum",
  "Cargo.lock",
];

function prepareKey(cmd: string, dir: string): string {
  const h = createHash("sha256").update(cmd);
  for (const f of DEPENDENCY_FILES) {
    const p = path.join(dir, f);
    h.update(`\0${f}\0`);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  return h.digest("hex");
}

/**
 * One shell command in `cwd`, its output kept (the last 60 lines in `tail`, all of it in `log` when given). ADR 0025
 * §4: the log is written as the output arrives (`$ cmd` first, `[exit …]` last), so a long check shows progress.
 */
export function runShell(cmd: string, o: { cwd: string; timeoutSec: number; log?: string; env?: NodeJS.ProcessEnv }): Promise<CheckRun & { all: string }> {
  const t0 = Date.now();
  const log = o.log;
  if (log) {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, `$ ${cmd}\n`);
  }
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd: o.cwd, env: { ...process.env, CI: "1", ...o.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let all = "";
    const take = (d: Buffer) => {
      all += d;
      if (log) fs.appendFileSync(log, d);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {}
    }, o.timeoutSec * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (log) fs.appendFileSync(log, `${all.endsWith("\n") || !all ? "" : "\n"}[exit ${timedOut ? "timeout" : code}]\n\n`);
      const tail = all.trimEnd().split("\n").slice(-60).join("\n");
      resolve({ name: "", run: cmd, ok: !timedOut && code === 0, exit: timedOut ? null : code, secs: (Date.now() - t0) / 1000, tail, all });
    });
  });
}

/** ADR 0025 §4: told the command a check step starts (null when the steps end), so the job can say what runs. */
export type OnCheck = (cmd: string | null) => Promise<void> | void;

/** The app for a `needs_app` check (ADR 0021): started, with the env that names its URL, and how to stop it. */
export type AppForCheck = () => Promise<{ ok: true; url: string; stop: () => Promise<void> } | { ok: false; why: string }>;

/** Pure: the env a `needs_app` check gets: the app's URL under the names the usual suites read. */
export const baseUrlEnv = (url: string): Record<string, string> => ({ BASE_URL: url, PLAYWRIGHT_BASE_URL: url, CYPRESS_BASE_URL: url });

/**
 * The checks in `dir`, in order; the first failure stops them. `prepare` runs first unless it already ran there
 * for the same command and dependency files (a marker in `stateDir`). `log`: every command's full output. A
 * `needs_app` check runs with the app `app` starts (its URL in $BASE_URL), and the app is always stopped after it.
 */
export async function runChecks(o: {
  dir: string;
  checks: CheckSpec[];
  prepare?: string;
  stateDir?: string;
  log?: string;
  app?: AppForCheck;
  onCheck?: OnCheck;
}): Promise<ChecksResult> {
  try {
    return await checksIn(o);
  } finally {
    await o.onCheck?.(null);
  }
}

async function checksIn(o: Parameters<typeof runChecks>[0]): Promise<ChecksResult> {
  const results: CheckRun[] = [];
  if (o.prepare && o.checks.length) {
    const marker = o.stateDir ? path.join(o.stateDir, "prepared.json") : null;
    const key = prepareKey(o.prepare, o.dir);
    let done = false;
    try {
      done = !!marker && JSON.parse(fs.readFileSync(marker, "utf8"))[o.dir] === key;
    } catch {}
    if (!done) {
      await o.onCheck?.(o.prepare);
      const r = await runShell(o.prepare, { cwd: o.dir, timeoutSec: 1800, log: o.log });
      results.push({ ...r, name: "prepare" });
      if (!r.ok) return { ok: false, results };
      if (marker) {
        let m: Record<string, string> = {};
        try {
          m = JSON.parse(fs.readFileSync(marker, "utf8"));
        } catch {}
        m[o.dir] = key;
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, JSON.stringify(m, null, 2));
      }
    }
  }
  for (const c of o.checks) {
    await o.onCheck?.(c.run);
    const r = c.needsApp ? await withApp(c, o) : await runShell(c.run, { cwd: o.dir, timeoutSec: c.timeoutSec, log: o.log });
    results.push({ name: c.name, run: r.run, ok: r.ok, exit: r.exit, secs: r.secs, tail: r.tail });
    if (!r.ok) break;
  }
  return { ok: results.every((r) => r.ok), results };
}

/** One `needs_app` check: the app up, the check with its URL, the app down whatever happened. */
async function withApp(c: CheckSpec, o: { dir: string; log?: string; app?: AppForCheck }): Promise<CheckRun> {
  const t0 = Date.now();
  const fail = (tail: string): CheckRun => ({ name: c.name, run: c.run, ok: false, exit: null, secs: (Date.now() - t0) / 1000, tail });
  if (!o.app) return fail(`${c.name} needs the app (needs_app), and nothing here starts it`);
  const a = await o.app();
  if (!a.ok) {
    note(o.log, `# ${c.name}: the app did not start: ${a.why}\n\n`);
    return fail(`the app did not start for ${c.name}: ${a.why}`);
  }
  try {
    note(o.log, `# ${c.name}: the app is up at ${a.url} (BASE_URL)\n`);
    return { ...(await runShell(c.run, { cwd: o.dir, timeoutSec: c.timeoutSec, log: o.log, env: baseUrlEnv(a.url) })), name: c.name };
  } finally {
    await a.stop();
  }
}

function note(log: string | undefined, text: string) {
  if (!log) return;
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, text);
}
