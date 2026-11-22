# Kitchen

Kitchen turns tickets into pull requests that are **proven by driving your real app**. A coding agent (Claude Code or Codex) does the judgment: reading the ticket, writing the code, judging what only a person could judge. Deterministic code does everything else: it runs every proof, decides every pass or fail it can, commits, pushes and writes the evidence. You get a pull request with a Report that shows what changed and the evidence that it works, and you merge it.

- npm package: `devkitchen`, command: `kitchen`
- Works with Claude Code or Codex, on macOS (Linux runs without the sandbox, see [Known limitations](#known-limitations-v01))
- Status: v0.1. The design (build plan, decisions, build log) lives in the source repository's `docs/` folder, not in the npm package

## Quick start (5 minutes)

### 0. What you need

- Node 20.11 or newer, and git. Your project must be a git repository with at least one commit.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) or Codex (`codex`) installed and logged in. Kitchen starts them as its agents and uses their login.
- For GitHub pull requests: the GitHub CLI (`gh`) logged in. Without it Kitchen works locally (branches and reports, no PRs).
- Later, for step 6: whatever your app needs to run locally (Docker, Postgres, Python…). Kitchen starts your app the way a developer would.

### 1. Install

```sh
npm install -g devkitchen        # puts `kitchen` on your PATH
kitchen --version                # 0.1.0
```

Or run it without installing: put `npx devkitchen` wherever this page says `kitchen`.

**Optional: choose cheaper models first.** Kitchen uses three model tiers. On Claude they are `strong` = opus, `medium` = sonnet, `cheap` = haiku. To spend less, create `kitchen.yaml` in your repo before step 2 (`kitchen init` keeps an existing file):

```yaml
version: 1
agent: { tool: claude, models: { strong: sonnet, medium: sonnet, cheap: haiku } }
```

(For Codex: `tool: codex`.)

### 2. Set up Kitchen in your repo

```sh
cd your-repo
kitchen init                     # or: kitchen init --tool codex
```

It takes seconds, like `git init`:

```
Setting up Kitchen in your-repo…
  ✓ Wrote kitchen.yaml     agent claude · 2 checks from package.json
  ✓ Installed the skill    /kitchen for Claude Code (.claude/skills) and Codex (.agents/skills)
  ✓ Updated .gitignore     18 Kitchen entries
  ✓ Ran the checks         lint, test passed on main (4b67d97)              3.1s
Done in 3.2s · no agent
```

It writes `kitchen.yaml` with your project's **checks** (what Gate runs on every job), found in `package.json` scripts (lint, typecheck, test, build; the package manager from the lockfile), `Makefile` targets (a Makefile with `test` or `check` wins), `pyproject.toml` (pytest, ruff, mypy when they have their own `[tool.…]` section; a repo `.venv` is used), `go.mod` or `Cargo.toml`. A script that changes files or never ends (`--fix`, `--write`, watch, docker, serve) is never taken. It installs the `/kitchen` skill, adds Kitchen's entries to `.gitignore`, and runs the checks once.

**What it runs, and how.** The checks run once on your own checkout (your HEAD, plus whatever you have changed) under the same sandbox Gate uses: no network, your home folder unreadable, writes only inside the repo, `CI=1`. Each prints `Running <name>…` first; Ctrl-C stops it and everything it started. When dependencies aren't installed it installs them only with a frozen install from your lockfile, announced first. It writes that as `checks_install: npm` (or pnpm, yarn, bun), which jobs use too, in two steps: the download, the only step with the network, runs no package scripts (`npm ci --ignore-scripts`, `pnpm install --frozen-lockfile --ignore-scripts`, `yarn install --immutable --mode=skip-build`, `bun install --frozen-lockfile --ignore-scripts`); then the packages' install scripts run in a rebuild (`npm rebuild`, `pnpm rebuild`, `yarn rebuild`; Bun runs none), offline unless you set `checks_network: true`. So a `postinstall` a builder adds, or a git dependency's, never runs with the network. With no lockfile it installs nothing and skips the checks; commit one and run `kitchen init` again to add the install. If they fail it says so plainly and exits 1: Gate would fail every job until they pass, so fix them (or edit `checks:`) first.

**When nothing obvious is there**, it asks an agent once, briefly, on the cheap model, to read the repo and propose checks. Those are never run without you: in a terminal it shows them and asks `Use these checks? [y/N]` (Enter is no); without one (a script, an agent's shell) it writes them into `kitchen.yaml` commented out, for you to review and uncomment. It doesn't ask the agent again on the next `kitchen init` (unless the call failed). Scripts it leaves out as unsafe are named (`skipped lint (\`eslint . --fix\` changes files)`).

Commit `kitchen.yaml`, `.gitignore`, `.claude/skills/kitchen/` and `.agents/skills/kitchen/` when you like.

From Claude Code or Codex instead: `kitchen init --skill`, then type `/kitchen set up Kitchen`.

### 3. Give Kitchen a ticket

```sh
kitchen ticket "On the tasks list, show how many tasks are open at the top"
```

Or tell `/kitchen` what you want in Claude Code or Codex. With GitHub, label an issue `kitchen` instead (see [Configuration](#configuration)).

### 4. Run it

```sh
kitchen run --detach             # works the queue in the background; log in .kitchen/run.log
kitchen status                   # one row per job: stage, round, PR, report
kitchen dashboard                # every job in your browser: http://127.0.0.1:7357
```

For the first second after `run --detach`, `kitchen status` may still say `runner: not running`; run it again. `status` doesn't wait: run it whenever you want to look (or keep the dashboard open, it refreshes itself). Without GitHub every job shows `no PR`; that is normal.

A ticket goes through intake (is it clear, how risky), spec (acceptance criteria, each with a proof), build, gate (your checks), verify (Kitchen runs every proof), review, and report. A small ticket takes a few minutes and costs cents to a few tens of cents.

Until Kitchen can drive your app (step 6), a job is proven by your checks and by tests (`test <file>` and `cmd` proofs), and its Report says so. A ticket whose criteria need the running app pauses with `paused(no-toolkit)`: build the Toolkit (step 6) and it goes on, or `kitchen resume <id>` to go on without it, with those criteria marked "not proven (no Toolkit)". A high-risk ticket (auth, payments, migrations) waits for the Toolkit.

If a job needs you, `kitchen status` says `needs-info` or `needs-human` with the reason. Answer with `kitchen feedback <id> "<your answer>"`, or drop it with `kitchen reject <id>`. You can also talk to a job while it runs (`kitchen steer <id> "keep the diff small"`), or park it (`kitchen pause`, `kitchen stop`, `kitchen resume`): see [Commands](#commands). The dashboard does all of this from the browser.

### 5. Read the Report and merge

When the job is `done`, `kitchen status` prints the path of its Report (`.kitchen/jobs/<id>/report.html`; the dashboard links it). It opens with what a person must check, then each requirement, the criteria that prove it, who decided each verdict, and the evidence (screenshots, command output), then the review findings and the cost.

- Local (no GitHub): the work is on the branch `kitchen/<id>`, where `<id>` is the full job id from `kitchen status` (for example `kitchen/001-add-a-version-flag`). Review it and merge it: `git merge kitchen/001-add-a-version-flag`. The Report and its evidence are also committed, one folder per job, on a local branch `kitchen-evidence` (you never merge that one).
- GitHub: the pull request is marked ready for review, with a comment listing each criterion's verdict and a link to the Report on the `kitchen-evidence` branch. Merge it on GitHub as usual. Kitchen never merges.

A review comment on the PR from a trusted person sends the job back to build with your comment.

Cleaning up: Kitchen removes nothing you might still want. After merging, you may delete the job branch (`git branch -d kitchen/<id>`) and `kitchen/setup`; `.worktrees/` holds Kitchen's working copies (ignored by git) and can be removed when no `kitchen run` is going (`git worktree prune` afterwards). Keep `kitchen-evidence`: it is where the Reports live.

### 6. Make Kitchen drive your app: `kitchen toolkit build`

Kitchen's point is proof in your real, running app. For that it needs a **Toolkit**: the commands that start, drive and observe your app (see [Concepts](#concepts)). An agent writes it once, and Kitchen proves it end to end. It takes 3 to 15 minutes and costs about $0.50 to $1 on Claude with sonnet.

```sh
kitchen toolkit build            # or: kitchen init --toolkit, to do steps 2 and 6 in one go
```

It prints one line per phase:

```
Teaching Kitchen to run your-repo…
  ✓ Read the repo          api · no questions                                31s · $0.12
  ✓ Wrote the Toolkit      api · features: books, loans                      2m 50s · $0.71
  ✓ Proved it              4 drives × 2 (after a reset) · 2 copies at once   25s
Done in 3m 46s · $0.83 · on branch kitchen/setup
Next: review it (git log -p main..kitchen/setup), then git merge kitchen/setup
```

Every detail (each drive, the evidence, the sandbox notes) goes to `.kitchen/init/init.log`; `--verbose` shows it on the terminal too. A failure prints the failing step in full, and `kitchen toolkit build` again resumes from there.

If it has questions (at most three, often none) it asks them right there. Without a terminal (a script, CI, an agent's shell) it writes them to `.kitchen/setup-questions.json` and exits with code 3: answer them in a file `{ "answers": { "q1": "…" } }` and run `kitchen toolkit build --answers <file>`. You can also run it in the background, `kitchen toolkit build --detach`, and follow it with `kitchen toolkit build --status --wait 90` (repeat until it ends). From Claude Code or Codex, `/kitchen` does all of this; approve these once:

| tool | approve | why |
|---|---|---|
| Claude Code | the Bash command `kitchen toolkit build --detach` (once), and `kitchen run --detach`. If you use Claude Code's sandbox mode, these two must run **with the sandbox off** | They start Kitchen in the background. Kitchen starts its own agents, Docker and network calls, which a sandboxed command can't |
| Claude Code | `kitchen init`, `kitchen toolkit build --status --wait 90`, `kitchen status`, `kitchen ticket …` | Quick, read-only, or files under the repo. Safe to allow always |
| Codex | the escalation for `kitchen toolkit build --detach` and for `kitchen run --detach` ("run outside the sandbox"), once each | Same reason: inside Codex's sandbox Kitchen can't write `.git`, reach Docker or start its agents |
| Codex | nothing else | `kitchen init`, `kitchen toolkit build --status`, `kitchen status` and `kitchen ticket` run inside the sandbox |

Then review and merge the Toolkit. Run these on your default branch (`main` below; use yours). The branch `kitchen/setup` is checked out in Kitchen's own worktree (`.worktrees/_setup`), so read it with `git log`/`git diff` rather than checking it out:

```sh
git log -p main..kitchen/setup   # what the setup agent wrote: .kitchen/toolkit/
git merge kitchen/setup
```

Jobs use the Toolkit that is on your main branch, so this merge is what lets them drive the app. A job paused `no-toolkit` goes on by itself at the next `kitchen run` (or `kitchen resume <id>`).

## Concepts

| | |
|---|---|
| **Ticket** | One request for work: a prompt (`kitchen ticket`) or a GitHub issue with the `kitchen` label. |
| **Job** | One run of Kitchen on one Ticket, from intake to a ready pull request. Named like `003-show-open-count`. Lives in `.kitchen/jobs/<id>/`. |
| **Toolkit** | Your project's kit for starting, driving and observing your app: `.kitchen/toolkit/bin/dev` (start, reset, sign in, press, read, screenshot, http…) plus one file per feature describing how to reach it. It is the only way Kitchen touches your app. New commands come as their own Toolkit PR, proven on main. |
| **Verdict** | The outcome of driving the app against one acceptance criterion: PASS, FAIL, TOOLKIT-GAP (the Toolkit can't do something yet) or INCONCLUSIVE (counts as FAIL; retried once). Kitchen decides every mechanical one itself; an agent only judges what needs eyes (a layout, wording), and must cite evidence. |
| **Evidence** | What the proofs produced: screenshots, command output, each stamped with the commit it ran on, in a hash-chained, signed manifest. An agent can't forge or reuse it. |
| **Report** | One self-contained HTML page per job: what changed, why it is right, what you still have to check, and the Evidence. |

Risk decides how heavy the path is: low-risk tickets get inline criteria and a light review, high-risk ones (auth, payments, migrations) get a full spec, a security review, and are always marked for a human.

## Commands

| command | what it does |
|---|---|
| `kitchen ticket "<what you want>"` | files a ticket; `kitchen run` takes it in |
| `kitchen run [--detach] [--once] [<job>]` | works the queue (`--detach`: in the background, log in `.kitchen/run.log`) |
| `kitchen status [--json]` | one row per job |
| `kitchen dashboard [--port 7357]` | the jobs in your browser (see [Dashboard](#dashboard)) |
| `kitchen feedback <id> ["<text>"] [--to <stage>]` | answers a job that needs you; on a done job, a follow-up: another Build round |
| `kitchen steer <id> "<text>"` | a message for a running job: add context, redirect it, ask what it is doing. A Claude agent reads it after the tool call it is in, without stopping. Codex, a step with no agent (Gate, Verify's engine part, Ready) and a paused job get it at the start of the next agent role, quoted as operator notes |
| `kitchen pause <id>` | lets the current step finish, then parks the job (`paused(by-you)`) |
| `kitchen stop <id>` | kills the job's agent (and the checks it started) now, then parks it; resume runs that stage again |
| `kitchen resume <id>` | wakes a paused job where it stopped; it reads the messages sent while it was paused. A job you paused keeps no `kitchen run` waiting for it (like one that needs you), so start `kitchen run --detach` again if it has ended: `kitchen status` and the dashboard say when it isn't running |
| `kitchen reject <id>` | closes a job without a PR |
| `kitchen dismiss <job> [<finding>] [--reason "…"]` | lists a job's review findings, or says one was not useful |
| `kitchen report [--json]` | the measures from the ledger |
| `kitchen init …`, `kitchen toolkit …`, `kitchen migrate`, `kitchen retro …` | setup and maintenance: `kitchen --help` |

A job's steering thread is `.kitchen/jobs/<id>/messages.jsonl`: each message with who sent it, when, and its status (`sent`, then `read` by a role, `mid-run` or `next-role`). Only Kitchen writes it. Message text has the trust of `kitchen feedback`: it is your request about the work, quoted to agents, never an instruction to Kitchen itself; it is capped at 4,000 characters.

## Dashboard

`kitchen dashboard` serves every job on http://127.0.0.1:7357 (this machine only), and refreshes itself while jobs run:

- **List** (the default) groups the jobs into Needs you, Running and Done; **Board** puts the running ones in stage columns. The page remembers which you chose.
- Each running job shows a live line (the call its agent is making right now, with a shimmer while it runs), the time in its current stage (frozen while paused; a job that needs you shows how long it has waited; the job's total age is in its panel), its changed files and a six-step stage track: Intake, Build, Gate, Verify, Review, Report.
- Click a job for its panel: the stage track, then **Activity** (every stage with what its agents did: their reasoning lines, each tool call with its time, file edits with +/− counts, your messages and whether they were read), **Checks** (each criterion and its last verdict) and **Changes** (files and line counts from the base). The Report link is there once it exists.
- **One composer per job**, in its panel or under its row: answer a job that needs you, steer a running one, leave a note on a paused one, follow up on a done one (another Build round). Pause, Resume, Stop and Reject sit beside it. **New ticket** files a ticket.
- **Setup** shows `kitchen toolkit build`'s steps (after a quick `kitchen init` only: "Toolkit not built"); its questions can be answered right there (the same as `kitchen toolkit build --answers <file> --detach`). A job paused `no-toolkit` shows as needing you, with its reason, a copy of `kitchen toolkit build` and Resume.
- Keys: `J`/`K` move, `Enter` opens, `R` messages the selected job, `Esc` closes, `⌘K` (or Ctrl-K) opens the command palette. Light and dark follow your system; the Theme button switches. It works down to a phone's width.

Every button is a CLI verb: the page sends `POST /api/<verb>` and the server calls the same engine function as the command, so the browser can do nothing `kitchen` can't. Jobs move only while `kitchen run` works the queue; the page says so when it isn't running.

Safety: the server listens on 127.0.0.1 and refuses any other `Host` (DNS rebinding). It makes a random 32-byte token when it starts and puts it in the page it serves; every POST must carry it in an `x-kitchen-token` header, as `application/json`, and from the page's own origin. A cross-site page can send neither that header nor that content type, and can't read the token. The page loads nothing from elsewhere (its fonts, Geist and Geist Mono under the SIL Open Font License, are served by Kitchen) under a strict Content-Security-Policy. Another program running as you could read the token from the page, but it could run `kitchen` itself anyway.

## Learning: report, dashboard, retro

- `kitchen report` prints the measures Kitchen keeps from its first run: merge-ready rate over tickets taken in, first-pass verdict rate, rounds per job, escalation reasons, Toolkit gaps per job, INCONCLUSIVE and flake rate per drive, time (agent time and wall clock) and cost per job and per risk path, findings dismissed per review lens, primitive PRs per job. `--json` for the numbers.
- `kitchen dashboard` serves the jobs in your browser; see [Dashboard](#dashboard).
- **Retro.** Every 5 finished jobs (`retro.every_jobs`), Kitchen looks back. A review finding you dismiss (`kitchen dismiss <job> <finding> --reason "…"`, or a "not useful" reply naming the finding on the PR, in the same sentence) counts against its lens and its category (each finding has one: security, correctness, performance, naming, style, types, tests, docs, ux, ui); after 3 (`retro.mute_after`) that category stops blocking for that lens (it is still shown as a note). Security findings are never muted, in any lens: neither one in the `security` category nor one that mentions auth, a token, a session, permissions, ownership, injection, SQL, XSS, CSRF, a leak, a secret, a password, a credential or access. A security finding is dismissed only with a reason ("security-1-2 is not useful because …", or `--reason`). The rest of a PR comment that dismisses something is still feedback; a comment that only dismisses is not. PR replies are read for jobs done in the last 30 days (`retro.lookback_days`). `kitchen retro status` lists mutes; `kitchen retro unmute <lens>/<category>` lifts one. The retro also proposes up to 3 lesson tickets (a lint rule, a check, a Toolkit fix, or an AGENTS.md note) as **drafts**: Kitchen never works on its own proposal until you approve it (`kitchen retro approve <n>`, or on GitHub, add the `kitchen` label to the issue). It never edits Kitchen's own prompts.

## Configuration

`kitchen.yaml` in your repo. Every key has a default; an unknown key is refused. The ones you are most likely to change:

```yaml
version: 1
agent: { tool: claude }                 # or codex; models: { strong, medium, cheap }
concurrency: 2                          # jobs at once (each gets its own app instance)
round_limit: 3                          # build/verify/review rounds before a human is asked
checks: ["npm run lint", "npm test"]    # what Gate runs on every build
test_cmd: "npm test -- {file}"          # how a `test <file>` proof runs
forge: { kind: github, repo: you/your-repo }   # PRs on GitHub (default: local, no PRs)
source: { kind: github, label: kitchen }       # take labelled issues as tickets (default: prompt)
retro: { every_jobs: 5, mute_after: 3, max_tickets: 3 }
```

Every key, with its default:

| key | default | what |
|---|---|---|
| `version` | `1` | schema version (`kitchen migrate` raises it) |
| `agent` | `{ tool: claude, timeout_sec: 1800, max_turns: 80 }` | `tool` claude or codex; `models: { strong, medium, cheap }` maps tiers to model names; `command: [argv]` to start the tool another way |
| `models` | intake, spec, builder, smith: `strong`; setup (`kitchen toolkit build`), verifier, reviewer, report, maintain: `medium`; retro: `cheap` | the tier (or a literal model name) per role |
| `concurrency` | `2` | jobs at once |
| `round_limit` | `3` | rounds before a human is asked |
| `checks` | `[]` (`kitchen init` fills them in) | commands Gate runs in the job's worktree: strings, or `{ name, run, timeout_sec }` |
| `checks_network` | `false` | let the checks, `checks_prepare` and the install's scripts reach the network (the `checks_install` download always has it) |
| `checks_install` | none (`kitchen init` sets it from your lockfile) | `npm`, `pnpm`, `yarn` or `bun`: a frozen install before the checks and `test` proofs. The download has the network and runs no package scripts; the scripts run after in a rebuild, offline unless `checks_network` |
| `checks_prepare` | none | your own command that readies a job worktree, after `checks_install`, in the same sandbox; it has the network only with `checks_network: true`. Runs once per worktree, again when a lockfile changes |
| `test_cmd` | `npm test -- {file}` | how a `test <file>` proof runs |
| `paths` | low / medium / high | per risk: `spec` (inline, full), `verify` (short, full, related-features), `review` lenses, `human: always` |
| `surfaces` | `{ ui: [ux, ui], security: [security] }` | extra review lenses when a ticket touches a surface |
| `high_paths` | migrations, auth, payment, infra, .github | files that make a diff high risk |
| `seed_paths` | migrations, seeds, fixtures, `db/**`, `*.sql`… | seed or schema files: a diff touching them is high risk |
| `risk_floor` | `{ diff_lines_medium: 300, diff_lines_high: 1000 }` | diff size that raises risk |
| `automerge` | `off` | reserved: v0.1 never merges, whatever this says |
| `protected` | `[kitchen.yaml]` | files no builder may change |
| `retro` | `{ every_jobs: 5, mute_after: 3, max_tickets: 3, never_mute: [security], lookback_days: 30 }` | see Retro above; `never_mute` names lenses or categories |
| `backoff` | `{ base_sec: 60, max_sec: 3600 }` | waits after a rate limit |
| `evidence_keep_days` | `30` | Reports older than this are pruned from `kitchen-evidence` |
| `maintain_churn_lines` | `300` | changed lines in feature code that start `kitchen toolkit maintain` |
| `feedback` | `{ trusted: [], trust_associations: [OWNER, MEMBER, COLLABORATOR] }` | whose PR comments count |
| `forge` | `{ kind: local, base: main }` | `github` with `repo: owner/name` (and optional `url`) for PRs |
| `source` | `{ kind: prompt, label: kitchen, operators: [] }` | `github`: labelled issues are tickets |

`kitchen migrate --dry-run` shows what an upgrade of Kitchen would change in `kitchen.yaml` and in the Toolkit's template files, and exits 1 when there is something to change (0 when there is nothing), so CI can check it; `kitchen migrate` writes it (you commit it).

## Safety model

- **Agents hold no push rights and no GitHub token.** Kitchen runs them with a scrubbed environment: no `GH_TOKEN`, an empty gh config, git credential helpers off, push URLs rewritten to nothing. Kitchen itself commits, pushes and opens PRs, with your credentials, through one git helper that never trusts a worktree's own git config or hooks.
- **Agents can't write job state or evidence.** Each agent writes one file in its worktree; Kitchen copies it. The evidence manifest is hash-chained and signed with a key in `~/.kitchen` that agents can't read; an edited, dropped or rolled-back entry is refused.
- **Your app and your tests run with a scrubbed environment too**: no agent login, no git or GitHub credentials, plus only the fake values in `.env.kitchen` (made at setup; never your real `.env`). `cmd` and `test` proofs also run in a macOS sandbox: no network but localhost, your home folder unreadable except the worktree and toolchains.
- **Ticket text is data.** It is quoted to agents, never followed as instructions to Kitchen. On GitHub only a labelled issue becomes work, and only the issue's author (or listed operators) can answer its questions.
- **A human merges.** Kitchen never merges a pull request. High-risk paths are labelled `kitchen:review-required` and the Report opens with what a person must check.
- **Screenshots can't be scanned for secrets**, so a Toolkit seeds only fake data. Text evidence is redacted before it is stored.

## Known limitations (v0.1)

- **Linux runs unsandboxed.** On macOS, Toolkit code the setup agent just wrote (and any Toolkit not yet merged) and every `cmd`/`test` proof run under `sandbox-exec`, away from your SSH keys, cloud and GitHub credentials, agent logins and Kitchen's key. Linux has no sandbox yet: those run as you, and Kitchen logs `UNSANDBOXED` when they start. Review `kitchen/setup` before you merge it either way. Details: `docs/adr/0008-setup-bridge.md` in the source repository.
- **Your app and a merged Toolkit run unsandboxed.** They get no credentials through the environment, but they run as you, like `npm run dev` would. App code from a job branch is code an agent wrote; it is reviewed only after it ran.
- **Docker is guarded only for an unmerged Toolkit, on macOS.** Toolkit code not yet merged talks to Docker through Kitchen's guard: no bind mounts outside the repo and temp, no privileged or host-namespace containers, and no requests on containers it didn't create (another project's database can't be exec'd into or stopped). A merged Toolkit, and Linux, talk to Docker directly.
- **Ports are shared per machine.** Every Kitchen on the machine (each with its own `KITCHEN_HOME`) hands out slots from one registry, `~/.kitchen-slots/slots.json`, and skips ports something else listens on or a container publishes.
- **Codex parity is owed.** Every part of Kitchen was built and proven on Claude Code first. Codex runs the same roles and passed setup on three of four fixtures, but its full proof runs (end to end, review, the benchmark subset) are still to do.
- One machine, one repo per `kitchen run`. No hosted runner, no GitLab or Linear, no Windows, no mobile apps.
- The real-GitHub path (PRs, evidence branch, issue tickets) is built and tested against a `gh` stand-in; its first run on a real repository is still owed.

## Developing Kitchen

`npm test`, `npm run typecheck` and `npm run lint` (Biome). The scripts under `spikes/` prove whole paths against copies of the fixtures; each one's README says what it needs. On macOS with Docker Desktop, give a Docker-using spike a scratch folder under `$HOME` (the default `spikes/<wave>/.work/` is), not `/tmp` or `/private/tmp`: Docker Desktop shares only some host folders with its VM, and a bind mount from elsewhere can fail or come up empty in the container.

## Credits

- The Toolkit's shape (launch, doctor, drive, evidence, cleanup, the feature map), the setup role (`roles/setup.md`) and the maintain role (`roles/maintainer.md`) are ported from pstack's `create-verification-skill` and `maintain-verification-skill`, MIT License, Copyright (c) 2026 Lauren Tan.
- Some ideas (a factory of agent stages with a ledger) come from zazencodes' software factory, which is GPL-licensed. **Ideas only: no code from it is in Kitchen.**

## License

Apache-2.0. See `LICENSE`; third-party notices are in `NOTICE`.
