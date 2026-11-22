# Kitchen benchmark

`set.yaml` is the benchmark (PLAN §8): each ticket names its fixture, its kind, the outcome Kitchen must reach, and, for a ticket that should end in a ready PR, a **hidden oracle**: criteria in the spec format that no role ever sees. The bench runs the oracle through the engine's own proof runner (`proof/prove.ts`) on a clean checkout of the job's final branch, with the base's Toolkit on a fresh app, so "done" is checked by something the agents could not have tuned to.

- **Tuned set** (14, fixtures A, B, C): 4 features, 3 bugs (one hard to reproduce: `a-invite-case` says only "it doesn't happen to everyone"), 1 chore, 1 too big, 1 needing info, 1 to reject, 1 needing a new primitive (`a-primitive`: only a database read can prove it; its oracle signs alice in and refuses bob-admin a wrong password through the real sign-in page, then reads `users.last_login_at` in the oracle app's own Postgres with a `cmd` proof over loopback, never through a primitive the smith wrote), 2 planted-correct controls (`a-control-desc`, `b-control-long-title`: the naive build is right, so any Verify FAIL is a false FAIL). Three hide traps (`trap:` says what): `a-trap-slug`, `b-done-many`, `c-unused-invites`.
- **Fixture D, now tuned** (6, the orders API with a Stripe mock and an SMTP catcher): held out until the benchmark regression of 2026-11-22, whose iterations ran D tickets and whose fix taught `roles/_proofs.md` with a D case (since replaced by generic examples). It counts in the tuned set from then on.
- **Held-out set** (6, fixture E, `e-library`, a lending library API: books, members, loans with due dates, one JSON file, no dependencies, no Docker). No role prompt is tuned on E: the final-fixes benchmark runs it once (3 runs each), and nothing in `roles/` is changed because of what those runs show; a later tuning round that looks at E moves it to the tuned set and needs a fresh held-out set. Fixture E, its Toolkit and its tickets (2 features, 1 planted bug, 1 trap: `e-overdue-block`, a book returned late is not overdue; 1 planted-correct control: `e-control-me`; 1 needing info) were written and committed before any Kitchen run on it, and every oracle was checked by hand with no agent: it fails on the base, passes on a hand-written reference branch, and for the trap fails the naive build. Once runs have looked at E it stops being fresh; tune on it and it moves to the tuned set. PLAN wanted replays of 6 real superchat-lite PRs; superchat-lite's stack is too heavy for this laptop (W2), so that set is owed (PLAN "Changes from Wave 3b").
- **Smoke tier**: `a-count` (feature), `b-stats-overdue` (bug), `b-done-many` (trap), `b-control-long-title` (control), `a-chore` (low risk).

`plant:` edits the fixture before its first commit (a planted bug, or seed rows an oracle relies on). `expect.never:` names stages the job must not enter (`a-too-big`: `[build]`, read from its ledger moves). In an oracle proof `{port:<i>}` is the oracle app slot's i-th port, in the order the Toolkit's `describe` gives (fixture A: app, postgres, browser driver). `toolkits/<fixture>/` holds the Toolkits `kitchen init` generated on Claude in W2 for B, C and D (fixture A ships its own; E's was written by hand from D's and passes `kitchen toolkit check`). `oracle/` holds oracle helper files, copied only into the oracle's checkout.

## Scoring

A run is **correct** when its final stage is one of `expect.outcome`, its oracle passes (when it ends `done`), for `toolkit_pr: true` the job went through a Toolkit PR, and it never entered a stage in `expect.never`; a miss says which of these failed. An oracle that hits an infrastructure error (the checkout, the slot, `prepare`/`up`, or a step failing while `doctor` says the app is unwell) is run once more and the result says so; an oracle FAIL is never retried. A trap is **caught** when its run is correct (the oracle checks the trap). A **false FAIL** is a `VERDICT: FAIL` in a control's verdict files. A job paused on a Toolkit PR has it merged by the bench (the human's part, recorded in the log).

**Per drive** (a feature drive, or `primitive:<name>` for a bare primitive segment), from each job folder: how often a Verify row (`rounds/<n>/verdict-m<k>.md`) of a criterion that ran the drive said INCONCLUSIVE, and in how many jobs the drive **flaked**: on the same source tree (commit and working-tree hash, from `evidence/manifest.jsonl`), one run had every step run and another had a step fail. Both go in the results `.md` (Drives table) and `.json` (`results[].drives`, `summary.drives`). Every results file and ledger line names the Kitchen commit the bench ran on (`git rev-parse HEAD`, plus `dirty` when the tree had changes).

## Running

```sh
kitchen bench smoke --tool claude                 # 5 tickets, 1 run
kitchen bench full --tool claude --runs 3         # 26 tickets × 3
kitchen bench tuned --only a-count,b-done-many --runs 1
kitchen report --bench
```

Repos, logs and `KITCHEN_HOME` go to `bench/.work/<time>-<tier>/` (ignored); results to `results/<date>-<tier>-<tool>.md` and `.json`. At most `--concurrency` jobs at once (default 2) and at most one Docker fixture (A, C) at a time. `--max-usd` (default 25) stops starting tickets once the spend reaches it. Real-agent runs are started by hand, never in CI.
