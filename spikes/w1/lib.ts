// Shared helpers for the W1 spikes: a throwaway repo with a fake Toolkit and the
// fake agent, the real `kitchen` CLI run as a child process, and PASS/FAIL lines.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Job } from "../../src/engine/machine.ts";
import { type FakeForgeState, readFakeForge } from "../../src/forge/forge.ts";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const CLI = path.join(ROOT, "src", "cli.ts");

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

const DEV = `#!/bin/sh
# Fake Toolkit for W1 spikes: answers describe/doctor/up/down/reset with one JSON line.
here=$(cd "$(dirname "$0")/.." && pwd)
cmd=$1; shift
echo "$cmd $*" >> "$here/calls.log"
case "$cmd" in
  describe) list=$(sed 's/.*/"&"/' "$here/primitives.txt" | paste -sd, -); printf '{"primitives":[%s],"ports":{"needs":1,"order":["app"]},"parallel":true}\\n' "$list" ;;
  doctor) echo '{"status":"ok","checks":[]}' ;;
  up) echo '{"status":"ready","url":"http://127.0.0.1:1"}' ;;
  down|reset|prepare) echo '{"status":"ok"}' ;;
  *) echo '{"ok":false,"out":"no such primitive"}'; exit 1 ;;
esac
`;

export type Repo = { dir: string; home: string; env: NodeJS.ProcessEnv };

/** A git repo with kitchen.yaml (fake agent, fake forge, one gate check) and a fake Toolkit. */
export function makeRepo(root: string, name: string, extraYaml = ""): Repo {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, ".kitchen", "toolkit", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    [
      ".kitchen/jobs/",
      ".kitchen/scratch/",
      ".kitchen/*.json",
      ".kitchen/*.jsonl",
      ".kitchen/*.lock",
      ".kitchen/*.log",
      ".kitchen/toolkit/calls.log",
      ".worktrees/",
      "hang-*",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "kitchen.yaml"),
    `concurrency: 2
agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-script.ts"))} }
forge: { kind: fake }
checks:
  - { name: no-gate-fail, run: "test ! -f GATE_FAIL" }
backoff: { base_sec: 1, max_sec: 2 }
${extraYaml}`,
  );
  fs.writeFileSync(path.join(dir, ".kitchen", "toolkit", "bin", "dev"), DEV, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, ".kitchen", "toolkit", "primitives.txt"), "read\npress\nopen\nlogin\n");
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const home = path.join(root, "kitchen-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env, KITCHEN_HOME: home, KITCHEN_FAKE_STATE: path.join(dir, ".kitchen", "fake-state.json"), KITCHEN_TICK_MS: "200" };
  return { dir, home, env };
}

/** Run `kitchen <args>` in the repo; returns stdout+stderr and the exit code. */
export function kitchen(r: Repo, ...args: string[]): { out: string; code: number } {
  const p = spawnSync(process.execPath, [CLI, ...args, "--repo", r.dir], { env: r.env, encoding: "utf8", timeout: 120_000 });
  const out = `${p.stdout}${p.stderr}`;
  if (process.env.W1_VERBOSE) process.stdout.write(out.replace(/^/gm, `    [${args[0]}] `));
  return { out, code: p.status ?? -1 };
}

export const jobOf = (r: Repo, id: string): Job => JSON.parse(fs.readFileSync(path.join(r.dir, ".kitchen", "jobs", id, "job.json"), "utf8")) as Job;
export const jobDir = (r: Repo, id: string) => path.join(r.dir, ".kitchen", "jobs", id);
export const forge = (r: Repo): FakeForgeState => readFakeForge(path.join(r.dir, ".kitchen", "fake-forge.json"));
export function editForge(r: Repo, fn: (s: FakeForgeState) => void) {
  const f = path.join(r.dir, ".kitchen", "fake-forge.json");
  const s = readFakeForge(f);
  fn(s);
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
}

/** `kitchen ticket` and return the new job id. */
export function ticket(r: Repo, text: string): string {
  const { out } = kitchen(r, "ticket", text);
  const id = /ticket (\S+)/.exec(out)?.[1];
  if (!id) throw new Error(`no job id in: ${out}`);
  return id;
}

/** `kitchen run --once <id>` until the job reaches `stage` (or `max` passes). Returns everything printed. */
export function stepUntil(r: Repo, id: string, stage: string, max = 40): string {
  let all = "";
  for (let i = 0; i < max; i++) {
    if (jobOf(r, id).stage === stage) return all;
    all += kitchen(r, "run", "--once", id).out;
  }
  return all;
}

/** The stages a job went through, from the de-duplicated ledger. */
export function stagesOf(r: Repo, id: string): string[] {
  const f = path.join(r.dir, ".kitchen", "ledger.jsonl");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const l = JSON.parse(line) as { job: string; event: string; key: string; stage: string; result: string };
    if (l.job !== id || l.event !== "move" || seen.has(l.key)) continue;
    seen.add(l.key);
    if (!out.length) out.push(l.stage);
    out.push(l.result);
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
