// W1 faults: what goes wrong around the jobs, through the real CLI with the fake adapter.
//   - human commands that the table refuses change nothing (no counter, no escalation)
//   - a corrupt job.json is listed as corrupt and skipped; the other jobs run
//   - a worktree folder left half-made is moved aside and the worktree made again
//   - an engine failure (not the agent's) escalates as engine-error, after one retry
//   - an empty run.lock is not taken over until it has stayed unreadable for 2 s
//   - a torn last ledger line doesn't swallow the next line
//   node spikes/w1/faults.ts <scratch dir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, finish, jobDir, jobOf, kitchen, makeRepo, stagesOf, stepUntil, ticket } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"));
fs.mkdirSync(root, { recursive: true });
const jobJson = (r: { dir: string }, id: string) => path.join(r.dir, ".kitchen", "jobs", id, "job.json");

// 1. Refused human commands: no side effect, never needs-human
{
  const r = makeRepo(root, "human-refusal");
  const id = ticket(r, "Human refusals\nscenario: chore");
  stepUntil(r, id, "build");
  const before = fs.readFileSync(jobJson(r, id), "utf8");
  const rejects = [1, 2, 3].map(() => kitchen(r, "reject", id));
  check(
    "reject ×3 on a job in build: each refused with its reason, exit 1",
    rejects.every((x) => x.code === 1 && /refused (no move build → rejected|build → rejected: .+)/.test(x.out)),
    rejects[2].out.trim(),
  );
  check("…and job.json is byte for byte unchanged (stage build, no refusal counted)", fs.readFileSync(jobJson(r, id), "utf8") === before, jobOf(r, id).stage);
  const resumes = [1, 2].map(() => kitchen(r, "resume", id));
  check("resume on a running job says why and changes nothing", resumes.every((x) => x.code === 1) && fs.readFileSync(jobJson(r, id), "utf8") === before);

  kitchen(r, "run");
  check("the job then finishes normally", jobOf(r, id).stage === "done");
  const fb = [1, 2, 3].map((n) => kitchen(r, "feedback", id, `change ${n}`));
  const j = jobOf(r, id);
  check(
    "feedback ×3 on a done job: the first moves done → build, the next two are refused and the job stays in build",
    fb[0].code === 0 && /done → build/.test(fb[0].out) && fb[1].code === 1 && fb[2].code === 1 && j.stage === "build" && j.attempts.refused === 0,
    `${j.stage}, refused ${j.attempts.refused}; ${fb[2].out.trim()}`,
  );
  const kept = fs.readdirSync(path.join(jobDir(r, id), "feedback"));
  check("only the accepted feedback text is kept for the builder", kept.length === 1, kept.join(", "));
  kitchen(r, "run");
  check("…and the runner finishes it again", jobOf(r, id).stage === "done", stagesOf(r, id).join(" → "));
}

// 2. A corrupt job.json is skipped and named; the other jobs run
{
  const r = makeRepo(root, "corrupt");
  const torn = ticket(r, "Torn job\nscenario: chore");
  const odd = ticket(r, "Odd stage\nscenario: chore");
  const good = ticket(r, "Good job\nscenario: chore");
  fs.writeFileSync(jobJson(r, torn), fs.readFileSync(jobJson(r, torn), "utf8").slice(0, 120));
  fs.writeFileSync(jobJson(r, odd), fs.readFileSync(jobJson(r, odd), "utf8").replace('"stage": "intake"', '"stage": "cooking"'));
  const out = kitchen(r, "run").out;
  check("the good job runs to done", jobOf(r, good).stage === "done", stagesOf(r, good).join(" → "));
  check(
    "the run names each corrupt job with the reason and skips it",
    new RegExp(`${torn}  corrupt \\(not JSON: .+\\): skipped`).test(out) && new RegExp(`${odd}  corrupt \\(stage: .+\\): skipped`).test(out),
    out
      .split("\n")
      .filter((l) => l.includes("corrupt"))
      .join(" | "),
  );
  const st = kitchen(r, "status").out;
  check(
    "status lists them as corrupt(<reason>)",
    new RegExp(`${torn}\\s+corrupt\\(not JSON`).test(st) && new RegExp(`${odd}\\s+corrupt\\(stage: `).test(st) && st.includes(good),
    st
      .split("\n")
      .filter((l) => l.includes("corrupt"))
      .join(" | "),
  );
  const fb = kitchen(r, "feedback", odd, "x");
  check("a command on a corrupt job says so", fb.code === 1 && /is corrupt \(stage: /.test(fb.out), fb.out.trim());
}

// 3. A worktree folder left by a cut-short `worktree add` is moved aside and the worktree made again
{
  const r = makeRepo(root, "torn-worktree");
  const id = ticket(r, "Torn worktree\nscenario: chore");
  const wt = path.join(r.dir, ".worktrees", id);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
  fs.writeFileSync(path.join(wt, "half-checked-out.txt"), "junk\n");
  const out = kitchen(r, "run").out;
  const j = jobOf(r, id);
  const stray = fs.readdirSync(path.join(r.dir, ".worktrees")).filter((f) => f.startsWith(`${id}.stray-`));
  const files = execFileSync("git", ["-C", r.dir, "diff", "--name-only", j.base, j.branch], { encoding: "utf8" });
  check(
    "the job runs to done in a fresh worktree",
    j.stage === "done",
    `${stagesOf(r, id).join(" → ")} ${j.pausedReason ?? ""} ${out.split("\n").slice(-3).join(" | ")}`,
  );
  check(
    "the stray folder is kept aside, and nothing of it reaches the job branch",
    stray.length === 1 && fs.existsSync(path.join(r.dir, ".worktrees", stray[0], "half-checked-out.txt")) && !files.includes("half-checked-out"),
    stray.join(", "),
  );
}

// 4. An engine failure (not the agent's): retried once, then needs-human with code engine-error
{
  const r = makeRepo(root, "engine-error");
  const id = ticket(r, "Engine error\nscenario: chore");
  stepUntil(r, id, "build");
  fs.writeFileSync(jobJson(r, id), fs.readFileSync(jobJson(r, id), "utf8").replace(/"base": "[0-9a-f]+"/, `"base": "${"d".repeat(40)}"`));
  const out = kitchen(r, "run").out;
  const j = jobOf(r, id);
  check(
    "a worktree that can't be made: error retried once, then build → needs-human(engine-error)",
    j.stage === "needs-human" && /^engine-error: /.test(j.pausedReason ?? "") && j.escalatedFrom === "build" && /error \(retried next tick\)/.test(out),
    j.pausedReason,
  );
}

// 5. An empty run.lock (a writer cut short, or an older one): taken over only after 2 s unreadable
{
  const r = makeRepo(root, "empty-lock");
  const lock = path.join(r.dir, ".kitchen", "run.lock");
  fs.writeFileSync(lock, "");
  const t0 = Date.now();
  const out = kitchen(r, "run", "--once").out;
  const secs = (Date.now() - t0) / 1000;
  check(
    "a fresh empty lock is waited on for its 2 s grace, then taken over",
    secs >= 2 && /took over the run lock \(unreadable lock file\)/.test(out),
    `${secs.toFixed(1)} s; ${out.split("\n")[0]}`,
  );
  fs.writeFileSync(lock, "");
  fs.utimesSync(lock, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  const t1 = Date.now();
  const out2 = kitchen(r, "run", "--once").out;
  check("one that has been empty for 10 s is taken over at once", Date.now() - t1 < 2000 && /took over the run lock/.test(out2), out2.split("\n")[0]);
  check("the lock is released after the run", !fs.existsSync(lock));
}

// 6. A torn last ledger line (crash mid-append) doesn't swallow the next line
{
  const r = makeRepo(root, "torn-ledger");
  const led = path.join(r.dir, ".kitchen", "ledger.jsonl");
  fs.writeFileSync(led, '{"t":"x","job":"-","stage":"-","round":0,"event":"run-start","key":"torn');
  kitchen(r, "run", "--once");
  const lines = fs.readFileSync(led, "utf8").split("\n").filter(Boolean);
  const parsed = lines.slice(1).map((l) => {
    try {
      return JSON.parse(l) as { event: string };
    } catch {
      return null;
    }
  });
  check(
    "the next append starts on its own line; every line after the torn one parses",
    lines.length >= 3 && parsed.every(Boolean) && parsed.some((l) => l?.event === "run-start"),
    `${lines.length} lines`,
  );
}

finish("w1 faults");
