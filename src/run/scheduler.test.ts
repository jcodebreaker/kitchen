// ADR 0030: `kitchen run` schedules the lanes itself. A stand-in agent (KITCHEN_CLAUDE_BIN, never a real model) does
// each lane's work from its prompt: intake.md, a commit, a QA verdict, a review. The run is the real CLI, in a child.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig, parseConfig } from "../config.ts";
import { finishing } from "../dashboard/data.ts";
import * as control from "../engine/control.ts";
import { git, gitArgv, worktreeEnv } from "../engine/git.ts";
import { beat, finish, laneBusy, next, readHeartbeat, start, worktreeConfigOf, worktreeTampered } from "../engine/jobs.ts";
import { intakeFile } from "../engine/lanes.ts";
import type { Job } from "../engine/machine.ts";
import { ensureStaging } from "../engine/staging.ts";
import { findJob, jobDirOf, listJobs, updateJob } from "../engine/store.ts";
import { readLedger } from "../ledger/append.ts";
import { tryFileLock } from "../lock.ts";
import { scrubbedEnv } from "./orchestrator.ts";
import { codexUsage, commitRoots, LANE_TOOLS, laneCommand, laneWords, stamp, workLine } from "./scheduler.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-sched-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const CLI = path.resolve(import.meta.dirname, "..", "cli.ts");
const quiet = () => {};
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();

/**
 * The stand-in agent: reads its lane, job, checkout and brief from the prompt Kitchen gives every lane, does the lane's
 * work, and ends with a result line. A job whose title says "slow" builds for $SLOW s; "linger" takes 1 s a lane; "freeze" never ends; "crash"
 * exits 3 having written nothing; "overbudget" stops at its budget cap; "inspect" is a check whose QA finds a high-severity problem; "nologin" fails as a signed-out tool does, before any work. $SEEN, when set, gets
 * each session's working dir and argv (one file per lane).
 */
const FAKE_AGENT = `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
P="$2"
case "$P" in *nologin*) echo "Invalid API key · Please run /login" >&2; exit 1 ;; esac
lane=$(printf %s "$P" | sed -n "s/.*Kitchen's \\([a-z-]*\\) agent for job .*/\\1/p")
id=$(printf %s "$P" | sed -n "s/.*Kitchen's [a-z-]* agent for job \\([^ ]*\\) .*/\\1/p")
cwd=$(printf %s "$P" | sed -n 's/.*First run \`cd \\([^\`]*\\)\`.*/\\1/p')
brief=$(printf %s "$P" | sed -n 's/.*read your brief, \\(.*\\.md\\), and follow.*/\\1/p')
rd=$(dirname "$brief")
jd=$(dirname "$(dirname "$rd")")
[ -n "$SEEN" ] && { echo "PWD=$PWD"; for a in "$@"; do echo "$a"; done; } > "$SEEN-$lane-$(basename "$id")"
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$lane"' for '"$id"'"}]}}'
case "$P" in *freeze*) sleep 600 ;; esac
case "$P" in *crash*) exit 3 ;; esac
case "$P" in *overbudget*) echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.3}'; exit 1 ;; esac
case "$P" in *inspect*)
  case "$lane" in
    intake) printf 'DECISION: ACCEPT\\nTITLE: %s\\nKIND: check\\nLEFT OUT: nothing\\nREASON: asks to check\\n\\n## Criteria\\n- C1 (cmd): renewing a loan works\\n' "$id" > "$jd/intake.md" ;;
    qa) mkdir -p "$rd/qa" && echo 500 > "$rd/qa/c1.txt" && echo '{"verdict":"FAIL","criteria":[{"id":"C1","result":"FAIL","evidence":["c1.txt"],"note":"500"}],"findings":[{"title":"Renew returns 500","seen":"POST /loans/4/renew gives 500","expected":"200","cause":"the handler reads an empty due date","severity":"high","repro":["renew loan 4"],"evidence":["c1.txt"],"criterion":"C1"}]}' > "$rd/qa/verdict.json" ;;
  esac
  echo '{"type":"result","total_cost_usd":0.01,"result":"'"$lane"' done for '"$id"'"}'
  exit 0 ;;
esac
case "$P" in *slow*) [ "$lane" = build ] && sleep "\${SLOW:-4}" ;; esac
case "$P" in *linger*) sleep 1 ;; esac
case "$lane" in
  intake) printf 'DECISION: ACCEPT\\nTITLE: %s\\nKIND: feature\\nRISK: low\\nSURFACES: none\\nFILES: f-%s.txt\\n\\n## Criteria\\n- C1 (cmd): f-%s.txt exists\\n' "$id" "$id" "$id" > "$jd/intake.md" ;;
  build) cd "$cwd" && echo "$id" > "f-$id.txt" && git add -A && git -c user.name=t -c user.email=t@x -c commit.gpgSign=false commit -qm "$id" ;;
  qa) mkdir -p "$rd/qa" && echo ok > "$rd/qa/c1.txt" && echo '{"verdict":"PASS","criteria":[{"id":"C1","result":"PASS","evidence":["c1.txt"],"note":"ok"}]}' > "$rd/qa/verdict.json" ;;
  review) echo '{"summary":"ok","findings":[]}' > "$rd/review.json" ;;
esac
echo '{"type":"result","total_cost_usd":0.01,"result":"'"$lane"' done for '"$id"'"}'
`;
/** The same stand-in as codex exec: the prompt is its last argument; it reports tokens, not dollars. */
const FAKE_CODEX = FAKE_AGENT.replace('P="$2"', 'for a in "$@"; do P="$a"; done')
  .replace('echo "9.9.9 (Claude Code)"', 'echo "codex-cli 9.9.9"')
  .replace(/echo '\{"type":"result","total_cost_usd":0\.01.*\n/g, `echo '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}'\n`);

const INTAKE = (id: string) =>
  `DECISION: ACCEPT\nTITLE: ${id}\nKIND: feature\nRISK: low\nSURFACES: none\nFILES: f.txt\n\n## Criteria\n- C1 (cmd): f-${id}.txt exists\n`;
let n = 0;
async function repo(tickets: string[], yaml = "parallel: 2\n"): Promise<string> {
  const r = path.join(root, `r${++n}`);
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "app.txt"), "one\n");
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `checks: [{ name: guard, run: "test ! -e BROKEN" }]\n${yaml}`);
  fs.writeFileSync(path.join(r, ".gitignore"), ".kitchen/\n.worktrees/\n.claude/\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  await ensureStaging(r, loadConfig(r), quiet);
  for (const t of tickets) await control.ticket(r, t, quiet);
  return r;
}

const agent = path.join(root, "claude");
fs.writeFileSync(agent, FAKE_AGENT, { mode: 0o755 });
const env = () => {
  const e: NodeJS.ProcessEnv = { ...process.env, KITCHEN_CLAUDE_BIN: agent, KITCHEN_HOME: path.join(root, "home"), SLOW: "4" };
  delete e.KITCHEN_ORCHESTRATOR;
  delete e.KITCHEN_JOB;
  return e;
};
/** `kitchen run` in a child, its lines as they come. */
function kitchenRun(r: string) {
  const lines: string[] = [];
  const c = spawn(process.execPath, [CLI, "run", "--repo", r], { cwd: r, env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  c.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    lines.push(...parts);
  });
  c.stderr.on("data", (d: Buffer) => lines.push(`stderr: ${d.toString().trim()}`));
  const done = new Promise<number>((res) => c.on("close", (code) => res(code ?? 1)));
  return { lines, done, child: c };
}
const at = (lines: string[], re: RegExp) => {
  const i = lines.findIndex((l) => re.test(l));
  assert.ok(i >= 0, `no line ${re} in:\n${lines.join("\n")}`);
  return i;
};
/** Polls `cond` every 50 ms for up to `ms`; throws with `what` (and the run's lines) if it never holds. */
async function waitFor<T>(cond: () => T | undefined | false | null, what: string, ms = 15_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((res) => setTimeout(res, 50))) {
    const v = cond();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** The lane sessions that really started (a run's placeholder claim has no pid yet). */
const startedSessions = (r: string, re = /./) =>
  listJobs(r).flatMap((j) => (j.running?.session && !j.running.session.pending && j.running.session.pid > 0 && re.test(j.id) ? [j.running.session.pid] : []));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("lane commands: claude -p with the lane's model and tools (no Agent), codex exec --json in the checkout; a scrubbed env", () => {
  const cfg = parseConfig("agent: { max_usd: 12 }\n");
  const argv = laneCommand(cfg, { model: "opus", prompt: "do it" }, { cwd: "/r/.worktrees/001-x", bin: ["/opt/claude"], budget: 3.5 });
  assert.deepEqual(argv.slice(0, 5), ["/opt/claude", "-p", "do it", "--model", "opus"]);
  assert.equal(argv[argv.indexOf("--allowedTools") + 1], LANE_TOOLS.join(","));
  assert.ok(!LANE_TOOLS.includes("Agent") && !LANE_TOOLS.includes("Task"));
  assert.deepEqual(argv.slice(-2), ["--max-budget-usd", "3.50"]);
  assert.ok(argv.includes("stream-json"));
  assert.ok(!argv.includes("/r/.worktrees/001-x"), "claude starts in the repo, where its hooks are");
  const roots = commitRoots("/r/.git", "/r/.git/worktrees/001-x", "kitchen/001-x");
  assert.deepEqual(roots, ["/r/.git/worktrees/001-x", "/r/.git/objects", "/r/.git/refs/heads/kitchen", "/r/.git/logs/refs/heads/kitchen"]);
  assert.ok(!roots.includes("/r/.git"), "never the whole git dir: its config and hooks/ stay read-only");
  const codex = laneCommand(
    parseConfig("agent: { tool: codex }\n"),
    { model: "gpt-5.4", prompt: "do it" },
    { cwd: "/r/.worktrees/001-x", writable: ["/r/.kitchen/jobs/001-x", ...roots], bin: ["codex"] },
  );
  assert.deepEqual(codex, [
    "codex",
    "exec",
    "--json",
    "-m",
    "gpt-5.4",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "-C",
    "/r/.worktrees/001-x",
    "--add-dir",
    "/r/.kitchen/jobs/001-x",
    ...roots.flatMap((d) => ["--add-dir", d]),
    "do it",
  ]);
  assert.ok(!codex.some((a) => /dangerously|yolo/.test(a)));
  const qa = laneCommand(parseConfig("agent: { tool: codex }\n"), { model: "m", prompt: "p" }, { cwd: "/c", network: true, bin: ["codex"] });
  assert.deepEqual(qa.slice(6, 10), ["workspace-write", "-c", "sandbox_workspace_write.network_access=true", "--skip-git-repo-check"]);
  assert.ok(!codex.includes("sandbox_workspace_write.network_access=true"), "a build lane has no network");
  const e = scrubbedEnv({ GH_TOKEN: "g", GITHUB_TOKEN: "h", PATH: "/bin", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual([e.GH_TOKEN, e.GITHUB_TOKEN, e.PATH, e.ANTHROPIC_API_KEY, e.KITCHEN_ORCHESTRATOR], [undefined, undefined, "/bin", "k", "1"]);
});

test("the dashboard says Finishing once a lane's session is over and before finish clears the lane", () => {
  const run = (session?: { pid: number; start: string | null; ended?: string }) => ({
    running: { lane: "build" as const, at: "t", key: "k", ...(session ? { session } : {}) },
  });
  const up = () => true;
  assert.equal(finishing(run(), up), false, "a lane an in-session orchestrator started");
  assert.equal(finishing(run({ pid: 1, start: "s" }), up), false, "its session works");
  assert.equal(finishing(run({ pid: 1, start: "s", ended: "t" }), up), true);
  assert.equal(
    finishing(run({ pid: 1, start: "s" }), () => false),
    true,
    "the session crashed before Kitchen saw it end",
  );
  assert.equal(finishing({ running: null }, up), false);
});

test("stream lines: work, codex's tokens", () => {
  assert.ok(workLine('{"type":"assistant","message":{}}') && workLine('{"type":"item.started","item":{}}'));
  assert.ok(!workLine('{"type":"system","subtype":"init"}') && !workLine('{"type":"result","is_error":true}'));
  assert.deepEqual(codexUsage('{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}'), { input_tokens: 5, output_tokens: 2 });
  assert.equal(codexUsage('{"type":"result","total_cost_usd":1}'), null);
});

test("Kitchen's git runs no fsmonitor a repo names; the repo's hooks stay", async () => {
  assert.deepEqual(gitArgv("/r", ["status"]), ["-c", "core.fsmonitor=false", "-C", "/r", "status"]);
  const r = await repo([]);
  g(r, "config", "core.hooksPath", ".git/evil-hooks");
  g(r, "config", "core.fsmonitor", "touch PWNED");
  assert.equal((await git(r, ["config", "--get", "core.hooksPath"])).stdout.trim(), ".git/evil-hooks");
  assert.equal((await git(r, ["config", "--get", "core.fsmonitor"])).stdout.trim(), "false");
  await git(r, ["status"]);
  assert.ok(!fs.existsSync(path.join(r, "PWNED")));
});

test("finish: a key that isn't the open lane's is refused untouched", async () => {
  const r = await repo(["one change"]);
  const [id] = listJobs(r).map((j) => j.id);
  const s = await start(r, id, "intake");
  assert.ok("key" in s);
  assert.match(String(((await finish(r, id, { key: "another-run" })) as { refused: string }).refused), /another run's .* nothing finished/);
  assert.equal(findJob(r, id).running?.key, s.key, "the lane is untouched");
});

test("a lane that moves another job's branch, or rewires its worktree's git dir, is refused", async () => {
  const r = await repo(["one change", "two change"]);
  const [one, two] = listJobs(r).map((j) => j.id);
  for (const id of [one, two]) {
    assert.ok("key" in (await start(r, id, "intake")));
    fs.writeFileSync(intakeFile(jobDirOf(r, id)), INTAKE(id));
    await finish(r, id);
  }
  // Two builds: two's branch exists; one's lane moves it while no lane of two works.
  const b2 = await start(r, two, "build");
  assert.ok("cwd" in b2);
  fs.writeFileSync(path.join(b2.cwd, "f2.txt"), "2\n");
  g(b2.cwd, "add", "-A");
  g(b2.cwd, "commit", "-qm", "two");
  await finish(r, two);
  const b1 = await start(r, one, "build");
  assert.ok("cwd" in b1);
  assert.equal(await worktreeTampered(r, b1.cwd, findJob(r, one).running?.wtConfig), null);
  g(r, "update-ref", `refs/heads/${findJob(r, two).branch}`, g(r, "rev-parse", "main"));
  fs.writeFileSync(path.join(b1.cwd, "f1.txt"), "1\n");
  g(b1.cwd, "add", "-A");
  g(b1.cwd, "commit", "-qm", "one");
  const f = await finish(r, one);
  assert.ok("line" in f && /kitchen\/\S+, job \S+'s branch, moved while this lane ran/.test(f.line), JSON.stringify(f));
  // A worktree git dir that names another repo, or a config.worktree the lane wrote or changed: refused.
  const gd = g(b1.cwd, "rev-parse", "--absolute-git-dir");
  fs.writeFileSync(path.join(gd, "config.worktree"), "[core]\n\thooksPath = /tmp/x\n");
  assert.match(String(await worktreeTampered(r, b1.cwd, "none")), /config\.worktree the lane wrote/);
  // One that was there when the lane opened (git worktree add writes one in a sparse checkout) is fine, unchanged.
  const had = worktreeConfigOf(b1.cwd) as string;
  assert.equal(await worktreeTampered(r, b1.cwd, had), null);
  fs.appendFileSync(path.join(gd, "config.worktree"), "\tfsmonitor = touch x\n");
  assert.match(String(await worktreeTampered(r, b1.cwd, had)), /config\.worktree the lane changed/);
  fs.rmSync(path.join(gd, "config.worktree"));
  fs.writeFileSync(path.join(gd, "commondir"), "/tmp/elsewhere/.git\n");
  assert.match(String(await worktreeTampered(r, b1.cwd, "none")), /names another repo/);
  fs.writeFileSync(path.join(gd, "commondir"), "../..\n");
  // Kitchen's git there names the worktree's git dir only: no GIT_COMMON_DIR for the person's hooks to inherit.
  assert.deepEqual(worktreeEnv(b1.cwd), { GIT_DIR: gd, GIT_WORK_TREE: b1.cwd });
});

test("a repo hook run by Kitchen's git in a worktree reaches another repo with its own git -C (husky style)", async () => {
  const other = await repo([]);
  g(other, "commit", "-q", "--allow-empty", "-m", "the other repo's commit");
  const r = await repo(["one change"]);
  const [id] = listJobs(r).map((j) => j.id);
  assert.ok("key" in (await start(r, id, "intake")));
  fs.writeFileSync(intakeFile(jobDirOf(r, id)), INTAKE(id));
  await finish(r, id);
  const b = await start(r, id, "build");
  assert.ok("cwd" in b);
  const said = path.join(root, "hook-said");
  const hook = path.join(r, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, `#!/bin/sh\nunset GIT_DIR\ngit -C "${other}" log -1 --format=%s > "${said}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(b.cwd, "f.txt"), "x\n");
  await git(b.cwd, ["add", "-A"]);
  await git(b.cwd, ["-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", "commit", "-qm", "x"]);
  assert.equal(fs.readFileSync(said, "utf8").trim(), "the other repo's commit");
});

test("a lane opened without a session is busy while its activity stream grows, however long the wave", () => {
  const r = path.join(root, "busy");
  fs.mkdirSync(path.join(r, ".kitchen", "jobs", "001-x", "activity"), { recursive: true });
  const stream = path.join(r, ".kitchen", "jobs", "001-x", "activity", "m0-intake-1.jsonl");
  fs.writeFileSync(stream, "");
  const old = new Date(Date.now() - 60 * 60_000);
  const j = { id: "001-x", running: { lane: "intake", at: old.toISOString(), key: "k", stream: "activity/m0-intake-1.jsonl" } } as unknown as Job;
  assert.ok(laneBusy(r, j), "its hook wrote a moment ago");
  fs.utimesSync(stream, old, old);
  assert.ok(!laneBusy(r, j), "quiet for an hour: stranded");
  // Its orchestrator planned, opened or finished something lately (a long tool call, say): still busy.
  beat(r);
  assert.ok(laneBusy(r, j));
  beat(r, { by: "run" });
  assert.ok(!laneBusy(r, j), "kitchen run's own beats don't count");
});

test("a lane kitchen run opened is claimed before its session starts: an in-session restart leaves it while the run lives", async () => {
  const r = await repo(["one change"]);
  const [id] = listJobs(r).map((j) => j.id);
  const s = await start(r, id, "intake", { by: "run" });
  assert.ok("key" in s);
  assert.deepEqual(findJob(r, id).running?.session, { pid: 0, start: null, pending: true });
  assert.ok(!finishing(findJob(r, id), () => false), "not Finishing: it hasn't started");
  const lock = tryFileLock(path.join(r, ".kitchen", "run.lock"));
  assert.ok("release" in lock);
  assert.deepEqual((await next(r, { restartStranded: true })).start, [], "the run that claimed it lives");
  lock.release();
  assert.deepEqual(
    (await next(r, { restartStranded: true })).start.map((x) => [x.id, x.restart]),
    [[id, true]],
    "that run is gone",
  );
});

test("stream lines: stamped with _t for the Activity tab; a lane's last words from claude or codex", () => {
  assert.deepEqual(JSON.parse(stamp('{"type":"assistant"}', "T")), { _t: "T", type: "assistant" });
  assert.equal(stamp("not json", "T"), "not json");
  assert.equal(laneWords('{"type":"result","result":"PASS"}'), "PASS");
  assert.equal(laneWords('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'), "done");
  assert.equal(laneWords('{"type":"assistant"}'), null);
});

test("parallel 2, three jobs: a fast lane is finished at once and the next job starts while the slow build still runs", { timeout: 90_000 }, async () => {
  const r = await repo(["slow change one", "fast change two", "fast change three"]);
  const ids = listJobs(r).map((j) => j.id);
  const [slow, two, three] = ids;
  const run = kitchenRun(r);
  assert.equal(await run.done, 0, run.lines.join("\n"));
  const l = run.lines;
  const slowEnd = at(l, new RegExp(`^${slow}  build agent: build done`));
  // 002 went through build, QA and review and merged while 001 still built; 003's build started then too.
  assert.ok(at(l, new RegExp(`^${two} .*merged into staging`)) < slowEnd, l.join("\n"));
  assert.ok(at(l, new RegExp(`^${three}  build agent started`)) < slowEnd, l.join("\n"));
  for (const id of ids) assert.equal(findJob(r, id).stage, "done", `${id}: ${l.join("\n")}`);
  assert.match(l.at(-2) ?? "", /^drained/);
  // Per-lane logs, the Activity stream stamped, the cost in the ledger under each job's lane.
  const jd = path.join(r, ".kitchen", "jobs", slow);
  assert.match(fs.readFileSync(path.join(jd, "rounds", "1", "build.jsonl"), "utf8"), /"type":"result"/);
  const act = findJob(r, slow).agentRuns.find((x) => x.stage === "build")?.stream as string;
  assert.match(fs.readFileSync(path.join(jd, act), "utf8"), /"_t":"/);
  const usd = readLedger(r).filter((x) => x.event === "session");
  assert.equal(usd.length, 12, "4 lanes × 3 jobs");
  assert.ok(usd.every((x) => x.usd === 0.01 && x.job !== "-"));
  assert.ok(!fs.existsSync(path.join(r, ".kitchen", "run.json")), "run.json goes with the run");
});

test("a lane that crashes leaves nothing: the refusal path runs it again, and the third refusal goes to a person", { timeout: 60_000 }, async () => {
  const r = await repo(["crash on start"]);
  const [id] = listJobs(r).map((j) => j.id);
  const run = kitchenRun(r);
  assert.equal(await run.done, 1, run.lines.join("\n"));
  assert.equal(run.lines.filter((x) => /intake agent exited 3 without a final line/.test(x)).length, 3, run.lines.join("\n"));
  at(run.lines, /intake again \(try 2 of 3\): no /);
  at(run.lines, /intake refused 3 times → needs-human/);
  // Three crashes in a row stop the run too (ADR 0030 §1).
  at(run.lines, /3 lane sessions in a row crashed .*Nothing more started/);
  assert.equal(findJob(r, id).stage, "needs-human");
});

test("kitchen run --stop ends every lane's group; the lanes stay open and the next run restarts them", { timeout: 60_000 }, async () => {
  const r = await repo(["freeze one", "freeze two"]);
  const run = kitchenRun(r);
  // Both lane sessions really started (their pids recorded, each leading its group) before --stop.
  const sessions = () =>
    waitFor(() => {
      const s = startedSessions(r);
      return s.length === 2 && s.every((p) => alive(-p)) && s;
    }, "two lane sessions");
  const pids = await sessions();
  const stop = execFileSync(process.execPath, [CLI, "run", "--stop", "--repo", r], { env: env(), encoding: "utf8" });
  assert.match(stop, /asked pid \d+ to stop; ended 2 lanes/);
  assert.equal(await run.done, 0, run.lines.join("\n"));
  at(run.lines, /intake agent stopped \(kitchen run --stop\)/);
  await waitFor(() => pids.every((p) => !alive(-p) && !alive(p)), `lane groups ${pids.join(", ")} gone`, 5_000);
  for (const j of listJobs(r)) assert.equal(j.running?.lane, "intake", "the lane stays open for the next run");
  // The next run starts both lanes again.
  const again = kitchenRun(r);
  await waitFor(() => again.lines.some((l) => /^wave: .*\(restart\)/.test(l)), "the restart wave");
  at(again.lines, /^wave: \d{3}-freeze-one intake \(restart\), \d{3}-freeze-two intake \(restart\)/);
  await sessions();
  execFileSync(process.execPath, [CLI, "run", "--stop", "--repo", r], { env: env(), encoding: "utf8" });
  assert.equal(await again.done, 0);
});

test("a lane whose session ended before Kitchen finished it (the run crashed in between) is finished by the next run", { timeout: 60_000 }, async () => {
  const r = await repo(["fast change one"]);
  const [id] = listJobs(r).map((j) => j.id);
  const s = await start(r, id, "intake");
  assert.ok("brief" in s);
  fs.writeFileSync(
    intakeFile(jobDirOf(r, id)),
    `DECISION: ACCEPT\nTITLE: ${id}\nKIND: feature\nRISK: low\nSURFACES: none\nFILES: f.txt\n\n## Criteria\n- C1 (cmd): f-${id}.txt exists\n`,
  );
  await updateJob(r, id, (j) => {
    if (j.running) j.running.session = { pid: 999_999, start: null, ended: new Date().toISOString() };
    return j;
  });
  assert.ok(
    finishing(findJob(r, id), () => false),
    "the dashboard says Finishing meanwhile",
  );
  const run = kitchenRun(r);
  assert.equal(await run.done, 0, run.lines.join("\n"));
  assert.ok(at(run.lines, /intake: its session ended before Kitchen finished it; finishing now/) < at(run.lines, /intake ACCEPT/));
  assert.ok(!run.lines.some((l) => /intake agent started/.test(l)), "intake isn't run again");
  assert.equal(findJob(r, id).stage, "done");
});

test("codex: each lane in its checkout; a Build may write its commit's git paths only; QA has the network", { timeout: 60_000 }, async () => {
  const r = await repo(["one change"], "agent: { tool: codex, max_usd: 5 }\n");
  const [id] = listJobs(r).map((j) => j.id);
  const seen = path.join(root, "codex-argv");
  const codex = path.join(root, "codex");
  fs.writeFileSync(codex, FAKE_CODEX, { mode: 0o755 });
  const c = spawn(process.execPath, [CLI, "run", "--repo", r], {
    cwd: r,
    env: { ...env(), KITCHEN_CODEX_BIN: codex, SEEN: seen },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outText = "";
  c.stdout.on("data", (d: Buffer) => (outText += d.toString()));
  assert.equal(await new Promise((res) => c.on("close", res)), 0, outText);
  assert.equal(findJob(r, id).stage, "done", outText);
  assert.match(outText, /Codex reports tokens, not dollars: no budget cap applies/);
  const argvOf = (lane: string) => fs.readFileSync(`${seen}-${lane}-${id}`, "utf8").trim().split("\n");
  const dirs = (a: string[]) => a.flatMap((x, i) => (a[i - 1] === "--add-dir" ? [x] : []));
  const intake = argvOf("intake");
  assert.equal(intake[0], `PWD=${path.join(r, ".kitchen", "intake", id)}`, "started in the lane's checkout");
  assert.equal(intake[intake.indexOf("-C") + 1], path.join(r, ".kitchen", "intake", id));
  assert.deepEqual(dirs(intake), [jobDirOf(r, id)], "intake writes only its job folder");
  const build = argvOf("build");
  assert.equal(build[0], `PWD=${path.join(r, ".worktrees", id)}`);
  const gd = path.join(r, ".git");
  assert.deepEqual(dirs(build), [
    jobDirOf(r, id),
    path.join(gd, "worktrees", id),
    path.join(gd, "objects"),
    path.join(gd, "refs", "heads", "kitchen"),
    path.join(gd, "logs", "refs", "heads", "kitchen"),
  ]);
  assert.ok(!build.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(argvOf("qa").includes("sandbox_workspace_write.network_access=true"), "QA drives the app on localhost");
  assert.ok(!build.some((x) => /dangerously|yolo|max-budget/.test(x)));
  const tokens = readLedger(r).filter((x) => x.event === "session" && x.job === id);
  assert.ok(
    tokens.length === 4 && tokens.every((x) => x.usd === undefined && (x.detail?.tokens as { output_tokens?: number } | undefined)?.output_tokens === 2),
  );
});

test("a tool that fails before any work (signed out) stops the run: no job burns its tries, every lane stays open", { timeout: 60_000 }, async () => {
  const r = await repo(["nologin one", "nologin two", "nologin three"]);
  const run = kitchenRun(r);
  assert.equal(await run.done, 1, run.lines.join("\n"));
  at(run.lines, /ended before doing anything: Invalid API key · Please run \/login\. Nothing more started; \d{3}-nologin-\w+ stays in intake/);
  assert.ok(!run.lines.some((l) => /refused|needs-human/.test(l)), run.lines.join("\n"));
  for (const j of listJobs(r)) {
    assert.equal(j.stage, "intake");
    assert.equal(j.tries ?? 0, 0);
  }
});

test("two runs started together: one works the queue, the other says it is already running", { timeout: 60_000 }, async () => {
  const r = await repo(["freeze one", "freeze two"]);
  const a = kitchenRun(r);
  const b = kitchenRun(r);
  const first = await Promise.race([a.done.then(() => a), b.done.then(() => b)]);
  at(first.lines, /^orchestrator: already running \(pid \d+/);
  const other = first === a ? b : a;
  await waitFor(() => startedSessions(r).length === 2, "the working run's two lane sessions");
  execFileSync(process.execPath, [CLI, "run", "--stop", "--repo", r], { env: env(), encoding: "utf8" });
  await other.done;
  assert.equal([...a.lines, ...b.lines].filter((l) => /agent started/.test(l)).length, 2, "one agent per lane");
  assert.ok(!fs.existsSync(path.join(r, ".kitchen", "run.lock")), "the lock goes with the run");
});

test("a lane an in-session orchestrator opened (no session) is left alone while it was seen lately", { timeout: 60_000 }, async () => {
  const r = await repo(["one change"]);
  const [id] = listJobs(r).map((j) => j.id);
  await next(r); // the in-session orchestrator's wave: its heartbeat
  const s = await start(r, id, "intake");
  assert.ok("key" in s);
  const run = kitchenRun(r);
  // The run planned its first wave (its own heartbeat) and left the lane alone.
  await waitFor(() => readHeartbeat(r)?.by === "run", "the run's first plan");
  execFileSync(process.execPath, [CLI, "run", "--stop", "--repo", r], { env: env(), encoding: "utf8" });
  await run.done;
  assert.ok(!run.lines.some((l) => /agent started|restart/.test(l)), run.lines.join("\n"));
  assert.equal(findJob(r, id).running?.key, s.key);
});

test("--max-usd is the run's: each lane holds its share of what is left over the free slots", { timeout: 60_000 }, async () => {
  const r = await repo(["linger one", "linger two"]);
  const seen = path.join(root, "budget");
  const c = spawn(process.execPath, [CLI, "run", "--repo", r, "--max-usd", "1"], { cwd: r, env: { ...env(), SEEN: seen }, stdio: ["ignore", "pipe", "pipe"] });
  let outText = "";
  c.stdout.on("data", (d: Buffer) => (outText += d.toString()));
  assert.equal(await new Promise((res) => c.on("close", res)), 0, outText);
  const budgetOf = (f: string) => {
    const a = fs.readFileSync(f, "utf8").split("\n");
    return a[a.indexOf("--max-budget-usd") + 1];
  };
  const ids = listJobs(r).map((j) => j.id);
  // Two intakes at once, $1 left, two to start: $0.50 each (not $1 each).
  assert.deepEqual(
    ids.map((id) => budgetOf(`${seen}-intake-${id}`)),
    ["0.50", "0.50"],
  );
  assert.match(outText, /\$0\.08 spent in this run/);
});

test("--max-usd too small for another lane: nothing new starts and the run says why; a lane at its cap stays open", { timeout: 60_000 }, async () => {
  const r = await repo(["linger one", "linger two"]);
  const run = spawn(process.execPath, [CLI, "run", "--repo", r, "--max-usd", "0.3"], { cwd: r, env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let outText = "";
  run.stdout.on("data", (d: Buffer) => (outText += d.toString()));
  await new Promise((res) => run.on("close", res));
  // $0.30 over two intakes is $0.15 each, under the $0.25 a lane needs: one starts holding $0.25, the other waits
  // until that one's result gives back what it didn't spend.
  const said = outText.split("\n");
  const waits = said.findIndex((l) => /budget left \$0\.05 \(of \$0\.30\) is below what a lane needs \(\$0\.25\): nothing new starts/.test(l));
  assert.ok(waits > 0, outText);
  const second = said.findIndex((l, i) => i > waits && /intake agent started/.test(l));
  assert.ok(second > said.findIndex((l) => /intake ACCEPT/.test(l)), outText);
  // A whole budget under $0.25 still starts a lane: the floor is never more than the budget.
  const tiny = await repo(["one change"]);
  const seen = path.join(root, "tiny");
  const t = spawn(process.execPath, [CLI, "run", "--repo", tiny, "--max-usd", "0.1"], {
    cwd: tiny,
    env: { ...env(), SEEN: seen },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tinyText = "";
  t.stdout.on("data", (d: Buffer) => (tinyText += d.toString()));
  await new Promise((res) => t.on("close", res));
  const a = fs.readFileSync(`${seen}-intake-${listJobs(tiny)[0].id}`, "utf8").split("\n");
  assert.equal(a[a.indexOf("--max-budget-usd") + 1], "0.10", tinyText);
  const o = await repo(["overbudget one"]);
  const capped = spawn(process.execPath, [CLI, "run", "--repo", o, "--max-usd", "5"], { cwd: o, env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let cappedText = "";
  capped.stdout.on("data", (d: Buffer) => (cappedText += d.toString()));
  await new Promise((res) => capped.on("close", res));
  assert.match(cappedText, /intake agent reached its share of the budget: the lane stays open/);
  const [j] = listJobs(o);
  assert.deepEqual([j.stage, j.running?.lane, j.tries ?? 0], ["intake", "intake", 0]);
});

test("kitchen stop on three jobs: each lane ends as the person's stop, not a crash; the run goes on with the fourth", { timeout: 60_000 }, async () => {
  const r = await repo(["freeze one", "freeze two", "freeze three", "fast four"]);
  const run = kitchenRun(r);
  const ids = listJobs(r).map((j) => j.id);
  await waitFor(() => startedSessions(r, /freeze/).length === 3, "three freeze sessions");
  for (const id of ids.slice(0, 3)) execFileSync(process.execPath, [CLI, "stop", id, "--repo", r], { env: env(), encoding: "utf8" });
  assert.equal(await run.done, 0, run.lines.join("\n"));
  assert.equal(run.lines.filter((l) => /intake agent stopped by the person/.test(l)).length, 3, run.lines.join("\n"));
  assert.ok(!run.lines.some((l) => /crashed|before doing anything|Nothing more started/.test(l)), run.lines.join("\n"));
  assert.equal(findJob(r, ids[3]).stage, "done");
  for (const id of ids.slice(0, 3)) assert.equal(findJob(r, id).stage, "paused");
});

test("two `kitchen run --detach` together: one child takes the lock, the other parent says it is already running", { timeout: 60_000 }, async () => {
  const r = await repo(["freeze one"]);
  const det = () =>
    new Promise<string>((res) => {
      const c = spawn(process.execPath, [CLI, "run", "--detach", "--repo", r], { cwd: r, env: env(), stdio: ["ignore", "pipe", "pipe"] });
      let t = "";
      c.stdout.on("data", (d: Buffer) => (t += d.toString()));
      c.on("close", () => res(t));
    });
  const said = await Promise.all([det(), det()]);
  assert.equal(said.filter((t) => /orchestrator detached: pid \d+/.test(t)).length, 1, said.join("\n"));
  assert.equal(said.filter((t) => /orchestrator: already running/.test(t)).length, 1, said.join("\n"));
  execFileSync(process.execPath, [CLI, "run", "--stop", "--repo", r], { env: env(), encoding: "utf8" });
});

test("a check with a high-severity finding: qa, then done with it proposed (ADR 0036), each lane run by the run", { timeout: 60_000 }, async () => {
  const r = await repo(["inspect renewing loans"]);
  const [id] = listJobs(r).map((j) => j.id);
  const run = kitchenRun(r);
  assert.equal(await run.done, 0, run.lines.join("\n"));
  const l = run.lines;
  assert.ok(at(l, /qa agent started/) < at(l, /Found 1 problem · proposed p1 in the inbox → done/), l.join("\n"));
  const j = findJob(r, id);
  assert.equal(j.stage, "done", l.join("\n"));
  assert.deepEqual(
    j.agentRuns.map((x) => x.stage),
    ["intake", "qa"],
  );
});
