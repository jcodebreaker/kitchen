// W1 exit, part 1: scripted jobs walk every stage path through the real CLI with
// the fake adapter. One throwaway repo per scenario. Exits 1 on any miss.
//   node spikes/w1/paths.ts <scratch dir>      (W1_VERBOSE=1 prints every CLI line)
import { execFileSync } from "node:child_process";
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

// 3. bug via repro (medium: spec first), not reproduced once, then reproduced and committed
{
  const { r, id } = scenario("bug");
  run(r);
  expectPath("bug (medium)", r, id, "intake → spec → repro → repro → build → gate → drives → verify → review → ready → report → done");
  check("bug: the repro test is committed on the job branch", fs.existsSync(path.join(jobOf(r, id).worktree, "test", `${id}-repro.test.txt`)));
}
// 3b. low-risk bug: straight to repro; no reproduction after 2 tries → needs-info
{
  const { r, id } = scenario("bug-lost");
  run(r);
  expectPath("bug (low) not reproduced", r, id, "intake → repro → repro → needs-info");
  check("bug-lost: question.md for the author", fs.existsSync(path.join(jobDir(r, id), "question.md")));
}

// 4. Toolkit gap round trips (returnTo spec, then returnTo drives) and paused(toolkit-pr) until the Toolkit PR merges
{
  const { r, id } = scenario("gap");
  run(r, "--once"); // the daemon would wait on the Toolkit PR; step instead
  const out = stepUntil(r, id, "paused");
  all.push(out);
  const j = jobOf(r, id);
  check("gap: spec → toolkit → spec (returnTo spec)", walk(r, id).startsWith("intake → spec → toolkit → spec → build"), walk(r, id));
  check("gap: drives → toolkit → drives (returnTo drives)", walk(r, id).includes("drives → toolkit → drives → verify"), walk(r, id));
  check(
    "gap: verify citing evidence of an older HEAD is refused with the reason",
    /refused verify → review: a cited id is not stamped for this HEAD/.test(out),
  );
  check(
    "gap: paused(toolkit-pr), Toolkit PRs opened once each",
    j.stage === "paused" && j.waitFor === "toolkit-pr" && forge(r).toolkitPrs.every((p) => p.calls === 1),
    `${j.waitFor} pr ${j.smith.toolkitPr}, smith ${j.smith.attempts}`,
  );
  check("gap: toolkitRef pinned to the proven Toolkit", !!j.toolkitRef, j.toolkitRef);
  const onBranch = execFileSync("git", ["-C", r.dir, "diff", "--name-only", j.base, j.branch], { encoding: "utf8" }).trim().split("\n");
  const leaked = onBranch.filter((f) => f.startsWith(".kitchen/toolkit/") && !f.startsWith(".kitchen/toolkit/features/"));
  check(
    "gap: the smith's Toolkit primitive edits in the worktree are kept off the job branch (feature drives stay)",
    !leaked.length &&
      onBranch.some((f) => f.startsWith(".kitchen/toolkit/features/")) &&
      /Toolkit primitive edits kept off the job branch: .*primitives\.txt/.test(out) &&
      !fs.existsSync(path.join(j.worktree, ".kitchen/toolkit/bin/smith-extra")),
    leaked.length ? `leaked: ${leaked.join(", ")}` : onBranch.join(", "),
  );
  run(r, "--once");
  check("gap: still paused while the Toolkit PR is open", jobOf(r, id).stage === "paused");
  editForge(r, (s) => {
    for (const p of s.toolkitPrs) p.merged = true;
  });
  run(r);
  check("gap: Toolkit PR merged → ready → report → done", walk(r, id).endsWith("ready → paused → ready → report → done"), walk(r, id));
}

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

// 7. INCONCLUSIVE: free retry, paused(toolkit-ticket), ticket closed, twice more → needs-human; feedback → build → done
{
  const { r, id } = scenario("inconclusive");
  all.push(stepUntil(r, id, "paused"));
  let j = jobOf(r, id);
  check(
    "inconclusive: free retry then paused(toolkit-ticket), no round spent",
    j.waitFor === "toolkit-ticket" && j.round === 1 && !!j.toolkitTicketRef,
    `${j.toolkitTicketRef}, round ${j.round}`,
  );
  check("inconclusive: the Toolkit ticket was filed once", forge(r).tickets.length === 1 && forge(r).tickets[0].calls === 1);
  editForge(r, (s) => {
    s.tickets[0].closed = true;
  });
  run(r);
  j = jobOf(r, id);
  check("inconclusive: after the ticket, INCONCLUSIVE twice more → needs-human", j.stage === "needs-human" && j.round === 1, j.pausedReason);
  check("inconclusive: needs-human records where it escalated from", j.escalatedFrom === "verify", j.escalatedFrom);
  const fb = kitchen(r, "feedback", id, "The Toolkit is fixed, try again").out;
  check("needs-human → feedback → verify, the stage it escalated from (ADR 0007)", /needs-human → verify/.test(fb), fb.trim());
  run(r);
  expectPath(
    "inconclusive",
    r,
    id,
    "intake → build → gate → drives → verify → verify → paused → verify → verify → needs-human → verify → review → ready → report → done",
  );
}

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

// 8b. a judged criterion: PASS with no citation is refused (per criterion, not a flat list); PASS citing C2's own evidence moves on
{
  const { r, id } = scenario("judged");
  const out = run(r);
  expectPath("judged", r, id, "intake → build → gate → drives → verify → review → ready → report → done");
  check(
    "judged: PASS with no citation for the judged criterion is refused with the reason",
    /refused verify → review: a cited id is not stamped for this HEAD, round and criterion \(C2 is judged and cites no evidence\)/.test(out),
  );
  const ev = fs.readFileSync(path.join(jobDir(r, id), "evidence", "manifest.jsonl"), "utf8");
  check("judged: the cited entry is stamped for C2 by the verifier", /"criterion":"C2"/.test(ev) && /"role":"verifier"/.test(ev));
}

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
{
  const { r, id } = scenario("drives-fail");
  run(r);
  expectPath("drives: two failed attempts", r, id, "intake → build → gate → drives → drives → needs-human");
}
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
