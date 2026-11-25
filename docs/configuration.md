# Configuration

`kitchen.yaml` in your repo. Every key has a default; an unknown key is refused (keys an older Kitchen wrote are
ignored, and `kitchen init` names them). The schema is `src/config.ts` (`ConfigSchema`).

```yaml
version: 1
agent: { tool: claude, max_usd: 20 }          # max_usd: kitchen run's budget, summed over its lane sessions
round_limit: 3                                 # Build → QA → Review rounds before a person is asked
parallel: 4                                    # lane agents at once
checks:                                        # Kitchen runs them after Build and on staging before a merge
  - { name: test, run: "npm test" }
  - { name: e2e, run: "npm run test:e2e", when: merge, needs_app: true, timeout_sec: 900 }   # only on the merge, against the app
checks_install: npm                            # a frozen install in each fresh worktree
app: { start: "npm start", health: "/healthz", reset: "npm run seed" }
staging: { branch: staging, base: main, max_lines: 400 }
forge: { kind: github, repo: you/your-repo }   # merge into staging through a PR (default: local)
```

| key | default | what |
|---|---|---|
| `round_limit` | 3 | rounds (QA or review sending the job back to Build) before it goes to a person |
| `parallel` | 4 | lane agents at once; the wave plan holds the rest. Intake lanes are never held: every job in intake starts, and build, QA and review get the room left
| `models.intake` / `builder` / `qa` / `reviewer` | strong / strong / medium / medium | the model each lane's agent runs on: a tier, or a model name. The regress lane and the verify sweep and maintain runs use `qa`'s; a collect's triage uses `intake`'s. These flat keys are the active tool's profile |
| `models.claude` / `models.codex` | none | ADR 0023: one profile per tool, the same four keys; switching `agent.tool` keeps each tool's choices, and a tool's own profile wins over the flat keys. `kitchen models` lists each lane's model and the choices; `kitchen models set <lane> <model>` (or the dashboard's orchestrator line) writes here |
| `intake.confirm` | false | true: every job intake accepts waits under Needs you with its criteria and what it left out; `kitchen approve <id>` (or Approve on the dashboard) sends it to Build, `kitchen feedback <id> "…"` back to intake with your edit (ADR 0020) |
| `agent.tool` | claude | the tool `kitchen run` starts for each lane: `claude -p`, or `codex exec --json` (ADR 0030) |
| `agent.command` | `claude` (or `codex`) on PATH | the argv prefix of each lane session `kitchen run` starts |
| `agent.models` | opus / sonnet / haiku | what `strong` / `medium` / `cheap` mean |
| `agent.max_usd` | none | `kitchen run`'s budget: nothing new starts once its lane sessions spent it; each Claude lane gets what is left as `--max-budget-usd` |
| `checks` | [] | shell commands, run in the job's worktree from its root; a string or `{ name, run, timeout_sec, when, needs_app }` |
| `checks[].when` | `build` | `build`: after every Build round and on the trial merge into staging. `merge`: only on the trial merge, before it lands (an end-to-end suite: slow, once per merge is the gate that matters). A red `merge` check sends the job back to Build as a round, even when staging moved (it never ran on the branch alone, so Kitchen can't tell staging caused it). `kitchen init` writes your e2e suite this way (ADR 0021) |
| `checks[].needs_app` | false | `when: merge` only: Kitchen starts the app from the trial merge's folder first, as `kitchen qa up` does (`app.reset`, a free port, the health check), runs the check with the app's URL in `$BASE_URL`, `$PLAYWRIGHT_BASE_URL` and `$CYPRESS_BASE_URL`, and always stops the app after. Your suite's config reads one of them (Playwright: `use: { baseURL: process.env.BASE_URL }`; Cypress reads `CYPRESS_BASE_URL` itself) |
| `checks_install` | none | `npm`, `pnpm`, `yarn`, `yarn-classic` or `bun`: a frozen install before the checks in a fresh worktree |
| `checks_prepare` | none | another command to ready a worktree (after the install) |
| `app.start` | "" | the command that serves the app in the foreground; it gets `$PORT` (and `{port}` in the command) |
| `app.port` | a free one | a fixed port, for an app that can't take `$PORT` (then QA runs one app at a time) |
| `app.url` | `http://127.0.0.1:{port}` | where the app answers |
| `app.health` | `/` | a path that answers below 400 once the app is up |
| `app.reset` | none | puts the data back to its seed; run before every `kitchen qa up` and by `kitchen qa reset` (down, reset, up) between QA's checks. `kitchen init` takes a `db:reset`, `reset`, `seed` (and similar) script or Makefile target; without one, QA's restarts keep the data, so add it if the app stores any (e.g. `rm -f data/*.json`) |
| `app.stop` | none | runs after the app's process is stopped (`kitchen qa down`, the end of a `needs_app` check), with the same `$PORT` and `$COMPOSE_PROJECT_NAME`. A compose app without it gets `docker compose -p <project> down -v` |
| `app.ready_timeout_sec` | 60 | how long `kitchen qa up` waits for the health check |
| `staging.branch` | staging | where passing jobs merge; never the base, `main` or `master` |
| `staging.base` | the branch init ran on | what staging is created from; Kitchen never touches it |
| `staging.max_lines` | 400 | a bigger change stops at Ready |
| `staging.auto_merge` | true | false: every job stops at Ready |
| `high_paths` | migrations, auth, payments, infra, CI, `.env*` | a change touching one stops at Ready |
| `forge.kind` | local (github when init found GitHub and `gh`) | `github`: push the job branch, PR into staging, merge pinned to the reviewed head |
| `skills.enabled` | true | false: every lane on its role prompt alone |
| `skills.use_installed` | [] | vendored skills to take from your own install instead |

**Compose apps** (ADR 0021): when `app.start` runs `docker compose` or `docker-compose`, each job's app runs in its own compose project, `COMPOSE_PROJECT_NAME=kq<job number>` (`kq<job number>-merge` for the merge check's), set for `app.start`, `app.reset` and `app.stop`: containers, networks and volumes are per job, and `kitchen qa down` removes them (`docker compose -p kq<job> down -v`, or your `app.stop`). Don't pass `-p` in `app.start`. Publish only the app's port, as `"${PORT}:<its port>"`: a fixed published port (`"5432:5432"`) can't be bound by two jobs at once, and `kitchen init` says so when it sees one. Services reach each other on the compose network without publishing.

**A deployed environment**: `kitchen verify sweep --url https://staging.example.com` drives every feature of the map against that URL instead of starting the app; there is no key for it, and the URL is kept only in that sweep's run folder, never in a job (jobs always test their own code). Recipes that need a reset or seed are reported "not run: needs a fresh seed".

The verify skill (`.claude/skills/verify-<app>/`, ADR 0017) is files in your repo, with two keys here (ADR 0027):

```yaml
verify:
  skill: verify-shop   # its folder name, chosen once by kitchen init (package name, else the main checkout's folder)
  map: repo            # repo: committed with each change; local: .kitchen/verify/skill/<skill>/ on this machine
```

`kitchen init` sets both from git: `local` when the repo ignores `.claude/` (it says so once), or when a `verify-*` skill is there but not committed (it warns you to commit it, and switches back to `repo` on the next `kitchen run` once a commit has it). A kitchen.yaml without them gets them on the next `kitchen run`. In `local` mode Kitchen copies the skill into each job's worktree, trial merge and verify run, and writes QA's map updates back to `.kitchen/verify/skill/`; nothing under `.claude/` is committed. A map update that can't be written or committed never holds a change back: the job moves on and its line and Report say `map update skipped: <reason>`. `kitchen init` writes it from `app:` (start, reset, health), the handles it finds in your page code and your end-to-end suite (its **Your tests** section: where the specs are, their page objects, fixtures and login or seed helpers, how to run one spec); edit it freely. Which features a merge drives comes from each feature file's `Code:` line, and `staging.auto_merge: false` also leaves `kitchen verify maintain`'s branch for you to merge.

Environment: `KITCHEN_CLAUDE_BIN` / `KITCHEN_CODEX_BIN` (the binary `kitchen run` starts for each lane), `KITCHEN_GH_BIN` (the `gh` Kitchen's
merge uses), `KITCHEN_PROTECTED_BRANCHES` (more branches the push guard protects), `KITCHEN_ALLOW_PROTECTED_PUSH=1`
(turns the push guard off for one Claude Code session: a person's own).
