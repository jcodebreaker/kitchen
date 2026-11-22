# W5 results: learning, dashboard, release prep

All on Claude Code (Codex is out of quota until 2026-12-21). Scratch runs lived in the session scratchpad; what matters is committed here (screenshots, the W3b ledger copy, the report output).

## Exit table (as built; the review round below re-ran every spike on the fixed branch: retro 19/19, dashboard 13/13, pack 21/21, and rewrites the exit)

| exit (PLAN §7 W5 + this wave's brief) | result | evidence |
|---|---|---|
| Retro on a ledger with synthetic history mutes a category after N dismissals and files ≤ K draft lesson tickets; re-running files nothing new | **PASS** 18/18 | `retro.ts` (scripted). `kitchen run` started the retro on its own after 6 finished jobs; code/naming muted after 3 dismissals (2 `kitchen dismiss`, 1 trusted "not useful" PR reply via the fake forge; the untrusted reply ignored); security dismissed 3 times, not muted; 2 drafts (K = 2) from `drive:login>projects.open` and `findings:code/tests`; the out-of-list lesson refused; the re-run: 0 muted, 0 filed, no agent; unmute, then the same dismissals don't re-mute; `retro approve 1` → ticket 007 |
| … with a real model | PASS (one run, haiku, $0.011) | On the same history in a copy of fixture A, the real `retro` role wrote one concrete Toolkit fix (`.kitchen/toolkit/lib/driver.mjs` `login`: wait for the URL to leave `/login` instead of a 3 s read) with a check a person can run, and left out the tests signal it couldn't make concrete (the role says so). On a repo with nothing but a README it wrote nothing ($0.004): no invented files |
| `kitchen report` prints every §0 measure from the W3b benchmark ledger (or a copy) | **PASS** | `report-w3b.txt`: 55 jobs from the W3b full benchmark (`w3b-ledger/`, joined by `ledger-copy.ts`; 5 of the 60 runs' repos no longer exist): merge-ready 36/55 = 65% (the 15 needs-info/rejected tickets were correct outcomes, not PRs), first-pass verdict 37/39 = 95%, rounds 1.19 mean, escalations (12 needs-info, 3 rejected, 2 round-limit, 2 others), Toolkit gaps 0.05/job, primitive PRs 0.05/job, INCONCLUSIVE 0/95 proof runs and 0/49 verdicts, flake 0/86 groups, per-drive table, time and cost per risk path (low: 37 jobs, median 48 s, $0.152; medium 4, 2 min, $0.287; high 2, 4 min, $0.516) and per job, findings dismissed per lens (none in that pre-W4 ledger). `kitchen report --bench` prints both runs (34/40, 14/15) and says INCONCLUSIVE/flake weren't counted then |
| Dashboard screenshot with real fixture jobs, light and dark | **PASS** 11/11 | `dashboard.ts`: fixture A (Docker, real Toolkit), the W4 scripted agent, three tickets (the honest dark-mode bug with one blocking review round, the same with a rate-limit backoff, and one whose Verify is INCONCLUSIVE until the Toolkit ticket is closed, then escalated). `screens/running-{light,dark}.png` (Build, Verify; one card with "review 1 blocking") and `screens/done-{light,dark}.png` (2 done with C1–C3 PASS, review ok, Report links; 1 in Needs you with C3 INCONCLUSIVE and the reason). Server: POST 405, foreign Host 403, traversal 404, bound to 127.0.0.1 only, report served with a `default-src 'none'` CSP |
| Newcomer test: fresh clone of fixture B, README only, packed tarball, real agents, ≤ $1.5 | **PASS** ($0.73) | done in round 1, merged, Report read; 8 README issues found and fixed (below) |
| `npm pack --dry-run` and tarball smoke | **PASS** 20/20 | `pack.ts`: 127 files, all on the allowlist (dist/*.js, roles, skills, toolkit-template, dashboard.html, README, LICENSE, package.json); no fixtures/spikes/bench/src/tests/maps/env; no secret-shaped string; `npx ./devkitchen-0.1.0.tgz --help` and `--version` from an empty dir; installed into a temp prefix: `migrate --dry-run`, `report`, `init --skill`, `ticket`, `dashboard` all work |
| `test` proofs get the app URL | **PASS** 3/3 | `app-url.ts` |
| npm test / typecheck / lint | green | 338 tests; `tsc` both configs; biome clean. Regression: `spikes/w1/paths.ts` 34/34 |

## Newcomer test: PASS, $0.73

A fresh agent (sonnet) with no knowledge of this repo got only `README.md`, the packed `devkitchen-0.1.0.tgz` and a fresh one-commit clone of fixture B (`newcomer-setup.ts`), with the README's cheaper-models tip (sonnet/haiku). It installed the tarball into a temp prefix, ran `kitchen init` from a terminal (no questions; ~3.5 min, $0.53), merged `kitchen/setup`, filed "Add a --version flag to the tasks command", ran `kitchen run --detach`, polled `kitchen status`: job `001-add-a-version-flag-to-the-tasks-command` went intake → build → gate → drives → verify (PASS, round 1) → review → ready → report → done ($0.198, under a minute). It read the Report and merged `kitchen/001-…` (fast-forward); `python3 -m tasks --version` prints `tasks 0.1.0`. Total $0.7278 against the $1.5 cap. Its notes: `newcomer-notes.md`.

README issues it found, and what changed:

| # | issue | fix |
|---|---|---|
| 1 | Step 2B promised terminal questions; there were none, and init is silent for minutes; no word on the no-TTY path or on following it | 2B now says it can be quiet for minutes, what happens without a terminal (questions file, exit 3, `--answers`), and `--detach` + `init --status --wait 90`; time "3 to 15 minutes", with the measured 4 min / $0.53 |
| 2 | `kitchen/setup` is checked out in `.worktrees/_setup`, so `git checkout kitchen/setup` fails | Step 3 says read it with `git log`/`git diff`, not a checkout |
| 3 | Step 3 assumed the branch is `main` | "on your default branch (`main` below; use yours)" |
| 4 | `kitchen status` just after `run --detach` said "runner: not running"; `status` doesn't wait; "no PR" looked wrong locally | Step 5 says all three |
| 5 | `<id>` meant the full id; nothing about cleanup | Step 6 gives a full example and a cleanup paragraph |
| 6 | Local mode also makes a `kitchen-evidence` branch | Step 6 says so |
| 7 | Links to `docs/…` and `src/config.ts`, which the npm package doesn't have; the config schema was the real loss | the README now has every `kitchen.yaml` key with its default; repo docs are named as "in the source repository" |
| 8 | `kitchen --help` didn't list `init --skill`, `--detach`, `--answers` | added |
| 9 | (not the README) the verifier noted the pyproject fallback reads a wrong package name (`fixture-b-cli`) | a product finding about fixture B, left |

Path A (`/kitchen` inside Claude Code) was not exercised by the newcomer (a subagent can't drive an interactive session); `pack.ts` proves `init --skill` installs the skill from the package, and W2's `inside.ts claude e` proved the skill's setup flow inside `claude -p`.

## Findings

- **Evidence branch race (fixed).** Two jobs reaching `report` at once both built a `kitchen-evidence` commit; the second `update-ref` failed (`cannot lock ref 'refs/heads/kitchen-evidence': is at … but expected …`) and the runner retried it a tick later (first dashboard run). `commitEvidence` now runs under a per-repo file lock (`.kitchen/evidence.lock`); `evidence-race.ts`: six commits at once, none fails, all six folders on the branch (2/2).
- **"not useful" replies vs done → build (merge seam for the W4 fixer).** The retro reads a trusted "not useful" reply naming a finding as a dismissal. The runner's PR-comment path (`prCommentsBack`, W4 fixer's) would also read that same comment as feedback and send a done job back to build. One filter there fixes it: skip comments where `dismissedIn(c.body).length` (exported from `src/retro/signals.ts`). Not done here to stay out of that file.
- **Verdict-level INCONCLUSIVE.** A judged criterion can be INCONCLUSIVE without any proof run being INCONCLUSIVE (the scripted inconclusive scenario: every proof PASS, the verifier says INCONCLUSIVE). The report counts both: per drive from `proof` lines, and per Verify verdict from verify → verify / verify → paused moves.
- **A flaky chain is one signal.** A flaky proof makes every drive in it look flaky; the retro proposes one fix per proof chain (`drive:login>projects.open`), and the real role found the shared step (`login`) itself.
- **npm leaves `.gitignore` files out of a package.** `toolkit-template/.gitignore` is not in the tarball; `kitchen init` now writes it after copying the template.
- **`npx /abs/path.tgz` runs the path as a command.** It must be `npx ./devkitchen-0.1.0.tgz` (relative); `docs/RELEASE.md` and `pack.ts` use that.

## Review round (2026-11-22): fixes, every spike re-run, first dogfooding

The independent review of W5 found three majors and a list of minors (PLAN "Changes from the Wave 5 review"). The reviewer's exact examples for M2/M3 were not in the repo; the unit tests use examples written from the finding's description (named in each test).

### Findings → fix → proof

| finding | fix | proof |
|---|---|---|
| **M1** the dashboard spike rotted at the merge: it reused `spikes/w4/fake-agent.ts`, whose round 3 became "VERDICT: BLOCKING" with no finding, so its jobs ended `review-unparseable` | `spikes/w5/dashboard-agent.ts`, its own scripted agent (W4's script frozen at 828a05d); screenshots go to the scratch folder unless `--update-screens` | `dashboard.ts` **13/13**, twice; the second run regenerated `screens/*.png` on purpose (the cards changed) |
| **M2** keyword muting silenced security-relevant code findings | `category:` line in the findings format (`roles/_review.md`, one line per lens role), parsed into each finding, keyword fallback (security terms first); the security veto for every lens (`securityVeto`): a `security` finding or one naming auth, token, session, permission, ownership, inject, sql, xss, csrf, leak, secret, password, credential, "delete another" or access is never muted and its dismissals never count toward a mute; `never_mute` names lenses or categories | `signals.test.ts` "security veto": a code-lens `category: tests` finding on the session check, a code-lens naming finding whose why is about the auth token, a ux-lens finding where bob can delete another user's project: none muted under code/tests, code/naming and ux/ux mutes, while plain naming and ux findings are; vetoed or `category: security` dismissals don't mute |
| **M3** `dismissedIn` took every id in the comment; a mixed comment was dropped whole | `dismissalsIn`: ids only in the trigger's sentence (of a line); the rest of the comment comes back; the runner drops a comment only when it is purely a dismissal and otherwise hands the rest to the builder; a security finding (lens or category) is dismissed only with an explicit reason (`because …`, `reason:`, `not useful: …`, or `--reason`), recorded with it | `signals.test.ts` "dismissalsIn": "code-1-2 is not useful. But code-1-3 is right, please fix it." dismisses only code-1-2 and keeps the second sentence as feedback; a dismissal line plus a feature request; "security-1-1 is not useful because …" keeps the reason, "👎 security-1-2" has none. `retro.ts` **19/19** (new check: `kitchen dismiss` refuses a security finding without `--reason`; the retro refuses a reasonless 👎 on one from a trusted PR reply; every security dismissal carries its reason) |
| GitHub draft dedupe matched a marker anyone could paste | `gh issue list --author @me` (the gh shim honours `--author`) | one-line change; not run against GitHub (never contacted) |
| migrate placed `version:` by text | placed by the parsed YAML document; `---`, `%YAML`, flow maps, `version: 0`, empty and comment-only files, CRLF | `migrate.test.ts` (9 shapes, byte-exact) |
| retro only after the drain loop | checked each tick, one at a time beside the jobs | `retro.ts` (run starts it); code read |
| retro read every PR forever | done jobs of the last `retro.lookback_days` (30) | `retro.ts` (its PRs moved to done jobs) |
| measures | agent seconds beside wall clock (wall clock now starts when the first agent run started, not when it ended); "needs-info needs-info" gone; lists built in place | `measures.test.ts`; `report-w3b.txt` regenerated: $9.39, 53 min agent time, 77 min wall clock |
| dashboard headers and cards | CSP (with `frame-ancestors 'none'`) and `X-Frame-Options: DENY` as HTTP headers on every response; cards show the full job id, "last moved N ago" (server clock) and the last step | `dashboard.ts` checks both headers on `/` and every card's id, `movedAt`, `step`; screenshots |
| RELEASE.md | first release: publish and tag only; later: `npm version patch`, commit, publish, tag | read |
| NOTICE | pstack's MIT notice (verbatim from its LICENSE), zazencodes credited for ideas only; in `files` | `pack.ts` **21/21** ("the package has NOTICE") |
| `kitchen <cmd> --help` ran the command | prints that command's usage, runs nothing; unknown command → exit 2 | `kitchen run --help`, `dismiss -h`, `bogus --help` by hand |
| (found on the way) a forge dismissal wrote `at: <time>` into dismissed.jsonl, where `at` is a finding's anchor | `when` | code read |

### Every W5 spike on this branch (main a0c1a73 + the fixes)

| spike | result |
|---|---|
| `retro.ts` | 19/19 |
| `pack.ts` | 21/21 (128 files; installed `migrate --dry-run` now exits 1, see dogfood job 002) |
| `app-url.ts` | 3/3 |
| `evidence-race.ts` | 2/2 |
| `dashboard.ts` | 13/13, twice (fixture A, Docker; second run with `--update-screens`) |
| `report` on `w3b-ledger/` | regenerated `report-w3b.txt` |

`npm test` 359/359, typecheck and lint clean.

### Dogfooding (PLAN §0.5, first run)

Kitchen on a scratch clone of its own repo (`git clone` of main a0c1a73), `kitchen init` from a terminal with `agent: claude`, models sonnet/sonnet/haiku, local forge, prompt tickets, concurrency 2, run with this branch's CLI. **Setup:** survey + build 277 s agent time, **$1.05**; the setup agent chose surface `cli`: `up` builds a seeded target repo (three tickets) and serves `kitchen dashboard` on the slot's port, primitives through the template's `cli`, four feature files (basics, dashboard, report, tickets); `toolkit check` PASS in 21 s. I read `git log -p main..kitchen/setup` and merged it.

Six tickets from open items (none already done by the fixes above), every one checked first against the code:

| job | ticket | outcome | rounds | agent / wall | cost | what the Report showed | mergeable? (my review as the human) |
|---|---|---|---|---|---|---|---|
| 001 | `kitchen ticket "   "` must refuse (exit 2, no job) | needs-info → I rejected it. **Correct**: the premise was false (it already refuses, exit 1, no job); the verifier said exactly that | 1 | 83 s / 8 min | $0.232 | no Report; `repro-2.md`: "the premise … does not hold; the only gap is the exit code (1, not 2)" | n/a |
| 002 | `migrate --dry-run` exits 1 when files would change | **done** | 2 (round 1 FAIL: its test proof lived in `tests/`, outside vitest's include; the builder widened the include) | 2 min / 6 min | $0.503 | no "what a human must check" section | core (2 lines) yes; the proof test in a new `tests/` dir + a vitest include change break the repo's layout. **Merged by hand**, test moved into `src/migrate/migrate.test.ts`; `pack.ts` and README updated for the new exit code |
| 003 | `kitchen dismiss <job>` lists the job's findings | **done** | 2 | 2 min / 6 min | $0.731 | human check: the listing branch ("I did not read that branch"), help text, doc comment | core (10 lines) yes; tests no: three files plus a helper in `src/cli/` that would ship in `dist/` and sets `process.env.KITCHEN_HOME` for the whole worker. **Core merged by hand**, tests left out, help updated |
| 004 | `kitchen status --json` | **done** after one hint from me (intake was refused twice by spec-lint → needs-human) | 2 | 70 s / 6 min | $0.334 | human check: C2 NON-DISCRIMINATING, corrupt jobs silently left out, absolute report path | **yes, as is: cherry-picked** |
| 005 | `kitchen status` ends with a summary line | **done** after one hint (the same spec-lint deadlock) | 3 | 2 min / 3 min | $0.507 | human check: "1 jobs" grammar, corrupt rows counted in the total, the no-jobs cases proven only by a unit test | core yes (grammar fixed while merging); its test in a new `test/` dir + vitest change no. **Merged by hand** without them |
| 006 | `kitchen version` prints the version | needs-info twice, also after a hint: **not done** | 1 | 58 s / 2 min | $0.309 | n/a | n/a |

Totals: 6 tickets, **4 done** (2 of them only after a person's hint), 1 correctly refused, 1 stuck; `kitchen report` on the clone: merge-ready 4/6, first-pass verdict 1/4, rounds mean 2, $2.62 for the jobs and **$3.67 with setup** (budget $5). The retro ran by itself after 5 finished jobs: 0 signals, $0. A kill of the runner mid-build/mid-drives (my doing, below) resumed both jobs to done. Wall-clock times include the kill and my hints.

What dogfooding found (product, not fixed here):
1. **spec-lint deadlocks on "X stays unchanged" CLI requirements.** 5 of 6 first intakes were refused by rule 7 (a negative requirement needs an absence criterion); the absence the intake then wrote (`not contains "…"`) was refused as "holds whenever the thing never existed". 004 and 005 went to needs-human until I told intake to prove the unchanged case positively. Each refusal is an extra intake run ($0.05–0.14).
2. **A bug whose base exits non-zero can't be reproduced.** For a CLI bug the repro proof's `cli` step fails on base (exit 2) → `step-failed` → NOT-REPRODUCED → needs-info (006, twice, even after a hint; the verifier explained it precisely each time). The repro should count a failing step it expected to fail, or intake should write `--expect_exit` + an exit assertion. This blocks every "unknown command / wrong exit code" bug ticket.
3. **Test proofs ignore the repo's test layout** (`tests/`, `test/` instead of `src/**/*.test.ts`) and the builder then edits `vitest.config.ts` to include them (002, 005); 003's test helper would ship in the package.
4. **Low risk has no review lens**, so (3) reached done unreviewed. For a package like Kitchen a `code` lens on low would have caught it.
5. **Gate can't typecheck a Node repo**: job worktrees have no `node_modules` until the Toolkit's `prepare`, which runs after gate, so `checks: [npm run typecheck]` can't work. I left `checks` empty.
6. **Slots are per `KITCHEN_HOME`, ports are machine-wide.** I gave the dogfood its own `KITCHEN_HOME`; the orchestrator's benchmark (its own home) was running at the same time, and both registries handed out blocks 0–3 (31000–31079). Job 001's `up` read another app's page (`Unexpected token '<'`) and escalated. I stopped the run after ~5 minutes (11:34–11:39 UTC), killed my leftover dashboard, and reserved blocks 0–14 in the dogfood registry so the rest ran on 31300+. **The benchmark's runs that held slots 0, 2 and 3 in that window (a-invite-case-1 and d-status-filter-1 among them) may have been disturbed and should be checked.** The fix: one registry per machine, and `up` refusing a port something else listens on.
7. The report role once said "I did not read that branch" about the code it was summarising (003).

**§0.5 status:** 4 of Kitchen's own tickets reached done (local branches + Reports, no GitHub PRs), 2 with a person's hint; the measure asks for 5 ready PRs and one superchat-lite ticket end to end. **Not met.**

## W5 exit, honestly

| §0 measure | status |
|---|---|
| 1 Setup on A–D under 20 min, Claude | met (W2); Kitchen's own repo: 277 s, $1.05 |
| 1 … on Codex | **open condition**: Codex quota until 2026-12-21 |
| 2 Benchmark ≥ 85% correct | met on pre-W4 code (W3b: 53/60 = 88%); **pending** the orchestrator's final benchmark on merged main |
| 2 Every planted trap caught in all 3 runs | **not met yet**: traps 3/3 on two, 2/3 on two (the misses stopped at needs-human); **pending** the final benchmark |
| 2 ≤ 1 false FAIL on the controls; held-out within 15 points | met (0 false FAILs; held-out 94% vs tuned 86%), to be confirmed by the final benchmark |
| 3 Codex 6-ticket subset | **open condition** until 2026-12-21 |
| 4 Kill and resume | met (W1 faults 27/27; and incidentally in dogfooding today) |
| 5 Dogfooding: 5 own tickets to ready PRs + one superchat-lite ticket | **not met**: 4 own tickets done (2 with a hint), findings above; superchat-lite **open condition**: needs a bigger machine than this laptop's Docker budget |
| Ledger tracks every measure from the first run | met (`kitchen report`, here on the dogfood clone and the W3b ledger) |
| W5 exit: newcomer from a fresh clone of fixture B to a ready PR with only the README | met ($0.73) |

So W5's own build is done and proven; v0.1 is **not** done: §0.1/§0.3 wait for Codex, §0.2's traps wait for the final benchmark, §0.5 needs one more own ticket to a PR without help (after fixing dogfood findings 1–2) and the superchat-lite ticket on a bigger machine.
