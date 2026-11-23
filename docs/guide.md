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
  ✓ Installed guard hooks  8 added to .claude/settings.json · secrets, key literals, protected push, deletes, worktree
  ✓ Updated .gitignore     10 Kitchen entries
  ✓ Staging branch         created staging from main (18a0d5a)
  ✓ Ran the checks         test passed on main                               0.3s
Done in 0.7s · no agent
```

- **The preflight.** A ✗ comes with the exact command that fixes it on your OS; a required ✗ stops init (exit 2) before anything is written. Kitchen installs nothing and signs no one in.
- **kitchen.yaml.** The checks (from `package.json`, `Makefile`, `pyproject.toml`, `go.mod`, `Cargo.toml`) and how QA starts your app (`app:`: from `package.json` scripts, Django's `manage.py`, a `Makefile`). When nothing obvious starts the app, init asks you one question in a terminal; `--yes` asks nothing. The app gets a free port in `$PORT`, so two jobs can run theirs at once.
- **The guard hooks** are copied to `.claude/hooks/kitchen/` and merged into `.claude/settings.json`: what was there stays, the old file is backed up beside it, nothing is added twice. See [safety.md](safety.md).
- **staging** is created from the branch you are on (on GitHub too, when `origin` is there and `gh` is signed in).
- **The checks run once** on your checkout. If they fail, every job's would too: fix them first.

Commit `kitchen.yaml`, `.gitignore`, `.claude/settings.json`, `.claude/hooks/kitchen/` and the skill folders when you like.

A repo set up by an older Kitchen keeps working: `kitchen.yaml` keys that no longer exist are ignored (init names them), old job folders read with their stages folded in, and an old `.kitchen/toolkit` is used to start the app when `app.start` is empty.

## 3. Give Kitchen a ticket

```sh
kitchen ticket "Add GET /stats returning how many books and members the library has"
# ticket 001-add-get-stats-returning-how-many-books-a  "Add GET /stats returning how many books and members the…"  → intake
```

Plain words are enough. The intake lane rates it (kind, risk), lists the files it expects to touch and writes one to five criteria, each tagged with how QA checks it: `page` (a real browser), `http`, `test` or `cmd`. If it can't tell what done looks like, it asks you one question (`kitchen status` shows it; answer with `kitchen feedback`).

## 4. Run the queue

In Claude Code: `/kitchen run` (or `/kitchen:kitchen run` from the plugin). In a terminal: `kitchen run` (add `--detach` to put it in the background; `kitchen run --print` shows the exact command).

The session is the orchestrator. It loops:

1. `kitchen job next`: the next wave. Downstream first (review, QA, build, intake), at most `parallel` lanes at once. Jobs that touch the same files build side by side: git merges each into `staging`, and one that conflicts goes back to Build. Only a job that names an unfinished one on its `AFTER:` line waits for it.
2. For each lane, `kitchen job start <id> <lane>` makes the job's worktree (`.worktrees/<id>`, branch `kitchen/<id>` from staging), writes the lane's brief and hands over your unread messages; the session starts one agent with the prompt and model it returns.
3. When the agent returns, `kitchen job finish <id>`: Kitchen reads what the lane left and moves the job, or refuses and says why.

| lane | the agent | Kitchen, at `finish` |
|---|---|---|
| intake | writes `intake.md`: decision, kind, risk, files, criteria | accepts it into Build, or asks you, or rejects |
| build | changes the code in the worktree and commits | refuses uncommitted work or no commits; runs your checks itself; red checks: Build again |
| qa | `kitchen qa up`, then each criterion against the running app (`kitchen qa page` for pages, `kitchen qa http` for APIs), `verdict.json` citing its evidence files | refuses a verdict with a missing row or missing evidence (a page PASS needs a screenshot); FAIL: Build again, next round |
| review | reads the diff and QA's evidence, writes `review.json` | refuses a review whose branch moved; a blocking finding: Build again; else the merge |

A lane refused three times, or a job out of rounds (`round_limit`), goes to you (`needs-human`).

**The merge.** Review passed: under a lock, Kitchen merges the reviewed head onto `staging` as it is now in a scratch worktree, runs your checks there, and moves `staging` only if they pass (on GitHub: it pushes the job branch, opens its PR into `staging` and merges it with `--match-head-commit`). A conflict or red checks: Build again, and that round starts by merging `staging` as it is now into the job branch (a clean merge is committed by Kitchen; a conflicting one is left for the builder to resolve and commit, and Kitchen refuses a build whose branch doesn't contain `staging`'s tip). High risk, a change to a `high_paths` file, more than `staging.max_lines` changed lines, or `staging` checked out somewhere: the job stops at **Ready** for you, with the reason.

## 5. Read the Report

Every job that merged, stopped at Ready or needs you has `.kitchen/jobs/<id>/report.html`: what you must check first (why it is held, review notes), each criterion with QA's result and its evidence (screenshots inline, transcripts quoted), the review, the checks and the diff stat. `kitchen status` prints its path; the dashboard opens it.

Merge `staging` into your base when you are happy with it. Kitchen never does.

## Commands

```
kitchen init [--tool claude|codex] [--yes] | init --skill
kitchen ticket "<text>"
kitchen run [--detach] [--max-usd n] | run --stop | run --print
kitchen status [--json] · kitchen report [--json] · kitchen dashboard [--port 7357] · kitchen skills
kitchen feedback <id> ["<text>"] [--to intake|build|qa|review]
kitchen steer <id> "<text>" · pause <id> · stop <id> · resume <id> · reject <id>
kitchen job next|start|finish|show …     the orchestrator's verbs
kitchen qa up|down|page|http <id> …      the QA lane's tools
```

- `steer`: a message for the job's next agent; it is quoted into that lane's brief as operator notes and marked read by it.
- `pause`: the job parks when its current lane finishes. `stop`: it parks now, and the working agent's result is dropped (its `finish` is refused). `resume`: back where it paused.
- `feedback`: answers `needs-info` (back to intake, with your answer in the clarifications) or `needs-human` (back to the stage it stopped in, or `--to`); on a ready or merged job it starts a follow-up round.

## Dashboard

`kitchen dashboard` serves the jobs on 127.0.0.1: a List and a Board with lanes Needs you, Intake, Build, QA, Review, Ready and Merged. A job's panel shows each stage with the lane agent's live activity (written by the activity hook), the criteria with QA's results, and the changed files. From it you answer, steer, pause, resume, stop, reject and follow up, through the same functions as the CLI. When no orchestrator is working the queue, **Start Kitchen** runs `kitchen run --detach`; an action that gives the queue work starts one too.

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

`git log staging` has both merges; `main` is untouched; each job has its Report. (That run predates side-by-side builds: today 001 and 002 build in the same wave, and if 002 then conflicts with 001 in `staging` it goes back to Build on top of `staging`.)

## Developing Kitchen

```sh
npm install
npm test            # vitest
npm run typecheck
npm run lint        # biome
```

Run the CLI from source with `node src/cli.ts …` (Node 22.6+ runs TypeScript directly). `npm run skills:readme` regenerates the README's skills table; `npm run plugin:sync` the plugin's copy of the skill.
