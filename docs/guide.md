# Kitchen guide

The long version of the README's five steps: what each command does and prints, the commands, the dashboard and a
worked example. Settings are in [configuration.md](configuration.md); what Kitchen protects and what it can't in
[safety.md](safety.md). Why it is built this way: [ADR 0016](adr/0016-kitchen-lite.md).

## 0. What you need

- Node 20.11 or newer, git, and a repository with at least one commit.
- Python 3 (standard library only): the guard hooks run on it.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), signed in, at the version Kitchen is tested with or newer (`kitchen run` refuses an older one and says `claude update`). Or Codex (`codex`, `agent.tool: codex`): `kitchen run` drives it headless too, though that path has been tested against stand-ins only, not yet on a real Codex run. `kitchen run` works the queue headless, starting one session per lane; `/kitchen run` works it in a Claude Code session you watch.
- A browser for QA: Google Chrome or Microsoft Edge, or Playwright's Chromium already on disk. Kitchen never downloads one.
- Optional: the GitHub CLI (`gh`), signed in. With it, and `origin` on GitHub, jobs go to their target through pull requests that a person merges (`staging.merge: pr`); without it, Kitchen merges into a local `staging` branch.

`kitchen init` checks the tools first and reports the browser; `kitchen doctor` checks the browser and your project's setup any time.

## 1. Install

Kitchen isn't on npm yet. From source:

```sh
git clone https://github.com/jcodebreaker/kitchen.git && cd kitchen
npm ci && npm run build && npm link   # puts `kitchen` on your PATH, with Playwright pinned
# QA uses the Chrome or Edge you have; with neither, install Playwright's Chromium once, by hand, in that folder:
# npx playwright install chromium     # Kitchen's pinned Playwright; kitchen doctor prints the exact command
```

Once it is published: `npm install -g devkitchen`, and the Chromium command runs in `"$(npm root -g)/devkitchen"`.

## 2. Set up Kitchen in your repo

```sh
cd your-repo
kitchen init
```

```
Checking what Kitchen needs…
  ✓ node     26.9.0
  ✓ git      2.39.5 · the repo has a commit
  ✓ python3  3.11.9 · for the guard hooks
  ✓ claude   signed in (claude.ai)
  ✓ gh       signed in (optional: to merge into staging on GitHub)

Setting up Kitchen in library…
  ✓ Wrote kitchen.yaml     1 check from package.json · app: `npm start` (reset `npm run reset`) · staging from main
  ✓ Installed the skill    /kitchen for Claude Code and Codex · role skills: 6 of 7 found (kitchen skills)
  ✓ Verify skill           verify-library for Claude Code and Codex: 4 files written · the feature map fills in as QA touches features
  ✓ Installed guard hooks  8 added to .claude/settings.json · secrets, key literals, protected push, deletes, worktree
  ✓ Updated .gitignore     17 Kitchen entries
  ✓ Staging branch         created staging from main (ce19c60)
  ✓ Project setup          nothing failing                                   0.1s
  ok        browser            Chrome, for QA's pages: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  set       reset              npm run reset
  set       start              npm start
  set       health             /healthz
  set       stop               the process group
  run kitchen doctor --app to try prepare/start/health/stop (and --reset when it's safe)
  QA lanes and the merge gate run app.reset/app.start with your shell's environment
  ✓ Ran the checks         test passed on main                               0.3s
Done in 0.9s · no agent
```

- **The preflight.** A ✗ comes with the exact command that fixes it on your OS; a required ✗ stops init (exit 2) before anything is written. Kitchen installs nothing and signs no one in.
- **kitchen.yaml.** The checks (from `package.json`, `Makefile`, `pyproject.toml`, `go.mod`, `Cargo.toml`), your end-to-end suite if there is one, and how QA starts your app (`app:`: from `package.json` scripts, Django's `manage.py`, a `Makefile`). When nothing obvious starts the app, init asks you one question in a terminal; `--yes` asks nothing. The app gets a free port in `$PORT`, so two jobs can run theirs at once.
- **Your end-to-end suite** (a `test:e2e`, `e2e`, `test:integration` or `cy:run` script; else a `playwright.config.*` → `npx playwright test` or a `cypress.config.*` → `npx cypress run`; else a Makefile `e2e` / `integration` target) becomes the check `{ name: e2e, run: …, when: merge, needs_app: true, timeout_sec: 900 }`: it never runs after Build, only on the trial merge into staging, against the app Kitchen starts from the merged result (its URL in `$BASE_URL`, `$PLAYWRIGHT_BASE_URL`, `$CYPRESS_BASE_URL`; `needs_app: false` when there is no app to start). Point your suite's base URL at one of them. Init doesn't run it. When your `docker-compose.yml` publishes a fixed host port, init says so: a compose app's port must be `"${PORT}:<port>"` for two jobs' stacks to run side by side (see [configuration](configuration.md)).
- **The guard hooks** are copied to `.claude/hooks/kitchen/` and merged into `.claude/settings.json`: what was there stays, the old file is backed up beside it, nothing is added twice. See [safety.md](safety.md).
- **The verify skill** (`.claude/skills/verify-<app>/` and the same for Codex under `.agents/skills/`): `SKILL.md` (Launch, Doctor, Your tests, Drive, Evidence, Cleanup, filled from what init found; **Your tests** names your suite's folder, its page objects, fixtures and helpers, its login and seed helpers, and the command to run one spec against QA's app) and `features/README.md`, the feature map's index. No feature files: the first QA that touches a feature writes its file. Init again refreshes these two files only while they are still as Kitchen wrote them; a file you (or QA) changed is kept. See [The verify map](#the-verify-map).
- **staging** is created from the branch you are on (on GitHub too, when `origin` is there and `gh` is signed in). On GitHub, init also writes `staging.merge: pr`: Kitchen opens a PR for each passing job and a person merges it (see [4. Run the queue](#4-run-the-queue)).
- **Project setup** (ADR 0033): init runs kitchen.yaml's `requires:` checks once, names the browser QA will use, and reports how the app is set up (`set` rows: reset, start, health, stop, and any `scenarios` or `whoami`). It never resets, starts or stops your app: Kitchen can't tell whether `app.start` migrates or seeds whatever your environment points at.
- **The checks run once** on your checkout. If they fail, every job's would too: fix them first.

**Try the app before the first run.** `kitchen doctor` is read-only: `requires:`, the browser and the app's rows, each ok, missing, failing or not tried, with its fix. `kitchen doctor --app` starts the app once the way QA does, on a throwaway checkout of `HEAD` under `.kitchen/doctor/` (removed after, also on Ctrl-C), with your shell's environment, and says so first:

```
Project setup (ADR 0033): requires, then prepare, start, health and stop once on a throwaway checkout of HEAD
  this starts your app with your shell's environment: if it migrates or seeds on start, it touches whatever DATABASE_URL/env points at
  ok        browser            Chrome, for QA's pages: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  not tried prepare            no node_modules in a fresh checkout, and kitchen.yaml names no checks_install or checks_prepare
  not tried reset              kitchen doctor --reset runs it (it may wipe the data your local app uses)
  ok        start              npm start
  ok        health             /healthz answered
  ok        stop               the process group ended
Nothing failing.
```

`kitchen doctor --reset` runs `app.reset` too, which may wipe the data your local app uses. A fixed port (`app.port`, or a port in `app.url`) that already answers is left alone: "start not tried: port 3000 is in use (another job's app or yours)". Doctor exits 1 when anything fails; `kitchen run` refuses to start while a `requires:` check fails, or when QA needs a browser and none is found.

**Before the first ticket, commit the setup and bring staging up to it.** Commit `kitchen.yaml`, `.gitignore`, `.claude/settings.json`, `.claude/hooks/kitchen/` and the skill folders (`.claude/skills/`, `.agents/skills/`), then move `staging` to that commit: `git branch -f staging` locally (safe while nothing has merged yet), or `git push origin HEAD:staging` with `forge.kind: github`, since jobs then start from `origin/staging`. Jobs start from `staging`, and that is where QA finds the verify skill; if you skip this, the first map update brings Kitchen's skeleton along. Init's last lines say the same.

A repo set up by an older Kitchen keeps working: `kitchen.yaml` keys that no longer exist are ignored (init names them), old job folders read with their stages folded in, and an old `.kitchen/toolkit` is used to start the app when `app.start` is empty.

## 3. Give Kitchen a ticket

```sh
kitchen ticket "Show the due date on each loan"
# ticket 001-show-the-due-date-on-each-loan  "Show the due date on each loan"  → intake · Kitchen started
```

Filing a ticket wakes Kitchen (ADR 0025): when nothing works the queue, it starts `kitchen run --detach` and says "Kitchen started"; when a run is already going, it says "Kitchen is already working the queue". `kitchen approve`, `feedback`, `resume`, `promote` and `inbox run` (and the dashboard's buttons) do the same. `--no-run` files the ticket and starts nothing.

Plain words are enough. The intake lane reads the code as Build would start from it (a read-only checkout of the job's target), rates the ticket (kind, risk), lists the files it expects to touch and writes one to five criteria, each tagged with how QA checks it: `page` (a real browser), `http`, `test` or `cmd`. Each criterion is one observable claim, and may name the state it needs after ` · given: `:

```
- C1 (http): POST /loans/4/renew as ana → 200, due_at 14 days later
- C2 (http): renewing an overdue loan → 409 · given: ana has an overdue loan
- C3 (http): ana accepts her offer · given: scenario offer-pending
```

QA reads a `given` state back through the app before it checks the claim, and a precondition that doesn't hold is "not run", never a fail (ADR 0031). A `given` may name one of kitchen.yaml's `app.scenarios`. Kitchen refuses an `intake.md` with a criterion line it can't read (two kinds, no kind, an id twice) and intake writes it again, so a criterion is never changed silently (ADR 0029). If intake can't tell what done looks like, it asks you one question (`kitchen status` shows it; answer with `kitchen feedback`).

**Another target.** `kitchen ticket --into feature/checkout "…"` aims one job at an existing branch (ADR 0026): its intake reads that branch, its Build starts from it, its checks and merge check run on it, and it merges there. The branch must exist (on `origin` with `forge.kind: github`, else locally); Kitchen never creates it. With `staging.merge: kitchen`, the base, `main` and `master` are refused; with `merge: pr` any branch is fine, since a person merges the PR.

**A check.** `kitchen ticket --check "check a member can borrow and return a book"` tests what is already there (ADR 0028): intake writes what to check (or `EXPLORE: <minutes>` for "go through the loan flow and see what breaks"), QA drives the target's tip as it is, and nothing is built or merged. The job ends at Done, "Checked on staging · 3 of 3 pass", or "Found 1 problem" with each problem proposed in the inbox for you to run, hold or set aside. A problem says what was **seen**, what was **expected** and its **suspected** or **confirmed** cause; a confirmed cause must cite evidence of the cause itself. A high-severity problem (or any problem a high-risk check finds) gets a **second look** by another agent before it is proposed; one that doesn't hold up stays in the Report as "not confirmed" (ADR 0031). A check that couldn't run for want of tooling ("a test runner for the API") proposes a chore to add it, waits for it, and is filed again once that chore merges into the check's target (ADR 0033).

```sh
kitchen ticket --check --every day "check a member can borrow and return a book"   # a launchd agent or systemd timer files it each day
kitchen ticket --check --every off "check a member can borrow and return a book"   # the same text removes it
kitchen schedules                                                                   # this repo's timers, each with how to remove it
```

**Code that isn't kept.** Code asked for only to verify something now ("a harness that proves the import handles 10k rows") gets `KEEP: no` from intake: it is built, its checks run and QA checks it, then it stops at Done, "Verified · not merged", its branch kept. `kitchen promote <id>` (or Promote on its panel) takes it the rest of the way: review, the merge check, the merge into its target or its PR.

When one short answer won't do (the ticket can be read more than one way, it is too big for one job, a bug has no way to see it, or its words mean something else in the code), intake sends it to be refined with you instead: `kitchen status` shows `needs-info(refine: readings)` and the dashboard shows the readings under Needs you. In Claude Code or Codex, say `/kitchen refine 004`: the session runs `kitchen refine 004` (a brief with the ticket, intake's readings, the verify map's features and your glossary and ADRs), asks you one question at a time with a recommended answer, writes the refined ticket (problem, in, out, the criteria you agreed, and slices when it is too big), and after your yes sends it back with `kitchen feedback`. Intake reads it as your own words and doesn't send it back for the same reason. Lane agents never grill: only your own session does. To check every reading before it is built, set `intake: { confirm: true }` in `kitchen.yaml`: each accepted job then waits with its criteria and what intake left out, for `kitchen approve <id>` (or Approve on the dashboard) or `kitchen feedback <id> "<what to change>"`.

## 4. Run the queue

A ticket already started it (above). By hand, in a terminal: `kitchen run`, the headless default (add `--detach` to put it in the background; `kitchen run --print` shows each lane's command and runs nothing). Kitchen is the orchestrator itself (ADR 0030): a plain Node scheduler, and no model plans the waves. It starts one headless session per lane (`claude -p`, or `codex exec --json` with `agent.tool: codex`) on the lane's model, and the moment a session ends it finishes that lane and fills the free slot, so a fast lane never waits for a slow one. Before it starts it brings the repo's copy of the kitchen skill, its hook scripts and Kitchen's `.gitignore` entries up to date, and runs its preflight: the tool must be there and, for Claude Code, at least the version Kitchen is tested with ("Claude Code X is older than Kitchen needs (Y). Update it: claude update"); every `requires:` check must pass; and when QA will need a browser, one must be found. Any of these refuses with its fix and starts nothing. It refuses a flag it doesn't know too, and inside a session Kitchen started it refuses to start another.

- **One run per repo.** `.kitchen/run.lock` decides it; a second `kitchen run` says it is already running.
- **Logs.** Each lane's raw stream is `.kitchen/jobs/<id>/rounds/<n>/<lane>.jsonl`; `.kitchen/run.log` is the readable log of a detached run.
- **Budget.** `--max-usd` (or `agent.max_usd`) is the whole run's budget, summed over its lane sessions: each Claude lane gets a share of what is left as `--max-budget-usd`, and once less than a lane needs is left, nothing new starts. Codex reports tokens, not dollars, so no cap applies to it.
- **A tool that fails before any work** (not signed in, a rate limit, an unknown model) stops the run with the tool's last line, "Nothing more started", and spends no try; so do three lane sessions in a row that crash.
- **Stopping.** `kitchen run --stop` ends the run and every lane; the jobs keep their state and the next run starts those lanes again. `kitchen stop <id>` and `kitchen remove <id>` end that job's lane session at once.
- **Nothing left running** (ADR 0029). Every session runs in its own process group: when it ends (or is stopped), the group goes, with anything its agent started by hand. A job's app is stopped on every way out of a lane, and when the queue drains Kitchen stops every app whose job isn't in a running lane.

In Claude Code, `/kitchen run` (or `/kitchen:kitchen run` from the plugin) makes your session the orchestrator instead, with one lane subagent per lane, so you can watch it work. Either way the loop is:

1. `kitchen job next`: the next wave. Intake first (never held for room, even past `parallel`), then downstream first (review, QA, build) in the room `parallel` leaves. Jobs that touch the same files build side by side: git merges each into `staging`, and one that conflicts catches up (below). Only a job that names an unfinished one on its `AFTER:` line waits for it.
2. For each lane, `kitchen job start <id> <lane>` makes the job's worktree (`.worktrees/<id>`, branch `kitchen/<id>` from its target), writes the lane's brief and hands over your unread messages; one agent starts with the prompt and model it returns.
3. When the agent ends, `kitchen job finish <id>`: Kitchen reads what the lane left and moves the job, or refuses and says why. A lane whose agent crashed and left nothing is refused the same way and runs again. Until finish has run, the dashboard says "Finishing".

| lane | the agent | Kitchen, at `finish` |
|---|---|---|
| intake | reads a read-only checkout of the job's target; writes `intake.md`: decision, kind, risk, files, criteria | refuses a criterion line it can't parse; accepts it into Build (a check: into QA), or asks you, or sends it to be refined with you, or rejects |
| build | changes the code in the worktree and commits | refuses uncommitted work or no commits; runs your checks itself; red checks: Build again |
| qa | reads the verify skill's Your tests, `kitchen qa up`, then each criterion against the running app (`kitchen qa page` for pages, `kitchen qa http` for APIs; `kitchen qa reset` before one that needs fresh seed data; `kitchen qa scenario` for a prepared state, `kitchen qa whoami` for who it acts as; an existing spec that checks the criterion, run against the app as evidence; never an edit to the suite) and the recipes of the features the job touches; `verdict.json` citing its evidence files, a row `NOT_RUN` with its why when it couldn't test that criterion; map updates in `map/` | refuses a verdict with a missing row, missing evidence (a page PASS needs a screenshot) or a capture stamped for another job, round or commit; FAIL: Build again, next round. NOT_RUN and no FAIL: QA again on just those criteria on fresh seed data, no Build round spent (for a check, that retry does count as a round); still not run, it goes to you ("QA couldn't test C2: …"). PASS: commits the map updates into the job branch, or refuses them (the contract, a weakened check) |
| review | reads the diff (map updates included) and QA's evidence, writes `review.json` | refuses a review whose branch moved; a blocking finding: Build again; else the merge |
| regress | the merge check: drives the touched features' recipes on the trial merge (the target with the job merged), `verdict.json` with one row per feature | refuses a missing row or evidence; FAIL: Build again with the evidence; PASS: that exact merge lands (if the target moved meanwhile, Kitchen merges again and the lane drives the new one) |
| second-look | a check's only: reads each high-severity finding, its evidence and repro in the checkout QA drove, changes nothing, writes `second-look.json` sends the job to a person (needs-human) if QA's verdict changed since; proposes the confirmed findings; the others stay in the Report as "not confirmed" |

A check job goes Intake → QA (→ second-look) → Done; a `KEEP: no` job goes Intake → Build → QA → Done, its branch kept for `kitchen promote`.

A lane refused three times, or a job out of rounds (`round_limit`), goes to you (`needs-human`). A catch-up (below) is not a round.

**The merge.** Review passed: under a lock per target, Kitchen merges the reviewed head onto the job's target (`staging`, or its `--into` branch; the rest of this section says staging) as it is now in a scratch worktree, runs your checks there (the `when: merge` ones too: for a `needs_app` one, the app starts from that worktree, the check runs against it, and the app is stopped whatever happened), and moves `staging` only if they pass (on GitHub: it pushes the job branch, opens its PR into `staging` and merges it with `--match-head-commit`). While checks or the app's setup run, the dashboard shows the step ("Checks · `npm test` · 3m 12s", "Waiting for /healthz · 40s of 120s") with the log's last line. If the merge check's app finds its fixed port taken, the job waits at Ready ("merge check waits: port 3000 is in use (another job's app or yours)") and is tried again once the port is free, spending no round. A conflict, or checks red only because `staging` moved: a **catch-up**, not a round (ADR 0018). The job goes back to Build, which starts by merging `staging` as it is now into the job branch (a clean merge is committed by Kitchen; a conflicting one is left for the builder to resolve and commit, and Kitchen refuses a build whose branch doesn't contain `staging`'s tip). The builder only makes the merge work; QA re-drives what passed; review reads what changed since the last passing review (the resolution); the merge check runs as usual. Three catch-ups in a row go to you ("staging keeps moving under it"). Red checks that `staging` didn't cause are a round, and so is a red `when: merge` check always (it never ran on the branch alone); the red check's last lines (a failing spec's output) are in the next builder's brief. High risk, a change to a `high_paths` file, more than `staging.max_lines` changed lines, or `staging` checked out somewhere: the job stops at **Ready** for you, with the reason. It waits under Needs you on the dashboard ("Ready for you: 530 changed lines, over 400: …") until you act: **Merge into staging** there, or `kitchen merge <id>`, runs this same merge (the trial merge on `staging`'s tip, every check, the merge check when it touches features, then `staging` moves; on GitHub, its PR), without the hold, and the Report says "Merged by you on <date>"; a conflict or red checks send it back to Build. **Ask for changes** (or `kitchen feedback <id> "…"`) sends it back for another round instead. Never into `main`.

**Who merges.** With `staging.merge: kitchen` (the default for a local repo), the above. With `staging.merge: pr` (what `kitchen init` sets when `origin` is on GitHub), Kitchen never merges: after the merge check passes it pushes the job branch and opens (or updates) a PR into the target with the Report as its body, and the job waits under Needs you as "PR open · waiting for review" (`ready(PR open)` in `kitchen status`). A person merges it on GitHub, under your review, CI and branch protection. Kitchen looks at the PR at most once a minute: merged moves the job to Done, closed to Rejected. When the target moves under an open PR, the merge check runs again and the PR is updated. `kitchen merge` refuses such a job; rejecting or removing it closes its PR.

## The verify map

Kitchen keeps how to check your app in the repo, as a skill every agent can read: `.claude/skills/verify-<app>/` (and the same under `.agents/skills/` for Codex). A repo that ignores `.claude/` keeps it on your machine instead (`.kitchen/verify/skill/`, kitchen.yaml `verify.map: local`): Kitchen copies it into every checkout it makes and saves QA's updates there, never in a commit. `SKILL.md` says how to launch, doctor, drive and clean up the app with `kitchen qa`; `features/` is the **feature map**: `README.md` (the index, baseline preconditions, driving conventions, the sweep order) and one file per user-facing feature:

```markdown
# Search books
A person finds books by part of the title or the author.
## Sub-features
- `search-match` finds books by title or author, ignoring case.
## How to get to it (user POV)
- On `/`, the Search box (`#book-search`) above the Books table.
## Driving it with kitchen qa
Preconditions:
- The app is up on seed data (`kitchen qa reset <id>`).

- **Author match.** Type `tolkien` in `#book-search`. Run `kitchen qa page <id> / --name search-author --script …`. Only the two Tolkien books remain.
## Gotchas
- The list follows the box as you type: wait for the rows, not a fixed time.
Code: `public/app.js`, `server.js`
```

- **QA follows and keeps it.** The QA brief carries the index and the feature files whose `Code:` covers the job's files (intake's `FILES:` and the diff). QA follows those recipes as well as the criteria, then writes new or changed feature files into its QA folder under `map/`. When QA passes, Kitchen checks them (the four headings in order, sub-feature ids, steps, a `Code:` line) and commits them into the job branch, in both tools' copies, so review sees them in the diff. A builder that changes `verify-*/` is refused.
- **Before a merge into staging, the touched features are driven.** After review passes, Kitchen merges the job onto `staging` in a scratch worktree, runs your checks, and lists the features whose `Code:` covers a file the merge changes. None: it merges. Some: the job moves to **regress**, a short lane where one agent drives exactly those recipes on that merged result. Red: back to Build with the recipe and its evidence. Green: that merge lands. Kitchen's code picks the features; an agent drives them, because recipes are prose.
- **A recipe is never weakened.** A map change that removes a sub-feature, a recipe step or an expected result is refused unless intake wrote `CHANGES: <feature>/<sub-feature>` for it (the ticket changes that behaviour on purpose). The Report shows each such change as "Changed earlier check: was …, now …". The rule, over the markdown: a sub-feature is its id; a step is its bold label; its expected result is the text after its `Run` command; a step that names a sub-feature in backticks needs that one on `CHANGES:`, one that names none needs any of its feature's.
- **Later rounds re-drive.** In round 2 and later, when the last QA passed and the criteria are the same, the QA brief says to re-drive what passed (its checks, scripts and the recipes) rather than explore from zero.
- **Keeping it small and current.** The map grows with features, not tickets. Two runs use it outside jobs, each one agent that the `/kitchen` skill starts:
  - `kitchen verify sweep`: before you merge `staging` onward. It checks out `staging`, starts the app and writes a brief to drive every feature in the README's order; `kitchen verify finish <run>` writes `.kitchen/verify/<run>/report.html`. It changes nothing.
  - `kitchen verify sweep --url <url>`: the same against a deployed environment (after a release cut, say): nothing starts locally, `kitchen qa page|http <run>` go to that URL, recipes that need a reset or seed are reported "not run: needs a fresh seed" (not failed), and the report names the URL. The URL stays in that run; jobs never use it.
  - `kitchen verify maintain`: map upkeep on a branch of `staging` (prune, merge duplicates, fix drift from each feature's `Code:`, drive every feature). A product regression becomes a new ticket (`kitchen ticket`), never a weaker map. `kitchen verify finish <run>` refuses edits outside the verify skill and removals without a reason, then merges the branch into `staging` through the same merge gate as jobs.

## 5. Read the Report

Every job that merged, stopped at Ready or needs you has `.kitchen/jobs/<id>/report.html`:

- **What you must check**, first: when a step failed, what failed, the one useful line of its log and what to do next (the same three lines the dashboard card shows); why it is held; review notes; what intake left out; every earlier check it changed on purpose ("Changed earlier check: was …, now …").
- **Each criterion** with QA's result and its evidence (screenshots inline, transcripts quoted), with its `given` state as QA read it back. A criterion QA couldn't test reads "not tested", with why, and never counts as a fail.
- **Problems found** (a check): each with Seen, Expected, and a Suspected or Confirmed cause; missing tooling is listed apart.
- **The features driven before the merge**, the review, and what changed.
- **What was checked** (ADR 0032): the commit QA tested and the target's tip, the browser, Kitchen's and the tool's versions, each lane's model; each kitchen.yaml check (passed, failed, not run, or off); languages the change touches that no check covers ("python checks: none in kitchen.yaml"); touched features with no recipe, and changed files no feature covers.

`kitchen status` prints its path; the dashboard opens it.

Merge `staging` into your base when you are happy with it. Kitchen never does.

## 6. The outer loop: reports in, you choose what runs

`kitchen ticket` and New ticket go straight to the queue (the inner loop). The outer loop is for what *might* be built: reports Kitchen collects, triages and proposes, and you choose from (ADR 0022).

- **Sources**, read by Kitchen's code (no tokens spent): GitHub issues with a label (`kitchen sources add github <owner/repo> --label kitchen`, through your `gh` login) and Slack threads marked with an emoji (`kitchen sources add slack <channel id> --channel-name '#bugs' --emoji kitchen`; it prints how to create your workspace's own Kitchen app from `slack-app-manifest.json` and store its token in your keychain with `kitchen sources slack-token`). In Claude Code, `/kitchen sources` does it by talking, with a test read first (`kitchen sources try …`). Kitchen's own findings (QA notes outside a job's criteria, a passing review's notes, failed sweep or upkeep recipes) come in by themselves.
- **Collect** (`kitchen collect`, the dashboard's Collect, or `kitchen collect --install-schedule [--every 1h]`: launchd on macOS, a systemd timer on Linux) reads every source, adds what is new (each item keyed `source:id`; an edited report is a new sighting, never a duplicate), then starts one headless triage session that reads the new items together, groups them by cause, reproduces candidates on `staging` with the verify map and `kitchen qa`, and gives each a verdict through `kitchen inbox propose|verdict`: proposed (with priority P1–P3 and its reason), duplicate, fixed, not ours or unclear. It never builds, merges, closes an issue or posts. One collect at a time; a source that can't be read is "unavailable" and keeps its watermark.
- **Check findings** come in the same way: each problem a check found (ADR 0028) is a proposal with what was seen, what was expected and the cause, linked back to its check. A proposal that failed to save is kept on the job ("proposals failed: …") and proposed again on the next wave, never twice.
- **You choose**: the dashboard's Outer loop (Inbox, Held, each source) or `kitchen inbox list` / `run <p…>` / `hold` / `bring-back` / `remove` / `edit`. Run files the proposals as jobs at intake, highest priority first; each keeps where it came from ("from GitHub #17"). When a job from a GitHub issue merges into staging, Kitchen comments the merge on the issue, and nothing else. Triage runs on Claude Code; with `agent.tool: codex`, ask Codex to triage the inbox through the skill.

## Commands

```
kitchen init [--tool claude|codex] [--yes] | init --skill
kitchen doctor [--app] [--reset]                     the project's setup: requires:, the browser, the app
kitchen ticket "<text>" [--into <branch>] [--no-run] [--check]
kitchen ticket --check --every <day|hour|2h|…|off> "<text>" · kitchen schedules
kitchen run [--detach] [--max-usd n] | run --stop | run --print
kitchen status [--json] [--all] · kitchen report [--json] · kitchen skills
kitchen dashboard | dashboard --forget | dashboard --private [--port n] | dashboard --restart [--port n]
kitchen feedback <id> ["<text>"] [--to <stage>]
kitchen refine <id> · approve <id> · merge <id> · promote <id>
kitchen steer <id> "<text>" · pause <id> · stop <id> · resume <id> · reject <id> · remove <id> · restore <id>
kitchen models [--json] [--tool claude|codex] | models set <lane> <model|tier> [--tool t] | models check
kitchen job next|start|finish|show …     the orchestrator's verbs
kitchen qa up|down|reset|page|http|scenario|whoami <id> …   the QA lane's tools (<id>: a job, or a verify run)
kitchen verify sweep [--url <url>] [--json] | verify maintain [--json] | verify finish <run>
kitchen sources [list|add|try|remove|slack-token] · collect [--detach] [--no-triage] [--install-schedule [--every 1h]|--remove-schedule]
kitchen inbox list|run|hold|bring-back|remove|edit|add|propose|verdict …   the outer loop (ADR 0022)
```

`kitchen --help` lists every verb with a line each, and `kitchen <verb> --help` says more.

- Run them in the repo, or inside a job's worktree (`.worktrees/<id>`, where lane agents work): there they act on the main checkout's jobs, so QA's `kitchen qa up <id>` works from its worktree. A git worktree of your own elsewhere is its own repo.
- `steer`: a message for the job's next agent; it is quoted into that lane's brief as operator notes and marked read by it.
- `pause`: the job parks when its current lane finishes. `stop`: it parks now, and the working agent's result is dropped (its `finish` is refused); under `kitchen run` its session ends at once, under `/kitchen run` the subagent finishes its current work. `resume`: back where it paused.
- `remove`: off the dashboard, `kitchen status` and the queue, whatever the stage. A lane working on it is stopped (under `kitchen run` its session ends; in a session of your own, Kitchen's guard hook refuses its agent's next tool call; either way its `finish` is refused), a job not merged is rejected and its worktree removed (the branch and the job folder stay), a merged job is only hidden (staging is never touched). `kitchen status --all` lists removed jobs; `kitchen restore` shows one again, as it was left. The dashboard's Remove (a row's hover icon, the panel's header) waits five seconds for its Undo before it is sent.
- `feedback`: answers `needs-info` (back to intake, with your answer in the clarifications) or `needs-human` (back to the stage it stopped in, or `--to`); on a ready or merged job it starts a follow-up round.
- `refine`: for a job intake sent to be refined with you: writes `.kitchen/jobs/<id>/refine/brief.md` and prints its path, for a Claude Code or Codex session to follow with you (`/kitchen refine <id>`). `approve`: a job `intake.confirm` holds after intake goes to Build on its criteria.
- `merge`: a job held at Ready (`ready(held)`) into its target, through the same gate as an auto-merge. `promote`: a `KEEP: no` job ("Verified · not merged") through review, the merge check and the merge.
- `models`: each lane's model and what the tool offers; `models check` sends one tiny request per chosen model, the only command that spends money outside a run.

## Dashboard

`kitchen dashboard` serves http://127.0.0.1:7357/, one page for every repo on `~/.kitchen/repos.json` (`kitchen init` and `kitchen dashboard` add the repo they run in; `--forget` removes it; a repo whose folder is gone drops off).

- **Repos.** The repo name at the top left opens a switcher (⌘1–⌘9) with each repo's "needs you" and running counts; the badge beside it counts jobs in other repos that need you, and the address carries the repo (`#<repo>`). Running `kitchen dashboard` in another repo while the page is open adds the repo and prints `already open: http://127.0.0.1:7357/#<repo>`; it never takes another port. `--private` (or `--port n`) serves one repo on its own, off the list.
- **Jobs.** A List and a Board with lanes Needs you (a job held at Ready waits there, with Open report, Merge into staging and Ask for changes), Intake, Build, QA, Review (a job in regress shows there, as "Merge check"; a check's second look too) and Done (merged, checked, verified or rejected).
- **Why it waits.** A job that isn't running says why: "Waiting for a free lane · 006 and 007 are using both (parallel: 2)", "Waiting for 007 to merge first (named on its AFTER: line)", or "Waiting for the orchestrator (kitchen run)". While checks or the app's setup run, the card shows the step and the log's last line.
- **What failed.** A job that needs you because a step failed shows three lines instead of a raw log: what failed ("Checks failed: test", "QA couldn't test C1"), the useful line, and what to do next ("Fix the environment, then Reply: QA runs again (or kitchen resume 004)"). The raw output is one click away.
- **A job's panel** shows each stage with its lane and model and the lane agent's live activity (its session's own stream under `kitchen run`; the activity hook's for an in-session lane), the criteria with QA's results and what was tested, and the changed files. From it you answer, steer, pause, resume, stop, reject, merge a held job, promote and follow up, through the same functions as the CLI. A message goes to the job's next lane, never the agent working now.
- **Starting Kitchen.** When no orchestrator works the queue, **Start Kitchen** runs `kitchen run --detach`; an action that gives the queue work starts one too.
- **After an update.** When the Kitchen build on disk changes under a running dashboard, the page says "Kitchen was updated · restart the dashboard to use it" with the command: `kitchen dashboard --restart` stops the dashboard on the port and starts the new build there, detached, in the same mode. `KITCHEN_DASHBOARD_PORT` moves the shared dashboard to another port.

## A worked example

A small library app (books, members, loans; a home page that lists the books), four tickets and a check, filed one after the other:

```sh
kitchen ticket "Search books by title or author from the box above the book list"
kitchen ticket "Show available copies in bold in the book list"
kitchen ticket "Grey out books with no copies left"
kitchen ticket "Let members borrow up to 5 books at once"
kitchen ticket --check "Check a member can borrow and return a book, and the home page loads cleanly"
```

What `kitchen job finish` said as each lane ended (job ids shortened to their numbers; for this page the lanes' files were written by hand, where an agent would write the same ones):

```
001  intake ACCEPT feature low: 4 criteria → build
001  built (1 commit), checks pass → qa
001  QA PASS (4 criteria) · map search-books.md committed (0dc1d45) → review
001  review PASS → regress: drive search-books on staging with this job merged
001  regress PASS (search-books) → merged into staging (4d334e7)
002  intake ACCEPT ui low: 1 criteria → build
003  intake ACCEPT ui low: 2 criteria → build
002  built (1 commit), checks pass → qa
003  built (1 commit), checks pass → qa
002  QA PASS (1 criteria) → review
003  QA PASS (2 criteria) → review
002  review PASS → regress: drive search-books on staging with this job merged
002  regress PASS (search-books) → merged into staging (90d21a1)
003  merge into staging failed: it conflicts with staging in public/index.html → build (catch-up 1 of 3, no round spent)
003  built (2 commits), checks pass → qa
003  QA PASS (2 criteria) → review
003  review PASS → regress: drive search-books on staging with this job merged
003  regress PASS (search-books) → merged into staging (798a513)
004  intake ACCEPT feature low: 2 criteria → build
004  built (1 commit), checks pass → qa
004  QA couldn't test C1 (ana has no loans out on the seed data, and only 4 titles have a free copy: QA cannot give her five) → qa again on C1 on fresh seed data (round 2, no Build round)
004  QA still couldn't test C1 (still no state with five loans out for ana: the seed has 4 titles with a free copy) → needs-human
005  intake ACCEPT check: 3 criteria → qa on staging
005  check on staging 798a513: Found 1 problem · proposed p1 in the inbox → done
```

- 001's QA wrote the first feature file of the verify map, `search-books.md`, so every later merge that touches `public/index.html` or `server.js` drives its recipes first (the merge check).
- 002 and 003 built side by side and both changed the same line of `public/index.html`. 002 merged first; 003 conflicted, caught up on top of `staging` (its builder resolved the merge, QA and review looked again) and merged, without spending a round.
- 004's criterion C1 needs a state the seed data can't give, so QA couldn't test it: Kitchen ran QA again on C1 alone on fresh data, then asked a person, with what failed and what to do next.
- 005's check found the home page logging a 401 for `/favicon.ico`, and proposed it in the inbox with what was seen, what was expected and the suspected cause.

`git log staging` has the three merges; `main` is untouched; each job has its Report.

## Developing Kitchen

```sh
npm install
npm test            # vitest
npm run typecheck
npm run lint        # biome
```

Run the CLI from source with `node src/cli.ts …` (Node 22.18 or newer runs TypeScript directly). `npm run skills:readme` regenerates the README's skills table; `npm run plugin:sync` the plugin's copy of the skill.
