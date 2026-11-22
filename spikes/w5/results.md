# W5 results: learning, dashboard, release prep

All on Claude Code (Codex is out of quota until 2026-12-21). Scratch runs lived in the session scratchpad; what matters is committed here (screenshots, the W3b ledger copy, the report output).

## Exit table

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
