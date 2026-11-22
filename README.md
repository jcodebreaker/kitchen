# Kitchen

Kitchen turns tickets into pull requests that are **proven by driving your real app**. A coding agent (Claude Code or Codex) does the judgment: reading the ticket, writing the code, judging what only a person could judge. Deterministic code does everything else: it runs every proof, decides every pass or fail it can, commits, pushes and writes the evidence. You get a pull request with a Report that shows what changed and the evidence that it works, and you merge it.

- npm package: `devkitchen`, command: `kitchen`
- Works with Claude Code or Codex, on macOS (Linux runs without the sandbox, see [Known limitations](#known-limitations-v01))
- Status: v0.1. The design (build plan, decisions, build log) lives in the source repository's `docs/` folder, not in the npm package

## Quick start (5 minutes, plus setup time)

### 0. What you need

- Node 20.11 or newer, and git. Your project must be a git repository with at least one commit.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) or Codex (`codex`) installed and logged in. Kitchen starts them as its agents and uses their login.
- Whatever your app needs to run locally (Docker, Postgres, Python…). Kitchen starts your app the way a developer would.
- For GitHub pull requests: the GitHub CLI (`gh`) logged in. Without it Kitchen works locally (branches and reports, no PRs).

### 1. Install

```sh
npm install -g devkitchen        # puts `kitchen` on your PATH
kitchen --version                # 0.1.0
```

Or run it without installing: put `npx devkitchen` wherever this page says `kitchen`.

**Optional: choose cheaper models first.** Kitchen uses three model tiers. On Claude they are `strong` = opus, `medium` = sonnet, `cheap` = haiku. To spend less, create `kitchen.yaml` in your repo before step 2 (setup keeps an existing file):

```yaml
version: 1
agent: { tool: claude, models: { strong: sonnet, medium: sonnet, cheap: haiku } }
```

(For Codex: `tool: codex`.)

### 2. Set up Kitchen in your repo

Setup writes `kitchen.yaml`, installs the `/kitchen` skill, and has an agent build a **Toolkit** for your app: the commands that start, drive and observe it (see [Concepts](#concepts)). Then Kitchen proves the Toolkit end to end. The Toolkit goes on a branch, `kitchen/setup`, for you to review. It takes 3 to 15 minutes and costs about $0.50 to $1 on Claude with sonnet.

Pick one way to run it:

**A. From Claude Code or Codex (`/kitchen`).** Install the skill, then let your agent run setup:

```sh
cd your-repo
kitchen init --skill             # writes .claude/skills/kitchen/ and .agents/skills/kitchen/
```

Start Claude Code (or Codex) in the repo and type: `/kitchen set up Kitchen`. The skill runs `kitchen init --detach`, polls `kitchen init --status --wait 90` until it ends, and asks you up to three questions about your app if it has any.

What to approve:

| tool | approve | why |
|---|---|---|
| Claude Code | the Bash command `kitchen init --detach` (once), and `kitchen run --detach` later. If you use Claude Code's sandbox mode, these two must run **with the sandbox off** | They start Kitchen in the background. Kitchen starts its own agents, Docker and network calls, which a sandboxed command can't |
| Claude Code | `kitchen init --status --wait 90`, `kitchen status`, `kitchen ticket …` | Read-only, or one file under `.kitchen/`. Safe to allow always |
| Codex | the escalation for `kitchen init --detach` and for `kitchen run --detach` ("run outside the sandbox"), once each | Same reason: inside Codex's sandbox Kitchen can't write `.git`, reach Docker or start its agents |
| Codex | nothing else | `kitchen init --status`, `kitchen status` and `kitchen ticket` run inside the sandbox |

**B. From a terminal.**

```sh
cd your-repo
kitchen init                     # or: kitchen init --tool codex
```

It prints a line per step and can be quiet for several minutes while the setup agent works; that is normal. If it has questions (at most three, often none) it asks them right there. Without a terminal (a script, CI, an agent's shell) it writes them to `.kitchen/setup-questions.json` and exits with code 3: answer them in a file `{ "answers": { "q1": "…" } }` and run `kitchen init --answers <file>`. You can also run it in the background, `kitchen init --detach`, and follow it with `kitchen init --status --wait 90` (repeat until it ends).

Either way it ends with `init: done: Toolkit proven on <sha>` and the next steps. If it ends with `not done`, the lines above it say which step failed; `kitchen init` again resumes from there. On a small app it took about 4 minutes and $0.53 (sonnet).

### 3. Review and merge the Toolkit

Run these on your default branch (`main` below; use yours). The branch `kitchen/setup` is checked out in Kitchen's own worktree (`.worktrees/_setup`), so read it with `git log`/`git diff` rather than checking it out:

```sh
git log -p main..kitchen/setup   # what the setup agent wrote: .kitchen/toolkit/
git merge kitchen/setup
git add kitchen.yaml .gitignore .claude/skills/kitchen .agents/skills/kitchen
git commit -m "Kitchen: config, skill and Toolkit"
```

Jobs use the Toolkit that is on your main branch, so this merge is what lets work start.

### 4. Give Kitchen a ticket

```sh
kitchen ticket "On the tasks list, show how many tasks are open at the top"
```

Or tell `/kitchen` what you want in Claude Code or Codex. With GitHub, label an issue `kitchen` instead (see [Configuration](#configuration)).

### 5. Run it

```sh
kitchen run --detach             # works the queue in the background; log in .kitchen/run.log
kitchen status                   # one row per job: stage, round, PR, report
kitchen dashboard                # the board in your browser: http://127.0.0.1:7357
```

For the first second after `run --detach`, `kitchen status` may still say `runner: not running`; run it again. `status` doesn't wait: run it whenever you want to look (or keep the dashboard open, it refreshes itself). Without GitHub every job shows `no PR`; that is normal.

A ticket goes through intake (is it clear, how risky), spec (acceptance criteria, each with a proof), build, gate (your checks), verify (Kitchen drives the app and runs every proof), review, and report. A small ticket takes a few minutes and costs cents to a few tens of cents.

If a job needs you, `kitchen status` says `needs-info` or `needs-human` with the reason. Answer with `kitchen feedback <id> "<your answer>"`, or drop it with `kitchen reject <id>`.

### 6. Read the Report and merge

When the job is `done`, `kitchen status` prints the path of its Report (`.kitchen/jobs/<id>/report.html`; the dashboard links it). It opens with what a person must check, then each requirement, the criteria that prove it, who decided each verdict, and the evidence (screenshots, command output), then the review findings and the cost.

- Local (no GitHub): the work is on the branch `kitchen/<id>`, where `<id>` is the full job id from `kitchen status` (for example `kitchen/001-add-a-version-flag`). Review it and merge it: `git merge kitchen/001-add-a-version-flag`. The Report and its evidence are also committed, one folder per job, on a local branch `kitchen-evidence` (you never merge that one).
- GitHub: the pull request is marked ready for review, with a comment listing each criterion's verdict and a link to the Report on the `kitchen-evidence` branch. Merge it on GitHub as usual. Kitchen never merges.

A review comment on the PR from a trusted person sends the job back to build with your comment.

Cleaning up: Kitchen removes nothing you might still want. After merging, you may delete the job branch (`git branch -d kitchen/<id>`) and `kitchen/setup`; `.worktrees/` holds Kitchen's working copies (ignored by git) and can be removed when no `kitchen run` is going (`git worktree prune` afterwards). Keep `kitchen-evidence`: it is where the Reports live.

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

## Learning: report, dashboard, retro

- `kitchen report` prints the measures Kitchen keeps from its first run: merge-ready rate over tickets taken in, first-pass verdict rate, rounds per job, escalation reasons, Toolkit gaps per job, INCONCLUSIVE and flake rate per drive, time (agent time and wall clock) and cost per job and per risk path, findings dismissed per review lens, primitive PRs per job. `--json` for the numbers.
- `kitchen dashboard` serves the board (stage columns, each job's full id, risk, round, when it last moved and what it last did, verdict chips, cost, time, Report link) on 127.0.0.1 only, read-only. Light and dark.
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
| `models` | intake, spec, builder, smith, setup: `strong`; verifier, reviewer, report, maintain: `medium`; retro: `cheap` | the tier (or a literal model name) per role |
| `concurrency` | `2` | jobs at once |
| `round_limit` | `3` | rounds before a human is asked |
| `checks` | `[]` | commands Gate runs in the job's worktree: strings, or `{ name, run, timeout_sec }` |
| `checks_network` | `false` | let checks reach the network (a package install) |
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
- **Docker bind mounts are not policed.** A Toolkit can start a container that mounts your home folder; the macOS sandbox doesn't see inside Docker. Planned: refuse bind mounts outside the repo.
- **Codex parity is owed.** Every part of Kitchen was built and proven on Claude Code first. Codex runs the same roles and passed setup on three of four fixtures, but its full proof runs (end to end, review, the benchmark subset) are still to do.
- One machine, one repo per `kitchen run`. No hosted runner, no GitLab or Linear, no Windows, no mobile apps.
- The real-GitHub path (PRs, evidence branch, issue tickets) is built and tested against a `gh` stand-in; its first run on a real repository is still owed.

## Credits

- The Toolkit's shape (launch, doctor, drive, evidence, cleanup, the feature map), the setup role (`roles/setup.md`) and the maintain role (`roles/maintainer.md`) are ported from pstack's `create-verification-skill` and `maintain-verification-skill`, MIT License, Copyright (c) 2026 Lauren Tan.
- Some ideas (a factory of agent stages with a ledger) come from zazencodes' software factory, which is GPL-licensed. **Ideas only: no code from it is in Kitchen.**

## License

MIT. See `LICENSE`; third-party notices are in `NOTICE`.
