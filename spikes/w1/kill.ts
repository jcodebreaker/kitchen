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
import { CLI, check, finish, forge, jobDir, jobOf, kitchen, makeRepo, ROOT, sleep, stagesOf, ticket } from "./lib.ts";

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
finish("w1 kill");
