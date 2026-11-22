// Shared helpers for the W3a spikes: a git repo made from a copy of fixture A
// (optionally with a planted bug), the real `kitchen` CLI as a child process,
// PASS/FAIL lines, and readers for the job's ledger, manifest and agent runs.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Job } from "../../src/engine/machine.ts";
import type { Entry } from "../../src/proof/manifest.ts";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const CLI = path.join(ROOT, "src", "cli.ts");
export const CLAUDE_BIN = process.env.KITCHEN_CLAUDE_BIN ?? "/opt/homebrew/bin/claude";
export const CODEX_CMD = ["npx", "-y", "@openai/codex@0.171.0"];

let fails = 0;
let passes = 0;
export function check(name: string, ok: boolean, evidence = "") {
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence ? `: ${evidence}` : ""}`);
}
export function finish(label: string) {
  console.log(`\n${label}: ${passes} passed, ${fails} failed`);
  process.exitCode = fails ? 1 : 0;
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=spike", "-c", "user.email=s@example.invalid", ...a], { cwd, stdio: "pipe" }).toString();

/** The planted bug: the theme endpoint answers 200 but updates no row (wrong column), so dark mode is lost on reload. */
export const BUG = {
  from: 'await pool.query("UPDATE users SET theme = $1 WHERE id = $2", [theme, user.id]);',
  to: 'await pool.query("UPDATE users SET theme = $1 WHERE username = $2", [theme, user.id]);',
};

export type Repo = { dir: string; home: string; env: NodeJS.ProcessEnv };

/** A git repo holding a copy of fixtures/a-web (no node_modules), with kitchen.yaml. */
export function makeFixtureRepo(root: string, name: string, o: { yaml: string; bug?: boolean; home?: string }): Repo {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "fixtures", "a-web"), dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  fs.appendFileSync(
    path.join(dir, ".gitignore"),
    [".kitchen/jobs/", ".kitchen/scratch/", ".kitchen/*.json", ".kitchen/*.jsonl", ".kitchen/*.lock", ".kitchen/*.log", ".worktrees/", ""].join("\n"),
  );
  if (o.bug) {
    const f = path.join(dir, "server.js");
    const s = fs.readFileSync(f, "utf8");
    if (!s.includes(BUG.from)) throw new Error("fixture A changed: can't plant the bug");
    fs.writeFileSync(f, s.replace(BUG.from, BUG.to));
  }
  fs.writeFileSync(path.join(dir, "kitchen.yaml"), o.yaml);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", o.bug ? "fixture a-web (with a planted bug)" : "fixture a-web");
  const home = o.home ?? path.join(root, "kitchen-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env, KITCHEN_HOME: home, KITCHEN_TICK_MS: "200", KITCHEN_FAKE_STATE: path.join(dir, ".kitchen", "fake-state.json") };
  return { dir, home, env };
}

/** Run `kitchen <args>` in the repo; returns stdout+stderr and the exit code. */
export function kitchen(r: Repo, args: string[], timeoutMs = 60 * 60_000): { out: string; code: number } {
  const p = spawnSync(process.execPath, [CLI, ...args, "--repo", r.dir], { env: r.env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const out = `${p.stdout}${p.stderr}`;
  if (process.env.W3A_VERBOSE) process.stdout.write(out.replace(/^/gm, `    [${args[0]}] `));
  return { out, code: p.status ?? -1 };
}

export const jobDir = (r: Repo, id: string) => path.join(r.dir, ".kitchen", "jobs", id);
export const jobOf = (r: Repo, id: string): Job => JSON.parse(fs.readFileSync(path.join(jobDir(r, id), "job.json"), "utf8")) as Job;
export function manifest(r: Repo, id: string): Entry[] {
  const f = path.join(jobDir(r, id), "evidence", "manifest.jsonl");
  return fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Entry)
    : [];
}

export function ticket(r: Repo, text: string): string {
  const { out } = kitchen(r, ["ticket", text]);
  const id = /ticket (\S+)/.exec(out)?.[1];
  if (!id) throw new Error(`no job id in: ${out}`);
  return id;
}

/** `kitchen run --once <id>` until the job is in one of `stop` (or `max` passes). Everything printed is returned and teed to `log`. */
export function stepUntil(r: Repo, id: string, stop: string[], o: { max?: number; log?: string } = {}): string {
  let all = "";
  for (let i = 0; i < (o.max ?? 40); i++) {
    if (stop.includes(jobOf(r, id).stage)) break;
    const { out } = kitchen(r, ["run", "--once", id]);
    all += out;
    if (o.log) fs.appendFileSync(o.log, out);
  }
  return all;
}

/** The stages a job went through, from the de-duplicated ledger. */
export function stagesOf(r: Repo, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of ledger(r)) {
    if (l.job !== id || l.event !== "move" || seen.has(l.key)) continue;
    seen.add(l.key);
    if (!out.length) out.push(l.stage);
    out.push(String(l.result));
  }
  return out;
}

export type LedgerLine = {
  t: string;
  job: string;
  stage: string;
  round: number;
  event: string;
  key: string;
  result?: string;
  role?: string;
  model?: string;
  secs?: number;
  usd?: number;
  detail?: Record<string, unknown>;
};
export function ledger(r: Repo): LedgerLine[] {
  const f = path.join(r.dir, ".kitchen", "ledger.jsonl");
  return fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LedgerLine)
    : [];
}

export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Kitchen containers still running (the fixture's Toolkit labels them). */
export const kitchenContainers = () =>
  execFileSync("docker", ["ps", "-q", "--filter", "label=kitchen.toolkit=a-web"], { encoding: "utf8" }).split("\n").filter(Boolean);
