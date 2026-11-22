# W3b results: Toolkit stage, forge, Ready, benchmark

All on 2026-11-22, macOS, Claude Code 2.1 (`/opt/homebrew/bin/claude`), Docker Desktop. Codex was not run (quota exhausted until 2026-12-21). No GitHub account was touched: GitHub is the gh shim plus a local bare remote (README).

## Exit checks

| Exit | Result | Evidence |
|---|---|---|
| A job needing a new primitive: spec → toolkit (smith on Claude) → Toolkit PR (shim) → pinned → paused(toolkit-pr) at Ready → shim merges → toolkitRef moves → drives/verify re-run → report → done | **PASS** (19/19 + 1 creation check) | `toolkit.ts claude`: below |
| The same with a scripted smith (plumbing, free) | **PASS** 19/19 | `toolkit.ts fake` |
| Ready: CI pending → paused(ci) → back; red CI → build; sync conflict → build (the builder resolves, the engine concludes the merge) → … → done with report, evidence branch, PR comment, PR ready | **PASS** 19/19 | `ready.ts` |
| GitHub forge + issue source + evidence branch against the shim | **PASS** 35/35, 37/37 after the W4 merge | `forge.ts` |
| Benchmark oracles discriminate (FAIL on the base; planted bugs' oracles PASS with the plant out) | **PASS** 20/20 | `oracles.ts` (B, D, A, C, run in four groups; c-unused-invites re-checked after its rewrite) |
| SMOKE tier on Claude | run 1: 2/5 (a Toolkit template bug, fixed); after the fix 5/5 | `bench/results/2026-11-22-smoke-claude-run1.md`, `…-smoke-claude.md` |
| FULL set on Claude, ≤ $25 and ~3 h at concurrency 2 | pass 1: 14/15 (the miss a bench defect, fixed); passes 2–3: below | `bench/results/2026-11-22-full-claude-pass1.md`, `…-full-claude.md` |
| One superchat-lite ticket end to end | **NOT RUN** (owed) | its stack is over this laptop's Docker budget (W2) |
| `npm test` / typecheck / lint | 306/306 before the W4 merge, 326/326 after; clean, clean | |
| Earlier spikes still pass with jobs on the engine-owned checkout | w1 paths 34/34, w1 faults 27/27 | the W1 feature path no longer expects a refused report (the report is an engine template until W4) |

## After merging main (W4)

W4 merged to main during this wave; main is merged into this branch. W4 owns `report.ts`, `review.ts` and the evidence branch (`evidence-branch.ts`, bundles redacted by the report stage); this wave's placeholder report and own evidence module were dropped for them. `src/forge/github.ts` implements W4's `Forge` (`publishEvidence`, `label`, `reviewComments`, `openPr`, plus W3b's `openToolkitPr` with branch/head and `markReady`). Re-run on the merged code:

| spike | result |
|---|---|
| `forge.ts` (adds publishEvidence on top of the remote's branch, prune, idempotent re-publish, reviewComments with author_association, label, openPr) | **37/37** |
| `ready.ts` (W4 report role and lenses, scripted) | **19/19** |
| `toolkit.ts fake` (the high-risk path now needs `<section id="human-check">`; the scripted report writes it) | **19/19** |
| `http-status.ts` (new: `http --expect_status 403`) | **3/3** |
| `spikes/w1/paths.ts` (its scripted report gained `<section id="summary">`, which W4's renderer requires; it failed 12 checks on main for that) | **34/34** |
| `npm test` / typecheck / lint | 326/326, clean, clean |

Found while merging: W4's `evidence-branch.ts` had the `.git/`-prefix bug `forge.ts` found in mine (`ls-tree -d --name-only <commit>` and `rm --cached -- <dir>` run with `cwd` = the gitdir inside the work tree match nothing, so retention never pruned); fixed with `--full-tree` and `:(top)`. The benchmark numbers below were measured **before** the merge (W3a-era review lenses, the placeholder report); the toolkit-stage and Ready proofs were re-run after it.

## The new-primitive job on Claude (`toolkit.ts claude`)

Ticket: "Record when each user last signed in: every successful sign-in stores the time on the user (a last_login_at timestamp). Nothing shows it in the UI yet; a later ticket will." Fixture A, GitHub forge (shim + bare remote), sonnet for strong roles, haiku for medium.

Path: intake → spec → **toolkit** → spec → build → gate → drives → verify → review → ready → **paused(toolkit-pr)** → *(the shim merges the PR on the remote)* → ready → gate → drives → verify → review → ready → report → done. **922 s, $0.606.**

| role | model | secs | cost |
|---|---|---|---|
| intake | sonnet | 14 | $0.106 |
| spec | sonnet | 12 | $0.082 |
| **smith** | sonnet | **737** | $0.226 |
| spec (after the Toolkit PR) | sonnet | 14 | $0.084 |
| builder | sonnet | 14 | $0.087 |
| reviewers (code, security) ×2 | haiku | 12–18 each | $0.021 |

- The spec (high risk: a migration) named `toolkit sql --query "SELECT last_login_at IS NOT NULL AS set FROM users WHERE username = 'alice'" --save rows`, plus a negative criterion (a failed sign-in leaves it NULL); spec-lint sent the job to the smith.
- The smith worked in `.worktrees/_smith-<job>-1` on `kitchen/toolkit/<job>-1`, with the setup bridge on that worktree. It wrote `sql` ("runs one read-only SELECT … inside a READ ONLY transaction and returns the rows as a JSON array") and changed only `.kitchen/toolkit/bin/dev` and `SKILL.md`. The engine committed it, checked describe lists `sql`, and ran the full `toolkit check` of base + that branch from `_toolkit@<sha>` **under sandbox-exec** (unmerged): pass in 29 s. Toolkit PR #1 opened through the forge (branch pushed to the remote, label `kitchen-toolkit`).
- `toolkitRef` = the smith's commit sha (40 hex, the branch tip); the job's `bin/dev` was the sandbox wrapper around `_toolkit@<smith sha>`; the job branch has no Toolkit file (`db/003_last_login.sql`, `server.js` only).
- At Ready: paused(toolkit-pr). The human merge (a merge commit on the remote's main, the shim marks the PR merged) cleared the wait; Ready fetched the base, merged it into the job branch, moved `base` and `toolkitRef` to the merge commit, pushed, and Gate, drives, Verify and review ran again on `_toolkit@<merge>` (unsandboxed: merged). Report: evidence branch folder, PR comment, PR marked ready.

The smith's 737 s is most of the job: it wrote, probed and re-ran `toolkit_check` (prepare, two slots, the contract probe) through the bridge before saying READY. In the benchmark run of the same ticket (`a-primitive`, local forge) the whole job took 233 s and $0.49.

## Ready (`ready.ts`, scripted agent, real Toolkit and Docker)

intake → spec → repro → build → gate → drives → verify → review → ready → **paused(ci)** → ready → **build** (CI red, round 2; `ci.md` for the builder) → … → ready → **build** (the base moved with a commit on the same line, round 3; `sync.json` names the tip and `server.js`) → gate → drives → verify → review → ready → report → done. The builder's round-3 worktree had the merge in progress with markers; the scripted builder resolved them; the engine's commit made the merge commit (two parents, one the upstream commit); no markers left, both changes kept; `job.base` = the upstream tip; the evidence branch holds the job's folder (221 files), the PR comment has the criterion table with a screenshot thumbnail, the PR is ready, no container left.

## Forge (`forge.ts`, 35/35)

Draft PR from the pushed branch, found again by branch; `kitchen:review-required` label; `gh pr checks` none / pending (exit 8) / fail (exit 1) / pass; Toolkit PR pushed and labelled, merged when the shim says so; comments and Toolkit tickets once per key; ready for review; evidence branch: an orphan first commit, one folder per job with report, manifest and entry folders, a folder dated 40 days back pruned, `sk_live_…` and `ghp_…` redacted at publish while the job folder keeps the original, a PNG byte for byte, republish = a new commit on top, main untouched; base fetched into `refs/kitchen/base`; no named remote ever configured; every gh call carried the engine's token. Source: only open `kitchen`-labelled issues; question once per key; Kitchen's own comment and a stranger's are not answers; the author's and an operator's are. **Found by it:** engine git on the main repo runs with `cwd` = the gitdir, inside the work tree, so `ls-tree` and `rm --cached` silently saw nothing; fixed with `--full-tree` / `:(top)` (ADR 0006 W3b section).

## Benchmark

Claude, sonnet for strong roles (intake, spec, builder, smith), haiku for medium (verifier, reviewers); 1 run per ticket per pass. Every `done` is judged by the hidden oracle on the final branch.

**Smoke, run 1** (2/5, $0.87, 3 min wall): a-count done ✓ (87 s, $0.18), a-chore done ✓ (116 s, $0.22, one review round back to build), **b-stats-overdue needs-info**, **b-done-many needs-human**, **b-control-long-title needs-info**. Root cause, one for all three: a proof line can only pass strings, and the template's `cli` primitive took `--argv "done 4"` as one word (`invalid choice: 'done 4'`), so repros never reproduced and drives failed. Fixed in `toolkit-template/lib/terminal.mjs` (and fixture B's bench Toolkit): a string argv splits like a shell line. **Smoke, B rerun after the fix** (3/3, $0.56): b-stats-overdue ✓ (29 s, $0.14), b-done-many ✓ trap caught (43 s, $0.18), b-control-long-title ✓ 0 false FAILs (68 s, $0.24). Smoke with the fix: **5/5**.

**Full, pass 1** (the 15 tickets not in smoke; 14/15, $2.56, 19 min wall):

| ticket | set | kind | expected | actual | oracle | time | cost |
|---|---|---|---|---|---|---|---|
| a-invite-case | tuned | bug (hard to reproduce) | done | done | pass | 170 s | $0.262 |
| a-trap-slug | tuned | feature (trap) | done | done | pass | 71 s | $0.149 |
| a-control-desc | tuned | control | done | done, 0 Verify FAILs | pass | 64 s | $0.142 |
| a-too-big | tuned | too big | needs-info / rejected / needs-human | needs-info | n/a | 7 s | $0.038 |
| a-needs-info | tuned | needs info | needs-info | needs-info | n/a | 9 s | $0.045 |
| a-reject | tuned | reject | rejected | rejected | n/a | 8 s | $0.036 |
| a-primitive | tuned | new primitive | done + Toolkit PR | done + Toolkit PR | pass | 233 s | $0.490 |
| c-dark-mode | tuned | bug | done | done | pass | 218 s | $0.145 |
| c-unused-invites | tuned | feature (trap) | done | **needs-human** (round limit) | n/a | 380 s | $0.294 |
| d-status-filter | held-out | feature | done | done | pass | 58 s | $0.225 |
| d-qty-100 | held-out | bug | done | done | pass | 32 s | $0.136 |
| d-discount | held-out | feature (trap) | done | done | pass | 73 s | $0.246 |
| d-control-version | held-out | control | done | done, 0 Verify FAILs | pass | 37 s | $0.148 |
| d-needs-info | held-out | needs info | needs-info | needs-info | n/a | 9 s | $0.049 |
| d-chore-subject | held-out | chore | done | done | pass | 43 s | $0.159 |

The c-unused-invites miss is a **bench defect**, not Kitchen's: the ticket planted two invites in the seed, but fixture C's W2-generated Toolkit `reset` truncates `invites` (its feature file says none are seeded). Intake wrote criteria from the seed ("1 unused invite"), the builder's change was right (`count(*) … WHERE accepted_at IS NULL`; the oracle run on its branch shows the count working), and every Verify after a `reset` read 0, three rounds, needs-human. The ticket now has no plant and its oracle makes two invites and accepts one (`oracle-on.ts` checks an oracle on any branch).

**Full, passes 2 and 3** (all 20 tickets twice; 34/40, $6.83, 40 min wall; `bench/results/2026-11-22-full-claude-passes2-3.md`, where `#1`/`#2` are passes 2/3). The six misses, none of them a wrong PR:

| run | expected | actual | why (from the job folder) |
|---|---|---|---|
| a-invite-case, pass 3 | done | needs-info | the repro didn't find the lower-case trigger in 2 tries (it is the "hard to reproduce" bug: pass 1 and 2 found it) |
| a-chore, pass 2 | done | needs-human | the review lens kept blocking a one-word rename for 3 rounds (round limit) |
| b-done-many, pass 2 | done | needs-human | intake's inline criteria read `json .open` on a `cli` step whose output wraps stdout; the builder said BLOCKED with that reason |
| b-control-long-title, pass 2 | done | needs-human | the verifier could not write a passing drive in 2 attempts (a 201-character argv) |
| b-control-long-title, pass 3 | done | needs-info | intake rated a control a bug; no repro in 2 tries |
| d-qty-100, pass 3 | done | needs-info | the repro didn't reproduce in 2 tries |

**The three-run picture** (run 1 = smoke with the template fix + full pass 1; runs 2–3 = passes 2–3; 60 runs):

| §0.2 measure | target | measured |
|---|---|---|
| runs ending in the correct outcome | ≥ 85% | **53/60 = 88%** (89.8% without the bench-defect run) |
| every planted trap caught in all 3 runs | all | **not met as scored**: a-trap-slug 3/3, d-discount 3/3, b-done-many 2/3, c-unused-invites 2/3 (+1 bench defect). But no trap ever escaped: in all 60 runs **no `done` job failed its oracle**; the trap misses ended in needs-human, never in a wrong PR |
| false FAILs on the 2 controls × 3 runs | ≤ 1 | **0** Verify FAILs (a-control-desc 3/3 done; b-control-long-title 1/3 done: two runs stopped before Verify, see above) |
| held-out within 15 points of tuned | ≥ tuned − 15 | held-out **17/18 = 94%**, tuned 36/42 = 86% |
| median time / cost per ticket | record | 58–65 s and $0.15 per ticket (passes); the new-primitive ticket 233–243 s and $0.49–0.53 |

Intake-only outcomes (too big, needs info, reject) were right 15/15, in 6–14 s for $0.04–0.07. The misses cluster in two places outside this wave's code: intake's inline criteria and the repro/drives writing for CLI tickets (`cli` output shapes), which is the W3a roles' ground; recorded here, not tuned (W3a fixer).

## Cost and time

Real-agent spend this wave: toolkit spike $0.61, smoke $0.87 + B rerun $0.56, the first bench try $0.18, full pass 1 $2.56, passes 2–3 $6.83: **$11.61 in all** (plus $0.17 for the first harness try), about 1 h 25 min of benchmark wall clock at concurrency 2 (one Docker fixture at a time). The scripted-agent spikes cost nothing.
