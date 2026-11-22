# Newcomer run notes

## Commands in order (all in tasks/ unless noted; PATH = prefix/bin:/opt/homebrew/bin)
1. `npm_config_prefix=./prefix npm install -g ./devkitchen-0.1.0.tgz` - ok, 2s.
2. `kitchen --version` - 0.1.0.
3. Wrote kitchen.yaml (sonnet/sonnet/haiku) from README tip.
4. `kitchen --help` - command list.
5. `kitchen init` (terminal path B, backgrounded, stdin /dev/null) - no questions asked; survey 14s $0.10; build; done: Toolkit proven on e18271d9033a, 143s agent time, $0.53. Wall ~3.5 min.
6. `kitchen init --status --wait 90` (x2) - showed progress, then done.
7. `git branch`, `git log --stat main..kitchen/setup` - 13 files under .kitchen/toolkit + .env.kitchen.
8. `git merge kitchen/setup`; `git add kitchen.yaml .gitignore .claude/skills/kitchen .agents/skills/kitchen`; `git commit` - ok, tree clean.
9. `kitchen ticket "Add a --version flag to the tasks command that prints the version from pyproject.toml"` - job 001-add-a-version-flag-to-the-tasks-command.
10. `kitchen run --detach` then `kitchen status` (polled in a loop) - intake -> build -> gate -> drives -> verify -> review -> ready -> report -> done in about 50s.
11. `kitchen report` - read measures. Opened .kitchen/jobs/001-.../report.html (read as text).
12. `git merge kitchen/001-add-a-version-flag-to-the-tasks-command` - fast-forward; `python3 -m tasks --version` prints `tasks 0.1.0`.

## Time and cost
- install 2s; init ~3.5 min, $0.53 (tool-reported); job ~35-50s, $0.198 (kitchen report). Ledger total $0.7278 (report footer). Under $1.50 cap.

## README issues
1. Step 1 / report: install check fine. `kitchen status --help` just runs status (no per-command help); minor.
2. Step 2B: README says "kitchen init asks its questions right there" but gives no hint what happens non-interactively; with stdin closed it asked nothing here (survey said no questions). Should say what to expect and how long it is silent: the terminal shows nothing for minutes except stage lines; mention `kitchen init --status --wait 90` also works for path B (I used it to watch progress, it was not obvious that it applies without --detach).
3. Step 2: README says Toolkit "costs about $0.50 to $1" - matched ($0.53). Good. Time "5 to 15 minutes" - actual 3.5.
4. Step 2: init edits .gitignore and creates .claude/, .agents/, kitchen.yaml in the MAIN tree uncommitted, and README's step 3 commit list covers them; ok. But it would help to say the branch is checked out in a worktree at .worktrees/_setup (git branch shows `+ kitchen/setup`) so `git checkout kitchen/setup` fails.
5. Step 3: assumes the default branch is called `main`; should say "your default branch" (`main..kitchen/setup`).
6. Step 3: after merging, nothing says that the next `kitchen run` re-proves the Toolkit on the merged commit (it did, automatically, ~2s) - fine but unmentioned.
7. Step 4/5: `kitchen ticket` prints job id; README never says that this id is what to use with feedback/reject, nor the full id format (it is 001-<slug>, README example "003-show-open-count" consistent).
8. Step 5: `kitchen status` right after `kitchen run --detach` says "runner: not running" for a moment (race), then "runner: pid ..". README should say to re-run, and that there is no wait option for `status` (README uses `--wait` only for init); polling needs a loop.
9. Step 5: README says "a few minutes"; it took under a minute. Fine.
10. Step 6: report path shown by `kitchen status` is absolute and correct. README says status "prints the path of its Report" - true. In local mode a status "no PR" column appears; README does not say that `no PR` is expected locally.
11. Step 6 local merge: `git merge kitchen/<id>` worked (fast-forward). README should say `<id>` is the full job id (001-...), and that the branch is kitchen/<full id>. Also does not say whether to clean up worktrees (.worktrees/) or branches afterwards (kitchen/setup, kitchen-evidence branch exist).
12. Report mentions "kitchen-evidence" branch / "PR comment posted (local forge: recorded)" in local mode; README says only GitHub uses the evidence branch. Confusing: a kitchen-evidence branch was created locally anyway.
13. Report content: report says verifier cannot tell pyproject was the source (fallback names package `fixture-b-cli`, wrong project name). Not a README issue but the "What a human must check" section was useful and honest.
14. Requirements (step 0) say "Python... whatever your app needs"; the Toolkit used node (.mjs) - Node already required, fine.
15. Sandbox note: environment forced me to split git commands; not Kitchen.
16. The README links to docs/PLAN.md, docs/BUILD-LOG.md, src/config.ts, docs/adr/0008 which are not in the npm package (I did not look); a user of the npm package cannot read them. Config schema reference "src/config.ts in this repository" is unreachable for an npm user; `kitchen --help` says "docs: README.md in the package".
17. `kitchen --help` has no per-command help and no `kitchen init --skill` line (README step 2A uses `--skill` and `--detach`; not in help). Not tested path A.

## Outcome
Reached done. Job 001-add-a-version-flag-to-the-tasks-command, final state `done`, verdict PASS (round 1, risk low). Report: /private/tmp/claude-501/-Users-simo-pttx/58ffbf3c-d628-41d8-aabb-4f73bfb4d366/scratchpad/newcomer/tasks/.kitchen/jobs/001-add-a-version-flag-to-the-tasks-command/report.html. Merged locally (fast-forward); `python3 -m tasks --version` -> `tasks 0.1.0`. Total cost ~$0.73.
