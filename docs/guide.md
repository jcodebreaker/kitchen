# Kitchen guide

The long version of the README's four steps: what each command does and prints, the commands, the dashboard and a
worked example. Settings are in [configuration.md](configuration.md); what Kitchen protects and what it can't in
[safety.md](safety.md). Why it is built this way: [ADR 0016](adr/0016-kitchen-lite.md).

## 0. What you need

- Node 20.11 or newer, git, and a repository with at least one commit.
- Python 3 (standard library only): the guard hooks run on it.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), signed in. The queue runs in a Claude Code session: yours (`/kitchen run`) or a headless one (`kitchen run`).
- Optional: the GitHub CLI (`gh`), signed in. With it, and `origin` on GitHub, passing jobs merge into `staging` through a pull request; without it, into a local `staging` branch.

`kitchen init` checks all of these first.

## 1. Install

```sh
npm install -g devkitchen        # puts `kitchen` on your PATH, with Playwright pinned
npx playwright install chromium  # once per machine, if Playwright's Chromium isn't there yet
```

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

Setting up Kitchen in e2e-lib…
  ✓ Wrote kitchen.yaml     1 check from package.json · app: `npm start` · staging from main
  ✓ Installed the skill    /kitchen for Claude Code and Codex · role skills: 6 of 7 found (kitchen skills)
  ✓ Verify skill           verify-e2e-lib for Claude Code and Codex: 4 files written · the feature map fills in as QA touches features
  ✓ Installed guard hooks  8 added to .claude/settings.json · secrets, key literals, protected push, deletes, worktree
  ✓ Updated .gitignore     10 Kitchen entries
  ✓ Staging branch         created staging from main (18a0d5a)
  ✓ Ran the checks         test passed on main                               0.3s
Done in 0.7s · no agent
```

- **The preflight.** A ✗ comes with the exact command that fixes it on your OS; a required ✗ stops init (exit 2) before anything is written. Kitchen installs nothing and signs no one in.
- **kitchen.yaml.** The checks (from `package.json`, `Makefile`, `pyproject.toml`, `go.mod`, `Cargo.toml`), your end-to-end suite if there is one, and how QA starts your app (`app:`: from `package.json` scripts, Django's `manage.py`, a `Makefile`). When nothing obvious starts the app, init asks you one question in a terminal; `--yes` asks nothing. The app gets a free port in `$PORT`, so two jobs can run theirs at once.
- **Your end-to-end suite** (a `test:e2e`, `e2e`, `test:integration` or `cy:run` script; else a `playwright.config.*` → `npx playwright test` or a `cypress.config.*` → `npx cypress run`; else a Makefile `e2e` / `integration` target) becomes the check `{ name: e2e, run: …, when: merge, needs_app: true, timeout_sec: 900 }`: it never runs after Build, only on the trial merge into staging, against the app Kitchen starts from the merged result (its URL in `$BASE_URL`, `$PLAYWRIGHT_BASE_URL`, `$CYPRESS_BASE_URL`; `needs_app: false` when there is no app to start). Point your suite's base URL at one of them. Init doesn't run it. When your `docker-compose.yml` publishes a fixed host port, init says so: a compose app's port must be `"${PORT}:<port>"` for two jobs' stacks to run side by side (see [configuration](configuration.md)).
- **The guard hooks** are copied to `.claude/hooks/kitchen/` and merged into `.claude/settings.json`: what was there stays, the old file is backed up beside it, nothing is added twice. See [safety.md](safety.md).
- **The verify skill** (`.claude/skills/verify-<app>/` and the same for Codex under `.agents/skills/`): `SKILL.md` (Launch, Doctor, Your tests, Drive, Evidence, Cleanup, filled from what init found; **Your tests** names your suite's folder, its page objects, fixtures and helpers, its login and seed helpers, and the command to run one spec against QA's app) and `features/README.md`, the feature map's index. No feature files: the first QA that touches a feature writes its file. Init again refreshes these two files only while they are still as Kitchen wrote them; a file you (or QA) changed is kept. See [The verify map](#the-verify-map).
- **staging** is created from the branch you are on (on GitHub too, when `origin` is there and `gh` is signed in).
- **The checks run once** on your checkout. If they fail, every job's would too: fix them first.

Commit `kitchen.yaml`, `.gitignore`, `.claude/settings.json`, `.claude/hooks/kitchen/` and the skill folders (`.claude/skills/`, `.agents/skills/`) before the first run, and bring `staging` up to that commit (`git branch -f staging` while nothing has merged yet): jobs start from `staging`, and that is where QA finds the verify skill. If you don't, the first map update brings Kitchen's skeleton along.

A repo set up by an older Kitchen keeps working: `kitchen.yaml` keys that no longer exist are ignored (init names them), old job folders read with their stages folded in, and an old `.kitchen/toolkit` is used to start the app when `app.start` is empty.

## 3. Give Kitchen a ticket

```sh
kitchen ticket "Add GET /stats returning how many books and members the library has"
# ticket 001-add-get-stats-returning-how-many-books-a  "Add GET /stats returning how many books and members the…"  → intake
```

Plain words are enough. The intake lane rates it (kind, risk), lists the files it expects to touch and writes one to five criteria, each tagged with how QA checks it: `page` (a real browser), `http`, `test` or `cmd`. If it can't tell what done looks like, it asks you one question (`kitchen status` shows it; answer with `kitchen feedback`).

When one short answer won't do (the ticket can be read more than one way, it is too big for one job, a bug has no way to see it, or its words mean something else in the code), intake sends it to be refined with you instead: `kitchen status` shows `needs-info(refine: readings)` and the dashboard shows the readings under Needs you. In Claude Code or Codex, say `/kitchen refine 004`: the session runs `kitchen refine 004` (a brief with the ticket, intake's readings, the verify map's features and your glossary and ADRs), asks you one question at a time with a recommended answer, writes the refined ticket (problem, in, out, the criteria you agreed, and slices when it is too big), and after your yes sends it back with `kitchen feedback`. Intake reads it as your own words and doesn't send it back for the same reason. Lane agents never grill: only your own session does. To check every reading before it is built, set `intake: { confirm: true }` in `kitchen.yaml`: each accepted job then waits with its criteria and what intake left out, for `kitchen approve <id>` (or Approve on the dashboard) or `kitchen feedback <id> "<what to change>"`.

## 4. Run the queue

In Claude Code: `/kitchen run` (or `/kitchen:kitchen run` from the plugin). In a terminal: `kitchen run` (add `--detach` to put it in the background; `kitchen run --print` shows the exact command). Before it starts a session it brings the repo's copy of the kitchen skill and Kitchen's `.gitignore` entries up to date, so a repo set up by an older Kitchen runs the current loop. It refuses a flag it doesn't know (nothing starts), and inside the session it started it refuses to start another. The session's raw output is `.kitchen/run.jsonl` (this session and the one before, as `run.prev.jsonl`); `.kitchen/run.log` is the readable log.

The session is the orchestrator. It loops:

1. `kitchen job next`: the next wave. Intake first (never held for room, even past `parallel`), then downstream first (review, QA, build) in the room `parallel` leaves. Jobs that touch the same files build side by side: git merges each into `staging`, and one that conflicts catches up (below). Only a job that names an unfinished one on its `AFTER:` line waits for it.
2. For each lane, `kitchen job start <id> <lane>` makes the job's worktree (`.worktrees/<id>`, branch `kitchen/<id>` from staging), writes the lane's brief and hands over your unread messages; the session starts one agent with the prompt and model it returns.
3. When the agent returns, `kitchen job finish <id>`: Kitchen reads what the lane left and moves the job, or refuses and says why.

| lane | the agent | Kitchen, at `finish` |
|---|---|---|
| intake | writes `intake.md`: decision, kind, risk, files, criteria | accepts it into Build, or asks you, or sends it to be refined with you, or rejects |
| build | changes the code in the worktree and commits | refuses uncommitted work or no commits; runs your checks itself; red checks: Build again |
| qa | reads the verify skill's Your tests, `kitchen qa up`, then each criterion against the running app (`kitchen qa page` for pages, `kitchen qa http` for APIs; `kitchen qa reset` before one that needs fresh seed data; an existing spec that checks the criterion, run against the app as evidence; never an edit to the suite) and the recipes of the features the job touches; `verdict.json` citing its evidence files; map updates in `map/` | refuses a verdict with a missing row or missing evidence (a page PASS needs a screenshot); FAIL: Build again, next round. PASS: commits the map updates into the job branch, or refuses them (the contract, a weakened check) |
| review | reads the diff (map updates included) and QA's evidence, writes `review.json` | refuses a review whose branch moved; a blocking finding: Build again; else the merge |
| regress | drives the touched features' recipes on the trial merge (`staging` with the job merged), `verdict.json` with one row per feature | refuses a missing row or evidence; FAIL: Build again with the evidence; PASS: that exact merge lands (if `staging` moved meanwhile, Kitchen merges again and the lane drives the new one) |

A lane refused three times, or a job out of rounds (`round_limit`), goes to you (`needs-human`). A catch-up (below) is not a round.

**The merge.** Review passed: under a lock, Kitchen merges the reviewed head onto `staging` as it is now in a scratch worktree, runs your checks there (the `when: merge` ones too: for a `needs_app` one, the app starts from that worktree, the check runs against it, and the app is stopped whatever happened), and moves `staging` only if they pass (on GitHub: it pushes the job branch, opens its PR into `staging` and merges it with `--match-head-commit`). A conflict, or checks red only because `staging` moved: a **catch-up**, not a round (ADR 0018). The job goes back to Build, which starts by merging `staging` as it is now into the job branch (a clean merge is committed by Kitchen; a conflicting one is left for the builder to resolve and commit, and Kitchen refuses a build whose branch doesn't contain `staging`'s tip). The builder only makes the merge work; QA re-drives what passed; review reads what changed since the last passing review (the resolution); the merge check runs as usual. Three catch-ups in a row go to you ("staging keeps moving under it"). Red checks that `staging` didn't cause are a round, and so is a red `when: merge` check always (it never ran on the branch alone); the red check's last lines (a failing spec's output) are in the next builder's brief. High risk, a change to a `high_paths` file, more than `staging.max_lines` changed lines, or `staging` checked out somewhere: the job stops at **Ready** for you, with the reason.

## The verify map

Kitchen keeps how to check your app in the repo, as a skill every agent can read: `.claude/skills/verify-<app>/` (and the same under `.agents/skills/` for Codex). `SKILL.md` says how to launch, doctor, drive and clean up the app with `kitchen qa`; `features/` is the **feature map**: `README.md` (the index, baseline preconditions, driving conventions, the sweep order) and one file per user-facing feature:

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

Every job that merged, stopped at Ready or needs you has `.kitchen/jobs/<id>/report.html`: what you must check first (why it is held, review notes, every earlier check it changed on purpose: "Changed earlier check: was …, now …"), each criterion with QA's result and its evidence (screenshots inline, transcripts quoted), the features driven before the merge, the review, the checks and the diff stat. `kitchen status` prints its path; the dashboard opens it.

Merge `staging` into your base when you are happy with it. Kitchen never does.

## Commands

```
kitchen init [--tool claude|codex] [--yes] | init --skill
kitchen ticket "<text>"
kitchen run [--detach] [--max-usd n] | run --stop | run --print
kitchen status [--json] · kitchen report [--json] · kitchen dashboard [--forget] [--private] [--port n] · kitchen skills
kitchen feedback <id> ["<text>"] [--to intake|build|qa|review|regress]
kitchen refine <id> · approve <id>
kitchen steer <id> "<text>" · pause <id> · stop <id> · resume <id> · reject <id>
kitchen job next|start|finish|show …     the orchestrator's verbs
kitchen qa up|down|reset|page|http <id> …   the QA lane's tools (<id>: a job, or a verify run)
kitchen verify sweep|maintain [--json] · verify finish <run>   the verify map's runs
```

- Run them in the repo, or inside a job's worktree (`.worktrees/<id>`, where lane agents work): there they act on the main checkout's jobs, so QA's `kitchen qa up <id>` works from its worktree. A git worktree of your own elsewhere is its own repo.
- `steer`: a message for the job's next agent; it is quoted into that lane's brief as operator notes and marked read by it.
- `pause`: the job parks when its current lane finishes. `stop`: it parks now, and the working agent's result is dropped (its `finish` is refused). `resume`: back where it paused.
- `feedback`: answers `needs-info` (back to intake, with your answer in the clarifications) or `needs-human` (back to the stage it stopped in, or `--to`); on a ready or merged job it starts a follow-up round.
- `refine`: for a job intake sent to be refined with you: writes `.kitchen/jobs/<id>/refine/brief.md` and prints its path, for a Claude Code or Codex session to follow with you (`/kitchen refine <id>`). `approve`: a job `intake.confirm` holds after intake goes to Build on its criteria.

## Dashboard

`kitchen dashboard` serves http://127.0.0.1:7357/, one page for every repo on `~/.kitchen/repos.json` (`kitchen init` and `kitchen dashboard` add the repo they run in; `--forget` removes it; a repo whose folder is gone drops off). The repo name at the top left opens a switcher (⌘1–⌘9) with each repo's "needs you" and running counts; the badge beside it counts jobs in other repos that need you, and the address carries the repo (`#<repo>`). Running `kitchen dashboard` in another repo while the page is open adds the repo and prints `already open: http://127.0.0.1:7357/#<repo>`; it never takes another port. `--private` (or `--port n`) serves one repo on its own, off the list. For each repo it shows the jobs: a List and a Board with lanes Needs you, Intake, Build, QA, Review (a job in regress shows there, as "Merge check"), Ready and Merged. A job's panel shows each stage with the lane agent's live activity (written by the activity hook), the criteria with QA's results, and the changed files. From it you answer, steer, pause, resume, stop, reject and follow up, through the same functions as the CLI. When no orchestrator is working the queue, **Start Kitchen** runs `kitchen run --detach`; an action that gives the queue work starts one too.

## A worked example

A fresh copy of `fixtures/e-library` (a small lending library API), two tickets that both touch `server.js`, and one steer:

```
kitchen ticket "Add GET /stats returning how many books and members the library has"
kitchen ticket "Add a /catalog HTML page listing every book"
kitchen steer 1 "keep the diff small"
kitchen run
```

What the orchestrator did (the free stand-in session from the proof run, which plays each lane the way the skill tells a real session to):

```
Wave 1: 001 intake, 002 intake
001 intake: the brief carries the operator's note: keep the diff small
Wave 2: 001 build; held: 002 (waits for 001 (build): both touch server.js)
001 build: guard-worktree refused a write to the main checkout
001 build: guard-protected-push refused `git push origin HEAD:main`
001 build agent: READY → built (1 commit), checks pass → qa
001 qa agent: QA FAIL → QA FAIL C1 → build (round 2)
001 build agent: READY → built (2 commits), checks pass → qa
001 qa agent: QA PASS → review
001 review agent: REVIEW PASS (1 note) → merged into staging (53408c4)
Wave 7: 002 build
002 qa agent: QA PASS (a Playwright screenshot of /catalog) → review
002 review agent: REVIEW PASS (1 note) → merged into staging (2195add)
Queue drained.
```

`git log staging` has both merges; `main` is untouched; each job has its Report. (That run predates side-by-side builds: today 001 and 002 build in the same wave, and if 002 then conflicts with 001 in `staging` it catches up on top of `staging`, without spending a round.)

## Developing Kitchen

```sh
npm install
npm test            # vitest
npm run typecheck
npm run lint        # biome
```

Run the CLI from source with `node src/cli.ts …` (Node 22.6+ runs TypeScript directly). `npm run skills:readme` regenerates the README's skills table; `npm run plugin:sync` the plugin's copy of the skill.
