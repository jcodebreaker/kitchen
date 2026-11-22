// W1 exit, part 2: kill -9 the runner mid-stage, restart `kitchen run`.
// The job resumes from its stage, the stage re-runs idempotently, no side
// effect happens twice (filed keys, ledger keys, fake forge counters), the
// stale run lock is taken over, an unsigned manifest tail is cut back.
// Also: a live owner with a 200 s old heartbeat loses the lock; a fresh one keeps it.
//   node spikes/w1/kill.ts <scratch dir>
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { processStart } from "../../src/lock.ts";
import { CLI, check, finish, forge, HERE, jobDir, jobOf, kitchen, makeRepo, ROOT, sleep, stagesOf, ticket } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"));
fs.mkdirSync(root, { recursive: true });

const r = makeRepo(root, "kill");
const id = ticket(r, "Survive a crash\nscenario: kill");
const dir = jobDir(r, id);
const logFile = path.join(root, "kill-run1.log");
const fd = fs.openSync(logFile, "w");
const child = spawn(process.execPath, [CLI, "run", "--repo", r.dir], { env: r.env, stdio: ["ignore", fd, fd] });
const marker = path.join(r.dir, `hang-${id}-verifier-drives`);
for (let i = 0; i < 300 && !fs.existsSync(marker); i++) await sleep(100);
check("runner reached drives and the verifier is mid-run", fs.existsSync(marker));

const before = jobOf(r, id);
const slots = JSON.parse(fs.readFileSync(path.join(r.home, "slots.json"), "utf8")) as { slots: { id: string; pid: number; n: number }[] };
check(
  "before the kill: stage drives, marked running, build committed + published, gate stamped",
  before.stage === "drives" && before.running?.pid === child.pid && before.filed.some((k) => k.startsWith("publish/")) && before.manifestHead.n === 1,
  `stage ${before.stage}, running pid ${before.running?.pid}, filed ${before.filed.join(",")}, manifest n=${before.manifestHead.n}`,
);
check(
  "the runner holds a port slot",
  slots.slots.some((s) => s.id === id && s.pid === child.pid),
);

child.kill("SIGKILL");
await new Promise((res) => child.once("exit", res));
fs.closeSync(fd);
check("runner killed with -9; its run.lock is left behind", fs.existsSync(path.join(r.dir, ".kitchen", "run.lock")));

// A crash between a manifest append and the job.json head write: one more line past the signed head.
const ev = path.join(dir, "evidence");
const lines = fs.readFileSync(path.join(ev, "manifest.jsonl"), "utf8").trimEnd().split("\n");
const last = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
const orphan = {
  ...last,
  id: `e${lines.length + 1}`,
  prev: createHash("sha256")
    .update(lines.at(-1) as string)
    .digest("hex"),
  criterion: "C1",
  role: "verifier",
  files: [],
};
fs.mkdirSync(path.join(ev, `e${lines.length + 1}`), { recursive: true });
fs.writeFileSync(path.join(ev, `e${lines.length + 1}`, "call.json"), "{}");
fs.appendFileSync(path.join(ev, "manifest.jsonl"), `${JSON.stringify(orphan)}\n`);

const again = kitchen(r, "run");
fs.writeFileSync(path.join(root, "kill-run2.log"), again.out);
const after = jobOf(r, id);
check(
  "restart takes over the stale run lock",
  new RegExp(`took over the run lock \\(owner pid ${child.pid} is gone\\)`).test(again.out),
  again.out.split("\n")[0],
);
check(
  "stale slot reclaimed with its own Toolkit's down",
  new RegExp(`reclaimed: owner pid ${child.pid} is gone`).test(again.out) &&
    /down --id/.test(fs.readFileSync(path.join(r.dir, ".kitchen/toolkit/calls.log"), "utf8")),
);
check(
  "unsigned manifest tail cut back to the signed head",
  /manifest: 1 unsigned line\(s\) past the signed head cut/.test(again.out) && fs.readdirSync(ev).some((f) => f.startsWith("manifest.jsonl.tail-")),
);
check("the job resumes from its stage", new RegExp(`${id}  resume drives \\(interrupted`).test(again.out));
check("the job finishes", after.stage === "done", stagesOf(r, id).join(" → "));
check(
  "path has no repeated move",
  stagesOf(r, id).join(" → ") === "intake → build → gate → drives → verify → review → ready → report → done",
  stagesOf(r, id).join(" → "),
);
check(
  "build not re-run (one builder run), drives re-run once (the killed call left no file)",
  after.agentRuns.filter((a) => a.role === "builder").length === 1 && after.agentRuns.filter((a) => a.stage === "drives").length === 1,
);
const state = JSON.parse(fs.readFileSync(r.env.KITCHEN_FAKE_STATE as string, "utf8")) as Record<string, number>;
check("the verifier was called twice for drives (killed + rerun)", state[`${id}/verifier:drives`] === 2, JSON.stringify(state));
const f = forge(r);
check(
  "no duplicate side effects on the forge: 1 PR created, 1 push, 1 comment, 1 evidence push",
  f.prs.length === 1 && f.prs[0].creates === 1 && f.prs[0].pushes === 1 && f.comments[0]?.calls === 1 && f.evidence[0]?.calls === 1,
  JSON.stringify(f.prs[0]),
);
check("filed keys are unique", new Set(after.filed).size === after.filed.length, after.filed.join(", "));
const raw = fs
  .readFileSync(path.join(r.dir, ".kitchen", "ledger.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { key: string; event: string });
const moveKeys = raw.filter((l) => l.event === "move").map((l) => l.key);
check("ledger: every move key once", new Set(moveKeys).size === moveKeys.length, `${moveKeys.length} moves`);
check(
  "ledger records the crash: lock-takeover, resumed, manifest-truncated",
  ["lock-takeover", "resumed", "manifest-truncated"].every((e) => raw.some((l) => l.event === e)),
);
const gateRuns = fs
  .readFileSync(path.join(ev, "manifest.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter((l) => /"criterion":"gate"/.test(l)).length;
check("gate checks ran once (not repeated by the resume)", gateRuns === 1, `${gateRuns} gate entries`);
const v = spawnSync(process.execPath, [path.join(ROOT, "src/proof/cli.ts"), "verify", dir], { env: r.env, encoding: "utf8" });
check("the manifest verifies against the signed head after the restart", v.status === 0 && /"ok":true/.test(v.stdout), v.stdout.trim());

// The run lock by heartbeat age: a live owner whose heartbeat is 200 s old is taken over; a fresh one is not.
const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
await sleep(200);
const lockFile = path.join(r.dir, ".kitchen", "run.lock");
const owner = { pid: sleeper.pid, start: processStart(sleeper.pid as number), startedAt: new Date().toISOString() };
fs.writeFileSync(lockFile, JSON.stringify({ ...owner, heartbeat: new Date().toISOString() }));
const held = kitchen(r, "run", "--once");
check(
  "a live owner with a fresh heartbeat keeps the lock",
  held.code === 1 && new RegExp(`already running \\(pid ${sleeper.pid}`).test(held.out),
  held.out.trim(),
);
fs.writeFileSync(lockFile, JSON.stringify({ ...owner, heartbeat: new Date(Date.now() - 200_000).toISOString() }));
const took = kitchen(r, "run", "--once");
check("a live owner whose heartbeat is 200 s old loses the lock", /took over the run lock \(heartbeat 200s old\)/.test(took.out), took.out.split("\n")[0]);
sleeper.kill();

// ---- Part 2: the agent is a real subprocess (a stub `claude` via KITCHEN_CLAUDE_BIN / agent.command).
// It hangs in drives; kill -9 the runner: the agent lives on (an orphan). The restart must kill its
// process group and wait for it before drives runs again, so exactly one agent runs the stage.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pgidOf = (pid: number) => Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
const yaml = (agent: string, checks: string) =>
  `concurrency: 2\nagent: ${agent}\nforge: { kind: fake }\nchecks:\n${checks}\nbackoff: { base_sec: 1, max_sec: 2 }\n`;
const GATE_CHECK = '  - { name: no-gate-fail, run: "test ! -f GATE_FAIL" }';

async function killMidStage(r: ReturnType<typeof makeRepo>, label: string, pidFile: string) {
  const log = path.join(root, `${label}-run1.log`);
  const out = fs.openSync(log, "w");
  const runner = spawn(process.execPath, [CLI, "run", "--repo", r.dir], { env: r.env, stdio: ["ignore", out, out] });
  for (let i = 0; i < 300 && !fs.existsSync(pidFile); i++) await sleep(100);
  await sleep(300);
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  runner.kill("SIGKILL");
  await new Promise((res) => runner.once("exit", res));
  fs.closeSync(out);
  return { pid, runnerPid: runner.pid as number };
}

{
  const ra = makeRepo(root, "kill-agent");
  const wrapper = path.join(root, "stub-claude");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "spikes/w1/stub-agent.ts"))} "$@"\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(ra.dir, "kitchen.yaml"), yaml(`{ tool: claude, command: [${JSON.stringify(wrapper)}] }`, GATE_CHECK));
  const ida = ticket(ra, "Survive a crash with a real agent process\nscenario: kill");
  const { pid: agent, runnerPid } = await killMidStage(ra, "kill-agent", path.join(ra.dir, `hang-${ida}-verifier-drives`));
  const procs = path.join(jobDir(ra, ida), "procs");
  check(
    "the agent runs as its own process group, recorded in the job's procs/",
    agent > 0 && pgidOf(agent) === agent && fs.existsSync(path.join(procs, `${agent}.json`)),
    `agent pid ${agent}, pgid ${pgidOf(agent)}`,
  );
  check("after kill -9 of the runner the agent is still running (an orphan)", alive(agent));
  const again = kitchen(ra, "run");
  fs.writeFileSync(path.join(root, "kill-agent-run2.log"), again.out);
  check(
    "restart kills the orphan's process group before resuming",
    new RegExp(`${ida}  killed agent verifier left running by pid ${runnerPid} \\(process group ${agent}\\)`).test(again.out) &&
      again.out.indexOf("killed agent") < again.out.indexOf(`${ida}  resume drives`),
    again.out
      .split("\n")
      .filter((l) => /killed|resume/.test(l))
      .join(" | "),
  );
  check("the old agent is dead", !alive(agent));
  const runs = fs.readFileSync(path.join(ra.dir, ".kitchen", "stub-agents.log"), "utf8");
  const starts = [...runs.matchAll(/^start (\d+) drives\.md overlap=(.*)$/gm)];
  const dones = [...runs.matchAll(/^done (\d+) drives\.md$/gm)];
  check(
    "exactly one agent ran the drives stage to the end, and none ran next to another",
    starts.length === 2 && dones.length === 1 && dones[0][1] !== String(agent) && [...runs.matchAll(/overlap=(\S+)/g)].length === 0,
    runs.trim().replace(/\n/g, " | "),
  );
  const ja = jobOf(ra, ida);
  check(
    "the job finishes; no procs records are left",
    ja.stage === "done" && (!fs.existsSync(procs) || fs.readdirSync(procs).length === 0),
    stagesOf(ra, ida).join(" → "),
  );
}

// ---- Part 3: a gate check (a per-job subprocess) hangs; kill -9 the runner; the restart kills it too.
{
  const rc = makeRepo(root, "kill-check");
  const pidFile = path.join(rc.dir, "check-pid");
  const trigger = path.join(rc.dir, "hang-check");
  const hang = `if [ -f ${trigger} ]; then rm ${trigger}; echo $$ > ${pidFile}; sleep 600; fi`;
  fs.writeFileSync(
    path.join(rc.dir, "kitchen.yaml"),
    yaml(`{ tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-script.ts"))} }`, `${GATE_CHECK}\n  - { name: slow, run: ${JSON.stringify(hang)} }`),
  );
  fs.writeFileSync(trigger, "");
  const idc = ticket(rc, "Survive a crash mid-check\nscenario: chore");
  const { pid: sh, runnerPid } = await killMidStage(rc, "kill-check", pidFile);
  check("the check runs as its own process group; it outlives the killed runner", pgidOf(sh) === sh && alive(sh), `pid ${sh}`);
  const again = kitchen(rc, "run");
  fs.writeFileSync(path.join(root, "kill-check-run2.log"), again.out);
  check(
    "restart kills the orphaned check's group (the shell and its sleep) before resuming the gate",
    new RegExp(`${idc}  killed check slow left running by pid ${runnerPid} \\(process group ${sh}\\)`).test(again.out) && !alive(sh),
    again.out
      .split("\n")
      .filter((l) => /killed|resume/.test(l))
      .join(" | "),
  );
  const leftover = spawnSync("pgrep", ["-g", String(sh)], { encoding: "utf8" }).stdout.trim();
  check("nothing is left in that process group", leftover === "", leftover);
  check("the job finishes", jobOf(rc, idc).stage === "done", stagesOf(rc, idc).join(" → "));
}

// ---- Part 4: a check started through the bridge; the agent's group (agent + bridge) is SIGKILLed.
// The bridge dies without its exit handler, so its check (its own group) lives on. runRole reaps the
// job's records whose owner is dead once the agent returns: the check is dead before the stage retries.
{
  const rb = makeRepo(root, "kill-bridge");
  const wrapper = path.join(root, "stub-claude");
  const pidFile = path.join(rb.dir, "check-pid");
  const trigger = path.join(rb.dir, "hang-check");
  const hang = `if [ -f ${trigger} ]; then rm ${trigger}; echo $$ > ${pidFile}; sleep 600; fi`;
  fs.writeFileSync(
    path.join(rb.dir, "kitchen.yaml"),
    yaml(`{ tool: claude, command: [${JSON.stringify(wrapper)}] }`, `${GATE_CHECK}\n  - { name: slow, run: ${JSON.stringify(hang)} }`),
  );
  fs.writeFileSync(trigger, "");
  fs.writeFileSync(path.join(rb.dir, "bridge-kill"), "");
  const idb = ticket(rb, "A bridge check outlives its agent\nscenario: chore");
  const out = kitchen(rb, "run");
  fs.writeFileSync(path.join(root, "kill-bridge-run.log"), out.out);
  const sh = Number(fs.readFileSync(pidFile, "utf8").trim());
  const bridgePid = Number(/^bridge-kill (\d+)$/m.exec(fs.readFileSync(path.join(rb.dir, ".kitchen", "stub-agents.log"), "utf8"))?.[1]);
  check("the check ran in its own process group, started by the bridge", sh > 0 && bridgePid > 0, `check ${sh}, bridge ${bridgePid}`);
  const killedAt = out.out.indexOf(`killed check slow left running by pid ${bridgePid} (process group ${sh})`);
  const retryAt = out.out.indexOf("build: builder:", out.out.indexOf("build: builder:") + 1);
  check(
    "after the agent returns, runRole kills the check the dead bridge left (before the builder runs again)",
    killedAt >= 0 && retryAt > killedAt && /build: killed check slow/.test(out.out),
    out.out
      .split("\n")
      .filter((l) => /killed|builder:|error/.test(l))
      .join(" | "),
  );
  check("the check is dead and nothing is left in its group", !alive(sh) && spawnSync("pgrep", ["-g", String(sh)], { encoding: "utf8" }).stdout.trim() === "");
  const procs = path.join(jobDir(rb, idb), "procs");
  check(
    "the job finishes; no procs records are left",
    jobOf(rb, idb).stage === "done" && (!fs.existsSync(procs) || fs.readdirSync(procs).length === 0),
    stagesOf(rb, idb).join(" → "),
  );
}
finish("w1 kill");
