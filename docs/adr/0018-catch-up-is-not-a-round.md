# Catching up with staging is not a round

**Status.** Accepted, 2026-11-23, by the user ("good go ahead"). Amends ADR 0016 (its amendment "file overlap no longer holds a job") and the round budget in `machine.ts`.

## Why

Two four-ticket runs on library-demo lost every extra round to merge conflicts, not to bugs:
- **kl4, job 003:** 3 rounds. Rounds 2 and 3 started because `staging` had moved and the merge conflicted (`README.md`, `test/loans.test.js`, then `public/app.js`, `test/ui.test.js`). It used its whole budget; one more clash would have sent it to a person.
- **kl5, job 002:** 2 rounds. QA, review and the merge check all passed; the merge into `staging` conflicted in `server.js` because 001 had merged first.

The obvious fix is to run jobs that share files one after another. The timings say no:
- kl5: holding 002 until 001 merged would have started its Build at 23:13:34. 002 takes about 3½ min end to end, so it lands near 23:17. It actually landed at 23:15:59, conflict round included.
- kl4's catch-up rounds took 2–2½ min each (Build 40 s, QA 1 min, review 25 s–1¼ min). Holding 003 behind 001 and 002 would cost their whole runs.
- ADR 0016 already removed the file-overlap hold after it doubled wall time on an earlier run.

So running side by side stays. What's wrong is what a conflict costs: it spends a round meant for "the work was wrong", and it runs the full lanes again for a change that is usually a few lines of merge resolution.

## Decision

### 1. A catch-up has its own counter
- When the merge into `staging` conflicts (or the checks on the merged result go red only because of `staging`'s new commits), the job goes back to Build as a **catch-up**, not a new round. `round` still moves on (evidence is filed under it), but `roundStart` moves with it, so `roundsUsed` doesn't grow.
- A new field `catchUps` counts them. After 3 catch-ups in a row without landing, the job goes to a person: "staging keeps moving under it".
- A QA FAIL, a blocking review or a red merge check is a round, as today.
- `kitchen report` counts catch-ups separately: "first pass" means passed QA, review and merge check on the first try. A line "caught up with staging N times" shows the overlap cost.

### 2. A catch-up is light
- **Build:** the brief says to resolve the merge so both changes work and change nothing else. `job finish` checks the branch has `staging`'s tip, as today.
- **QA:** the brief re-drives instead of exploring (the ADR 0017 §5 rule already applies: same criteria, last QA passed). QA still runs: a resolution can break the job's own behaviour.
- **Review:** the brief carries the diff since the last reviewed head (the merge resolution), not the whole job. The reviewer also sees the full diff and the last review's findings for context.
- **Merge check:** runs as today, since the merged result is new.

### 3. Who decides it's a catch-up
Kitchen, in code. At the failed merge it knows why: conflict, or red checks. A red check counts as a catch-up only when the same checks were green on the job's branch alone. Otherwise it's a round.

## Not chosen
- **Holding jobs whose intake `FILES:` overlap** until the earlier one merges. It's slower on both runs above, and `FILES:` is a guess before Build.
- **Holding only near the merge** (a job waits to merge while an overlapping one is in review). Conflicts come from both having changed the same lines, so waiting at the end doesn't prevent them. It only reorders who pays.
- **Kitchen resolving conflicts itself** (for example, keeping both sides in `README.md`). That's right only sometimes, and a wrong guess goes unseen.

## Consequences
- Jobs that only clash with `staging` keep their full round budget for real failures.
- "First pass" measures quality again. Catch-ups are measured on their own.
- A catch-up costs about the same wall time but fewer tokens: no fresh exploration in QA, and a small review.
- A job on a hot file can still catch up 3 times and go to a person. That's the signal to split the work differently.

## Amendment, 2026-11-23: how it is built

**§3, who decides.** `isCatchUp` in `machine.ts`, pure. The trial merge (`staging.ts`) now says why it failed (`cause`: conflict or checks) and onto which tip of `staging`. At `job finish`, Kitchen calls it a catch-up when:
- the merge conflicted, or
- the checks went red on the merged result, the same checks were green on the job branch alone, and `staging` has commits the reviewed head doesn't.

"Green on the branch alone" is the round's `checks.json`, from Build's `job finish`: no second run. Since Build refuses red checks, that run is always green by the time a job merges, so in practice the test is whether `staging` moved. Red checks on a merge when `staging` hadn't moved are a round. So are a weakened map (the backstop), a QA FAIL, a blocking review and a red merge check (regress).

**§1, the counter.** `move(…, "build", { catchUp: true })` adds 1 to `round` (the new round folder holds the evidence), to `roundStart` and to `catchUps`, so `roundsUsed` stays the same. A catch-up ignores the round budget: a job out of rounds still catches up. Before, a merge that failed with no rounds left stopped at Ready.
- `catchUps` counts catch-ups in a row. A real round clears it, landing (`done`) clears it, and so does a person taking the job back from needs-human. While it is above 0, the current round is a catch-up, and the briefs read it that way.
- With 3 already used, the next failed merge goes to needs-human: "staging keeps moving under it (3 catch-ups)".
- The ledger's move line carries `detail.catchUp: true`. That's what the report counts, since `catchUps` resets.

**§2, light.**
- **Build:** the brief keeps the "staging moved: resolve the merge first" section and adds "A catch-up, not a new round": make the merge work, fix only what the merged result breaks, change nothing else. Why the merge failed is under "Earlier rounds", as before.
- **QA:** unchanged. The ADR 0017 §5 re-drive applies by itself: the last QA passed and the criteria are the same. A test checks it.
- **Review:** when a review passes, Kitchen keeps its head and round on the job (`reviewed`). A catch-up's review brief gives `git diff <reviewed> <head>` (`staging`'s new commits come along with it) and `git show --remerge-diff` for the merge commits since then, which shows the resolution alone. It also points to the whole-job diff and that review's file and findings, and says to block only on what the resolution breaks.
- **Merge check:** unchanged.

**Report.** `kitchen report`: "first pass" counts ended jobs whose `round` minus their catch-ups (from the ledger) is 1. Mean rounds uses the same count. Review sent-backs leave catch-ups out. A new count, `caughtUp`, prints as "caught up with staging N times". Dashboard cards show `round` less catch-ups the same way. Folders and the detail timeline keep the real round number.
