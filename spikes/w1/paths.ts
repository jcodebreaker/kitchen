// W1 exit, part 1: scripted jobs walk every stage path through the real CLI with
// the fake adapter. One throwaway repo per scenario. Exits 1 on any miss.
//   node spikes/w1/paths.ts <scratch dir>      (W1_VERBOSE=1 prints every CLI line)
import fs from "node:fs";
import path from "node:path";
import { check, editForge, finish, forge, jobDir, jobOf, kitchen, makeRepo, type Repo, stagesOf, stepUntil, ticket } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"));
fs.mkdirSync(root, { recursive: true });
const all: string[] = [];

function scenario(name: string, title = `Scripted ${name}`): { r: Repo; id: string } {
  const r = makeRepo(root, name);
  const id = ticket(r, `${title}\nscenario: ${name}`);
  return { r, id };
}
const run = (r: Repo, ...a: string[]) => {
  const o = kitchen(r, "run", ...a).out;
  all.push(o);
  return o;
};
const walk = (r: Repo, id: string) => stagesOf(r, id).join(" → ");
const expectPath = (label: string, r: Repo, id: string, want: string) => check(`${label}: path`, walk(r, id) === want, walk(r, id));

// 1. feature, medium risk, through every main stage; the report is refused once (unknown id) and rendered on the retry
{
  const { r, id } = scenario("feature");
  run(r);
  expectPath("feature (medium)", r, id, "intake → spec → build → gate → drives → verify → review → ready → report → report → done");
  const j = jobOf(r, id);
  check(
    "feature: report.html rendered, PR opened once",
    fs.existsSync(path.join(jobDir(r, id), "report.html")) && forge(r).prs.length === 1 && forge(r).prs[0].creates === 1,
    `PR #${j.pr}`,
  );
  check(
    "feature: gate check stamped as evidence (role engine)",
    /"role":"engine"/.test(fs.readFileSync(path.join(jobDir(r, id), "evidence", "manifest.jsonl"), "utf8")),
  );
  check(
    "feature: evidence pushed and PR comment posted once",
    forge(r).comments.length === 1 && forge(r).comments[0].calls === 1 && forge(r).evidence[0]?.calls === 1,
  );
}

// 2. low-risk chore: no spec, no review lens on a small diff
{
  const { r, id } = scenario("chore");
  run(r);
  expectPath("chore (low)", r, id, "intake → build → gate → drives → verify → review → ready → report → done");
  const j = jobOf(r, id);
  check("chore: no spec.md, no reviewer run", !fs.existsSync(path.join(jobDir(r, id), "spec.md")) && !j.agentRuns.some((a) => a.role.startsWith("reviewer")));
}

// 3. REMOVED (W3a): "bug via repro, not reproduced once, then reproduced" relied on the W1 repro stub;
//    repro now runs the proof itself on the base. Ported to fixture A: spikes/w3a/paths.ts repro-retry.
// 3b. low-risk bug: straight to repro; no reproduction after 2 tries → needs-info
{
  const { r, id } = scenario("bug-lost");
  run(r);
  expectPath("bug (low) not reproduced", r, id, "intake → repro → repro → needs-info");
  check("bug-lost: question.md for the author", fs.existsSync(path.join(jobDir(r, id), "question.md")));
}

// 4. REMOVED (W3a): the Toolkit gap round trips relied on the W1 fake Toolkit (a `sql` primitive in primitives.txt) and stub
//    drives/Verify. Ported to fixture A: spikes/w3a/paths.ts gap (spec → toolkit → spec, drives → toolkit → drives) and
//    bad-gap. paused(toolkit-pr) waits at ready: W3b.

// 5. paused(backoff): rate limited once, retried after the backoff, never needs-human
{
  const { r, id } = scenario("backoff");
  const out = run(r, "--once", id) + run(r, "--once", id);
  const j = jobOf(r, id);
  check("backoff: rate limit → paused(backoff) with until", j.stage === "paused" && j.waitFor === "backoff" && !!j.until, `${j.waitFor} until ${j.until}`);
  check("backoff: a run before the time keeps it paused", /build → paused/.test(out) && jobOf(r, id).stage === "paused");
  run(r);
  expectPath("backoff", r, id, "intake → build → paused → build → gate → drives → verify → review → ready → report → done");
}

// 6. paused(ci): CI pending on the PR
{
  const { r, id } = scenario("ci");
  editForge(r, (s) => {
    s.defaultChecks = "pending";
  });
  stepUntil(r, id, "paused");
  check("ci: ready → paused(ci)", jobOf(r, id).waitFor === "ci" && jobOf(r, id).pausedFrom === "ready");
  editForge(r, (s) => {
    for (const p of s.prs) p.checks = "pass";
  });
  run(r);
  expectPath("ci", r, id, "intake → build → gate → drives → verify → review → ready → paused → ready → report → done");
}

// 7. REMOVED (W3a): INCONCLUSIVE twice → paused(toolkit-ticket) → needs-human relied on the W1 Verify stub (no proof ran).
//    Ported to fixture A: spikes/w3a/paths.ts inconclusive (up to review; ready/report are W3b/W4).

// 8. round limit: the gate fails three rounds → needs-human; feedback resets the budget → done; feedback on done → build → done
{
  const { r, id } = scenario("rounds");
  const out = run(r);
  let j = jobOf(r, id);
  check(
    "rounds: third gate FAIL is refused with round-limit and goes to needs-human",
    j.stage === "needs-human" && /round limit: 3 of 3 rounds used/.test(out),
    j.pausedReason,
  );
  check("rounds: escalated from gate", j.escalatedFrom === "gate", j.escalatedFrom);
  const to = kitchen(r, "feedback", id, "--to", "build", "Gate is fixed now").out;
  check("rounds: `feedback --to build` overrides the escalation stage", /needs-human → build/.test(to), to.trim());
  run(r);
  j = jobOf(r, id);
  check(
    "rounds: after feedback the job finishes in round 4 (budget reset, stamps never reuse a round)",
    j.stage === "done" && j.round === 4 && j.roundStart === 4,
    `round ${j.round}`,
  );
  const fb = kitchen(r, "feedback", id, "One more change please").out;
  check("done → build on feedback", /done → build/.test(fb), fb.trim());
  run(r);
  j = jobOf(r, id);
  check("rounds: done again after done → build", j.stage === "done" && j.round === 5, `round ${j.round}`);
  expectPath(
    "rounds",
    r,
    id,
    "intake → build → gate → build → gate → build → gate → needs-human → build → gate → drives → verify → review → ready → report → done → build → gate → drives → verify → review → ready → report → done",
  );
}

// 8b. REMOVED (W3a): a judged criterion on a `cmd` proof ("the work file reads well") is refused by spec-lint now (judged needs
//    a toolkit proof with a screenshot, about appearance or copy). Citation refusals are proven on fixture A: spikes/w3a/engine.ts attacks.

// 9. rejected from intake, rejected from needs-info, needs-info → reply → intake
{
  const { r, id } = scenario("reject-intake");
  run(r);
  expectPath("rejected from intake", r, id, "intake → rejected");
}
{
  const { r, id } = scenario("info-reject");
  run(r);
  const o = kitchen(r, "reject", id).out;
  expectPath("rejected from needs-info", r, id, "intake → needs-info → rejected");
  check("reject prints one line", o.trim().split("\n").length === 1, o.trim());
}
{
  const { r, id } = scenario("info-reply");
  run(r);
  kitchen(r, "feedback", id, "The settings page");
  run(r);
  expectPath("needs-info → reply → intake", r, id, "intake → needs-info → intake → rejected");
}

// 10. three jobs, concurrency 2: all finish, and they take turns (job 3 starts before job 1 is done)
{
  const r = makeRepo(root, "fair");
  const ids = [1, 2, 3].map((n) => ticket(r, `Chore ${n}\nscenario: chore`));
  run(r);
  check(
    "fair: three jobs done",
    ids.every((id) => jobOf(r, id).stage === "done"),
  );
  const moves = fs
    .readFileSync(path.join(r.dir, ".kitchen", "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { job: string; event: string; result?: string });
  const firstOf3 = moves.findIndex((l) => l.job === ids[2] && l.event === "move");
  const doneOf1 = moves.findIndex((l) => l.job === ids[0] && l.result === "done");
  check(
    "fair: jobs take turns, one stage per dispatch",
    firstOf3 >= 0 && firstOf3 < doneOf1,
    `job 3 first move at line ${firstOf3}, job 1 done at line ${doneOf1}`,
  );
}

// 11. refused moves print their reason
{
  const { r, id } = scenario("empty-build");
  const out = run(r);
  check(
    "READY with nothing committed: refused twice with the reason → needs-human",
    (out.match(/refused build → gate: nothing committed on the job branch/g) ?? []).length === 2 && jobOf(r, id).stage === "needs-human",
    jobOf(r, id).pausedReason,
  );
  const bad = kitchen(r, "resume", id);
  check("resume on a job that isn't paused says why", bad.code === 1 && /nothing to resume/.test(bad.out), bad.out.trim());
}
{
  const { r, id } = scenario("blocked");
  run(r);
  const early = kitchen(r, "feedback", id).out; // allowed: needs-human → build
  check("needs-human → feedback (no text) → build", /needs-human → build/.test(early), early.trim());
  run(r);
  const rej = kitchen(r, "reject", id);
  expectPath("blocked", r, id, "intake → build → needs-human → build → needs-human → rejected");
  check("needs-human → reject → rejected", rej.code === 0 && jobOf(r, id).stage === "rejected");
  const again = kitchen(r, "feedback", id, "too late");
  check("a move the table doesn't have is refused with its reason", again.code === 1 && /refused no move rejected → build/.test(again.out), again.out.trim());
}
// REMOVED (W3a): "drives-fail" scripted DRIVES: FAILED, but the drives stage now starts no agent when every named
// drive resolves and checks (the W1 contract names none). A failed write counted toward the cap: spikes/w3a/paths.ts bad-gap.
{
  const r = makeRepo(root, "refusals");
  const id = ticket(r, "Something\nscenario: chore");
  const o = kitchen(r, "reject", id);
  check(
    "reject from intake by hand is refused (the table has no such row)",
    o.code === 1 && /refused no move intake → rejected|refused intake → rejected/.test(o.out),
    o.out.trim(),
  );
}

// Every refused move in every run printed a reason
const refusedLines = all
  .join("\n")
  .split("\n")
  .filter((l) => /^\S+\s+refused\s/.test(l));
const bare = refusedLines.filter((l) => !/refused (.+ → .+: .+|no move .+ → .+)$/.test(l));
check(
  "every refused move printed its reason",
  refusedLines.length > 0 && !bare.length,
  `${refusedLines.length} refusals${bare.length ? `; without a reason: ${bare.join(" | ")}` : ""}`,
);
finish("w1 paths");
