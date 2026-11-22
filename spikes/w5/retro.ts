// W5 retro spike, scripted (no model, no Docker): a repo with a synthetic history of six
// finished jobs, then the real `kitchen` CLI.
//   node spikes/w5/retro.ts [scratch]
// What it proves (PASS/FAIL lines, exit 1 on any miss):
// - `kitchen run` starts the retro by itself once retro.every_jobs (5) jobs have finished;
// - code/naming is muted after 3 dismissals: two by `kitchen dismiss`, one a trusted person's
//   "not useful" reply on the PR read through the forge; an untrusted one is ignored; security
//   findings are never muted, however often dismissed; review's mute check names the reason;
// - at most retro.max_tickets (2) lesson drafts are filed through the TicketSource, unlabelled,
//   from the strongest signals (Toolkit gap, flaky drive, repeated escalation, blocking category);
//   a lesson for a signal the engine did not give is refused;
// - running the retro again on the same ledger mutes nothing and files nothing new;
// - `kitchen retro unmute` lifts the mute and the same dismissals don't mute it again;
// - `kitchen retro approve 1` turns a draft into a ticket.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { updateJob } from "../../src/engine/store.ts";
import { type FakeForgeState, readFakeForge } from "../../src/forge/forge.ts";
import { appendLedger, type LedgerLine, readLedger } from "../../src/ledger/append.ts";
import { mutedFinding, readRetroState } from "../../src/retro/state.ts";
import { check, finish } from "../w1/lib.ts";

const HERE = import.meta.dirname;
const CLI = path.resolve(HERE, "..", "..", "src", "cli.ts");
const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work"));
const dir = path.join(root, "retro");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=spike", "-c", "user.email=s@example.invalid", ...a], { cwd: dir, stdio: "pipe" });
fs.writeFileSync(path.join(dir, "README.md"), "# retro spike\n");
fs.writeFileSync(path.join(dir, ".gitignore"), ".kitchen/\n");
fs.writeFileSync(
  path.join(dir, "kitchen.yaml"),
  `agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-retro.ts"))} }
forge: { kind: fake }
retro: { every_jobs: 5, mute_after: 3, max_tickets: 2 }
feedback: { trusted: [maintainer-alice], trust_associations: [] }
`,
);
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "init");
const home = path.join(root, "retro-home");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const env = { ...process.env, KITCHEN_HOME: home, KITCHEN_TICK_MS: "100" };
const kitchen = (...args: string[]) => {
  const p = spawnSync(process.execPath, [CLI, ...args, "--repo", dir], { env, encoding: "utf8", timeout: 120_000 });
  const out = `${p.stdout}${p.stderr}`;
  if (process.env.W5_VERBOSE) process.stdout.write(out.replace(/^/gm, `    [${args[0]}] `));
  return { out, code: p.status ?? -1 };
};
const editForge = (fn: (s: FakeForgeState) => void) => {
  const f = path.join(dir, ".kitchen", "fake-forge.json");
  const s = readFakeForge(f);
  fn(s);
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
};

// The synthetic history: six jobs, made by `kitchen ticket`, their ledger and review files written as the stages would.
const ids: string[] = [];
for (const t of ["count projects", "slug trap", "invite case", "dark mode", "admin list", "order email"]) {
  const m = /ticket (\S+)/.exec(kitchen("ticket", `On the home page, ${t}`).out);
  if (!m) throw new Error("no job");
  ids.push(m[1]);
}
let sec = 0;
const t = () => new Date(Date.UTC(2026, 10, 22, 9, 0, sec++)).toISOString();
const L = (job: string, l: Omit<LedgerLine, "t" | "job">) => appendLedger(dir, { t: t(), job, ...l });
const walk = (job: string, stages: string[], end: { to: string; note?: string }) => {
  const all = [...stages];
  for (let i = 0; i + 1 < all.length; i++)
    L(job, { stage: all[i], round: 1, event: "move", result: all[i + 1], key: `${job}/m${i + 1}`, detail: { row: `${all[i]}>${all[i + 1]}` } });
  L(job, {
    stage: all.at(-1) as string,
    round: 3,
    event: "move",
    result: end.to,
    key: `${job}/m-end`,
    detail: { row: `x>${end.to}`, ...(end.note ? { note: end.note } : {}) },
  });
};
const PATH = ["intake", "build", "gate", "drives", "verify", "review", "ready", "report"];
for (const [i, job] of ids.entries()) {
  L(job, { stage: "intake", round: 1, event: "agent", role: "intake", usd: 0.05, key: `${job}/intake`, detail: { line: "ACCEPT feature low: x" } });
  const gap = i < 2;
  const flaky = i === 2 || i === 3;
  L(job, {
    stage: "verify",
    round: 1,
    event: "proof",
    result: gap ? "TOOLKIT-GAP" : flaky ? "INCONCLUSIVE" : "PASS",
    key: `${job}/proof/1`,
    detail: { criterion: "C1", drives: gap ? ["sql"] : ["login", "projects.open"], head: "h1", ...(gap ? { gap: "sql" } : {}) },
  });
  if (flaky)
    L(job, {
      stage: "verify",
      round: 1,
      event: "proof",
      result: "PASS",
      key: `${job}/proof/2`,
      detail: { criterion: "C1", drives: ["login", "projects.open"], head: "h1" },
    });
  const escalated = i >= 4;
  walk(
    job,
    escalated ? PATH.slice(0, 6) : PATH,
    escalated ? { to: "needs-human", note: "round-limit: review → build: round limit: 3 of 3 rounds used" } : { to: "done" },
  );
  if (i < 4) {
    const findings = [
      { id: "code-1-1", lens: "code", also: [], title: "Rename `cnt` to `count`", blocks: true },
      { id: "code-1-2", lens: "code", also: [], title: "Missing unit test for the parser", blocks: i < 3 },
      { id: "security-1-1", lens: "security", also: [], title: "Rename the token variable", blocks: false },
    ];
    const rd = path.join(dir, ".kitchen", "jobs", job, "rounds", "1");
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, "review.json"), JSON.stringify({ head: "h1", round: 1, lenses: ["code", "security"], findings, stats: [] }));
  }
  await updateJob(dir, job, (j) => {
    // The PRs (jobs 2 and 3) are on done jobs: the retro reads replies of done jobs only (retro.lookback_days).
    j.stage = escalated ? "needs-human" : "done";
    j.pr = i === 2 || i === 3 ? 10 + i : null;
    return j;
  });
}
// Dismissals: two by hand, one trusted and one untrusted reply on PRs (fake forge), three on security.
kitchen("dismiss", ids[0], "code-1-1", "--reason", "a rename is not worth a round");
kitchen("dismiss", ids[1], "code-1-1");
for (const j of ids.slice(0, 3)) kitchen("dismiss", j, "security-1-1", "--reason", "the variable is never logged or sent");
const noReason = kitchen("dismiss", ids[3], "security-1-1");
editForge((s) => {
  s.reviewComments.push(
    { id: "c1", pr: 12, author: "maintainer-alice", association: "NONE", body: "code-1-1 is not useful", at: "2026-11-22T09:30:00Z" },
    { id: "c2", pr: 13, author: "drive-by", association: "NONE", body: "code-1-1 not useful", at: "2026-11-22T09:31:00Z" },
    // A trusted thumbs-down on a security finding, with no reason: not a dismissal.
    { id: "c3", pr: 13, author: "maintainer-alice", association: "NONE", body: "👎 security-1-1", at: "2026-11-22T09:32:00Z" },
  );
});

// 1. `kitchen run` starts the retro: six finished, every_jobs 5.
const run1 = kitchen("run", "--once");
const st1 = readRetroState(dir);
const led1 = readLedger(dir);
check(
  "kitchen run started the retro once 5 jobs had finished",
  led1.some((l) => l.event === "retro"),
  run1.out
    .split("\n")
    .filter((l) => l.startsWith("retro:"))
    .join(" | "),
);
check(
  "code/naming muted after 3 dismissals (2 kitchen dismiss + 1 trusted PR reply)",
  st1.mutes.length === 1 && st1.mutes[0].lens === "code" && st1.mutes[0].category === "naming" && st1.mutes[0].dismissals === 3,
  JSON.stringify(st1.mutes.map((m) => [m.lens, m.category, m.dismissals, m.findings])),
);
const forgeDis = led1.filter((l) => l.event === "finding-dismissed" && l.detail?.source === "forge");
check(
  "the trusted reply became a dismissal, the untrusted one did not",
  forgeDis.length === 1 && forgeDis[0].job === ids[2],
  forgeDis.map((l) => `${l.job} ${l.detail?.reason}`).join("; "),
);
check("security is never muted, after 3 dismissals", !st1.mutes.some((m) => m.lens === "security"));
check(
  "a security finding is dismissed only with a reason: kitchen dismiss refuses without one, and so does the retro for a PR reply",
  noReason.code !== 0 &&
    /needs a reason|only with a reason/.test(noReason.out) &&
    !led1.some((l) => l.event === "finding-dismissed" && l.job === ids[3]) &&
    /security-1-1 \(security\) not dismissed: a security finding needs a reason/.test(run1.out) &&
    led1.filter((l) => l.event === "finding-dismissed" && l.detail?.lens === "security").every((l) => !!l.detail?.reason),
  noReason.out.trim().split("\n")[0],
);
const why = mutedFinding(dir, { lens: "code", title: "Rename `x` to `y`" });
check("review's mute check: a code naming finding is a note, with the reason", !!why?.includes("kitchen retro unmute code/naming"), why ?? "");
check(
  "review's mute check: other categories and lenses still block",
  !mutedFinding(dir, { lens: "code", title: "Missing test" }) && !mutedFinding(dir, { lens: "ux", title: "Rename" }),
);
const drafts = () => {
  const d = path.join(dir, ".kitchen", "retro", "drafts");
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};
const d1 = drafts();
check("at most 2 (max_tickets) lesson drafts filed through the TicketSource", d1.length === 2 && st1.filed.length === 2, d1.join(", "));
check(
  "from the strongest signals: the sql gap, the flaky login drive, the round-limit escalation or blocking code/tests findings",
  st1.filed.every((f) => ["gap:sql", "drive:login>projects.open", "escalation:round-limit", "findings:code/tests"].includes(f.signal)),
  st1.filed.map((f) => `${f.signal} (${f.kind})`).join(", "),
);
const body = d1.length ? fs.readFileSync(path.join(dir, ".kitchen", "retro", "drafts", d1[0]), "utf8") : "";
check(
  "a draft says it is a draft and how to approve it",
  body.includes("Kitchen does not work on it until a person approves it") && body.includes("kitchen retro approve"),
);
check("no draft became a job by itself", fs.readdirSync(path.join(dir, ".kitchen", "jobs")).length === 6);
check(
  "the lesson for a signal it wasn't given was refused",
  led1.some((l) => l.event === "retro" && Number(l.detail?.refused) >= 1),
);
check(
  "the retro's agent ran on the cheap tier (retro role)",
  led1.some((l) => l.event === "agent" && l.role === "retro"),
);

// 2. Again on the same ledger: nothing new.
const again = kitchen("retro");
const st2 = readRetroState(dir);
check(
  "re-running the retro mutes nothing and files nothing new",
  st2.mutes.length === 1 && st2.filed.length === 2 && drafts().length === 2,
  again.out.trim().split("\n").at(-1),
);
check("…and starts no agent", readLedger(dir).filter((l) => l.event === "agent" && l.role === "retro").length === 1);

// 3. Unmute, then the same dismissals don't mute again.
const un = kitchen("retro", "unmute", "code/naming");
check(
  "kitchen retro unmute lifts the mute",
  un.code === 0 && readRetroState(dir).mutes.length === 0 && !mutedFinding(dir, { lens: "code", title: "Rename a" }),
  un.out.trim(),
);
kitchen("retro");
check("the same 3 dismissals don't mute it again (it needs 3 new ones)", readRetroState(dir).mutes.length === 0);
const status = kitchen("retro", "status");
check(
  "kitchen retro status lists the drafts",
  status.out.includes("lesson drafts:") && status.out.includes("draft:001"),
  status.out.trim().split("\n").join(" | "),
);

// 4. Approve a draft: it becomes a ticket.
const ap = kitchen("retro", "approve", "1");
check("kitchen retro approve 1 makes the draft a ticket", ap.code === 0 && fs.readdirSync(path.join(dir, ".kitchen", "jobs")).length === 7, ap.out.trim());
finish("w5 retro");
