# Configuration

`kitchen.yaml` in your repo. Every key has a default; an unknown key is refused, so a typo never falls back to a
default silently (keys an older Kitchen wrote are ignored, and `kitchen init` names them). The schema is
`src/config.ts` (`ConfigSchema`). `kitchen init` writes the file with what it found; edit it freely.

```yaml
version: 1
agent: { tool: claude, max_usd: 20 }          # max_usd: kitchen run's budget, summed over its lane sessions
round_limit: 3                                 # Build → QA → Review rounds before a person is asked
parallel: 4                                    # lane agents at once
checks:                                        # Kitchen runs them after Build and on the target before a merge
  - { name: test, run: "npm test" }
  - { name: e2e, run: "npm run test:e2e", when: merge, needs_app: true, timeout_sec: 900 }   # only on the merge, against the app
checks_install: npm                            # a frozen install in each fresh worktree
app:
  start: "npm start"
  health: "/healthz"
  reset: "npm run seed"
  scenarios: { loan-due-tomorrow: "node scripts/scenario.js loan-due-tomorrow" }   # optional
  whoami: /api/me                              # optional
requires:                                      # optional: what the project needs on this machine
  - { name: venv, check: "test -x .venv/bin/python", fix: "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" }
staging: { branch: staging, base: main, max_lines: 400, merge: kitchen }
forge: { kind: github, repo: you/your-repo }   # GitHub pull requests (default: local)
verify: { skill: verify-library, map: repo }
```

## Every key

| key | default | what |
|---|---|---|
| `version` | 1 | the file format; only `1` |
| `round_limit` | 3 | 1 to 20. Rounds (QA or review sending the job back to Build) before it goes to a person. A catch-up is not a round, and neither is a job's QA retry on what it couldn't test (a check's retry does count) |
| `parallel` | 4 | 1 to 16. Lane agents at once; the wave plan holds the rest, and the dashboard says why each one waits ("Waiting for a free lane · 006 and 007 are using both (parallel: 2)"). Intake lanes are never held: every job in intake starts, and build, QA and review get the room left |
| `models.intake` / `builder` / `qa` / `reviewer` | strong / strong / medium / medium | the model each lane's agent runs on: a tier (`strong`, `medium`, `cheap`) or a model name. The merge check (regress) lane, the verify runs and a check's second look use `qa`'s or `reviewer`'s; a collect's triage uses `intake`'s. These flat keys are the active tool's profile |
| `models.claude` / `models.codex` | none | one profile per tool, the same four keys (ADR 0023): switching `agent.tool` keeps each tool's choices, and a tool's own profile wins over the flat keys. `kitchen models` lists each lane's model and the choices; `kitchen models set <lane> <model\|tier>` (or the dashboard's model line) writes here |
| `intake.confirm` | false | true: every job intake accepts waits under Needs you with its criteria and what it left out; `kitchen approve <id>` (or Approve on the dashboard) sends it to Build, `kitchen feedback <id> "…"` back to intake with your edit (ADR 0020) |
| `high_paths` | `**/migrations/**`, `**/auth/**`, `**/*payment*`, `infra/**`, `.github/**`, `**/.env*` | globs; a change touching one stops at Ready for you |
| `checks` | [] | shell commands, run in the job's worktree from its root: a string, or `{ name, run, timeout_sec, when, needs_app, enabled }`. A string is named `check<n>` |
| `checks[].timeout_sec` | 600 | seconds before the check is ended and counts as failed |
| `checks[].when` | `build` | `build`: after every Build round and on the trial merge. `merge`: only on the trial merge, before it lands (an end-to-end suite: slow, and once per merge is the gate that matters). A red `merge` check sends the job back to Build as a round, even when the target moved (it never ran on the branch alone, so Kitchen can't tell the target caused it). `kitchen init` writes your e2e suite this way (ADR 0021) |
| `checks[].needs_app` | false | `when: merge` only (refused otherwise, and refused when `app.start` is empty): Kitchen starts the app from the trial merge's folder first, as `kitchen qa up` does (`app.reset`, a free port, the health check), runs the check with the app's URL in `$BASE_URL`, `$PLAYWRIGHT_BASE_URL` and `$CYPRESS_BASE_URL`, and always stops the app after. Your suite's config reads one of them (Playwright: `use: { baseURL: process.env.BASE_URL }`; Cypress reads `CYPRESS_BASE_URL` itself) |
| `checks[].enabled` | true | false: the check stays written down but never runs; the Report says "<name>: off in kitchen.yaml" (ADR 0032) |
| `checks_install` | none | `npm`, `pnpm`, `yarn`, `yarn-classic` or `bun`: a frozen install from the lockfile before the checks in a fresh worktree |
| `checks_prepare` | none | another command that readies a worktree (after the install) |
| `app.start` | "" | the command that serves the app in the foreground, from the worktree root; it gets `$PORT` (and `{port}` in the command). Empty: nothing to start (a library, a CLI) |
| `app.port` | a free one | a fixed port, for an app that can't take `$PORT` (then QA runs one app at a time). If something already answers there, Kitchen leaves it alone and says "port N is in use (another job's app or yours)" (ADR 0033) |
| `app.url` | `http://127.0.0.1:{port}` | where the app answers |
| `app.health` | `/` | a path (or URL) that answers below 400 once the app is up |
| `app.reset` | none | puts the data back to its seed: run before every `kitchen qa up`, by `kitchen qa reset` (down, reset, up) between QA's checks, and before a QA retry. `kitchen init` takes a `db:reset`, `reset`, `seed` (and similar) script or Makefile target; without one, QA's restarts keep the data, so add it if the app stores any (e.g. `rm -rf data`) |
| `app.stop` | none | runs after the app's process group is stopped (`kitchen qa down`, the end of a `needs_app` check), with the same `$PORT` and `$COMPOSE_PROJECT_NAME`. A compose app without it gets `docker compose -p <project> down -v` |
| `app.ready_timeout_sec` | 60 | how long `kitchen qa up` waits for the health check |
| `app.scenarios` | {} | `{ <name>: <command> }` (ADR 0033). Each command prepares one state on the running app, just before the action a criterion tests, and prints JSON naming what it made (`{ "loan": 4, "as": "ana" }`). `kitchen qa scenario <job> <name>` runs it with `$BASE_URL`, `$PORT`, `$COMPOSE_PROJECT_NAME` and `$KITCHEN_JOB`; output that isn't JSON fails. Names are letters, digits, `.`, `_`, `-` (they name a file). A criterion's `· given: scenario <name>` names one |
| `app.whoami` | none | a command, or a path or URL on the app, that answers with the identity QA acts as (`{ "user": "ana", "role": "member" }`). `kitchen qa whoami <job>` saves it as evidence (ADR 0033) |
| `requires` | [] | `[{ name, check, fix }]`: what the project needs on this machine. `kitchen doctor` runs each `check` from the repo and prints ok or failing with its `fix`; `kitchen run` refuses to start while one fails ("venv isn't ready: <fix>. Nothing started."); `kitchen init` runs them once and reports |
| `browser` | unset | `chrome`, `msedge` or `chromium`: pin QA's browser (ADR 0034). Unset: the installed Google Chrome, then Microsoft Edge, then Playwright's Chromium if it is already on disk. A pinned browser that is missing is refused by name; the others are never tried. Kitchen never downloads a browser |
| `staging.branch` | staging | where passing jobs merge by default; never the base, `main` or `master` |
| `staging.base` | main (init writes the branch it ran on) | what staging is created from; Kitchen never merges into it |
| `staging.max_lines` | 400 | a bigger change stops at Ready |
| `staging.auto_merge` | true | false: every job stops at Ready |
| `staging.merge` | kitchen (init sets `pr` when `origin` is on GitHub and `gh` is signed in) | who merges a passing job into its target (ADR 0026). `kitchen`: Kitchen does. `pr`: after the merge check passes, Kitchen pushes the job branch and opens (or updates) a PR into the target with the Report as its body; a person merges it on GitHub, and Kitchen never does. Needs `forge.kind: github` |
| `agent.tool` | claude | the tool `kitchen run` starts for each lane: `claude -p`, or `codex exec --json` (ADR 0030) |
| `agent.command` | `claude` (or `codex`) found on PATH | an argv list that replaces the binary `kitchen run` starts for each lane (and collect's triage), e.g. `["/opt/tools/claude"]` |
| `agent.models` | Claude: opus / sonnet / haiku; Codex: gpt-5.6-terra / gpt-5.6-terra / gpt-5.6-luna | what `strong` / `medium` / `cheap` mean for the tool `agent.tool` names |
| `agent.max_usd` | none | `kitchen run`'s budget (`--max-usd` overrides it): nothing new starts once its lane sessions spent it; each Claude lane gets a share of what is left as `--max-budget-usd`. Codex reports tokens, not dollars, so no cap applies to a Codex lane |
| `skills.enabled` | true | false: every lane on its role prompt alone |
| `skills.host` | `agent.tool` | `claude` or `codex`: where Kitchen looks for installed role skills, when it differs from the agent tool |
| `skills.use_installed` | [] | skills Kitchen ships that it should take from your own install instead |
| `verify.skill` | set by `kitchen init` | the verify skill's folder name, `verify-<name>` (an existing `verify-*` skill's name, else the package name, else the checkout's folder). A kitchen.yaml without it gets it on the next `kitchen run` (ADR 0027) |
| `verify.map` | repo | `repo`: the map lives in `.claude/skills/<skill>/` and is committed with each change. `local`: it lives in `.kitchen/verify/skill/<skill>/` on this machine and is never committed (see below) |
| `forge.kind` | local (init sets `github` when it finds GitHub and `gh`) | `github`: push the job branch and merge through a PR into the target, pinned to the reviewed head (`--match-head-commit`) |
| `forge.repo` | set by `kitchen init` | `owner/repo` on GitHub |

A few combinations are refused when the file loads: `staging.branch` equal to `staging.base`, `main` or `master`;
`staging.merge: pr` without `forge.kind: github`; `needs_app: true` on a check that isn't `when: merge`, or with an
empty `app.start`.

## Compose apps

When `app.start` runs `docker compose` or `docker-compose`, each job's app runs in its own compose project,
`COMPOSE_PROJECT_NAME=kq<job number>` (`kq<job number>-merge` for the merge check's), set for `app.start`,
`app.reset` and `app.stop`: containers, networks and volumes are per job, and `kitchen qa down` removes them
(`docker compose -p kq<job> down -v`, or your `app.stop`). Don't pass `-p` in `app.start`. Publish only the app's
port, as `"${PORT}:<its port>"`: a fixed published port (`"5432:5432"`) can't be bound by two jobs at once, and
`kitchen init` says so when it sees one. Services reach each other on the compose network without publishing.
(ADR 0021)

## A deployed environment

`kitchen verify sweep --url https://staging.example.com` drives every feature of the map against that URL instead of
starting the app. There is no key for it: the URL is kept only in that sweep's run folder, never in a job (jobs
always test their own code). Recipes that need a reset or seed are reported "not run: needs a fresh seed".

## The verify skill

The verify skill (`.claude/skills/verify-<app>/`, ADR 0017) is files in your repo, with two keys here (ADR 0027):

```yaml
verify:
  skill: verify-library   # its folder name, chosen once by kitchen init
  map: repo               # repo: committed with each change; local: .kitchen/verify/skill/<skill>/ on this machine
```

`kitchen init` sets both from git: `local` when the repo ignores `.claude/` (it says so once), or when a `verify-*`
skill is there but not committed (it warns you to commit it, and switches back to `repo` on the next `kitchen run`
once a commit has it). In `local` mode Kitchen copies the skill into each job's worktree, trial merge and verify run,
and writes QA's map updates back to `.kitchen/verify/skill/`; nothing under `.claude/` is committed. A map update that
can't be written or committed never holds a change back: the job moves on and its line and Report say
`map update skipped: <reason>`.

`kitchen init` writes the skill from `app:` (start, reset, health), the handles it finds in your page code and your
end-to-end suite (its **Your tests** section: where the specs are, their page objects, fixtures and login or seed
helpers, how to run one spec). Which features a merge drives comes from each feature file's `Code:` line, and
`staging.auto_merge: false` also leaves `kitchen verify maintain`'s branch for you to merge.

## Environment

| variable | what |
|---|---|
| `KITCHEN_CLAUDE_BIN` / `KITCHEN_CODEX_BIN` | the binary `kitchen run` starts for each lane (else the one on PATH) |
| `KITCHEN_GH_BIN` | the `gh` Kitchen's merge and PRs use |
| `KITCHEN_PROTECTED_BRANCHES` | more branches the push guard protects |
| `KITCHEN_ALLOW_PROTECTED_PUSH=1` | turns the push guard off for one Claude Code session: a person's own |
| `KITCHEN_HOME` | where the dashboard keeps its repo list and log (default `~/.kitchen`) |
| `KITCHEN_DASHBOARD_PORT` | the shared dashboard's port (default 7357), for a second one beside your own |
| `KITCHEN_SLACK_TOKEN` | the Slack source's token, when no keychain is available |
