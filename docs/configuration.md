# Configuration

`kitchen.yaml` in your repo. Every key has a default; an unknown key is refused (keys an older Kitchen wrote are
ignored, and `kitchen init` names them). The schema is `src/config.ts` (`ConfigSchema`).

```yaml
version: 1
agent: { tool: claude, max_usd: 20 }          # max_usd: kitchen run's spend cap
round_limit: 3                                 # Build → QA → Review rounds before a person is asked
parallel: 4                                    # lane agents at once
checks: [{ name: test, run: "npm test" }]      # Kitchen runs them after Build and on staging before a merge
checks_install: npm                            # a frozen install in each fresh worktree
app: { start: "npm start", health: "/healthz", reset: "npm run seed" }
staging: { branch: staging, base: main, max_lines: 400 }
forge: { kind: github, repo: you/your-repo }   # merge into staging through a PR (default: local)
```

| key | default | what |
|---|---|---|
| `round_limit` | 3 | rounds (QA or review sending the job back to Build) before it goes to a person |
| `parallel` | 4 | lane agents at once; the wave plan holds the rest. Intake lanes are never held: every job in intake starts, and build, QA and review get the room left
| `models.intake` / `builder` / `qa` / `reviewer` | strong / strong / medium / medium | the model each lane's agent runs on: a tier, or a model name |
| `agent.tool` | claude | the orchestrator's tool (`kitchen run` starts Claude Code) |
| `agent.command` | `claude` on PATH | the argv prefix `kitchen run` starts |
| `agent.models` | opus / sonnet / haiku | what `strong` / `medium` / `cheap` mean |
| `agent.max_usd` | none | `kitchen run`'s `--max-budget-usd` |
| `checks` | [] | shell commands, run in the job's worktree from its root; a string or `{ name, run, timeout_sec }` |
| `checks_install` | none | `npm`, `pnpm`, `yarn`, `yarn-classic` or `bun`: a frozen install before the checks in a fresh worktree |
| `checks_prepare` | none | another command to ready a worktree (after the install) |
| `app.start` | "" | the command that serves the app in the foreground; it gets `$PORT` (and `{port}` in the command) |
| `app.port` | a free one | a fixed port, for an app that can't take `$PORT` (then QA runs one app at a time) |
| `app.url` | `http://127.0.0.1:{port}` | where the app answers |
| `app.health` | `/` | a path that answers below 400 once the app is up |
| `app.reset` | none | puts the data back to its seed; run before every `kitchen qa up` and by `kitchen qa reset` (down, reset, up) between QA's checks. `kitchen init` takes a `db:reset`, `reset`, `seed` (and similar) script or Makefile target; without one, QA's restarts keep the data, so add it if the app stores any (e.g. `rm -f data/*.json`) |
| `app.ready_timeout_sec` | 60 | how long `kitchen qa up` waits for the health check |
| `staging.branch` | staging | where passing jobs merge; never the base, `main` or `master` |
| `staging.base` | the branch init ran on | what staging is created from; Kitchen never touches it |
| `staging.max_lines` | 400 | a bigger change stops at Ready |
| `staging.auto_merge` | true | false: every job stops at Ready |
| `high_paths` | migrations, auth, payments, infra, CI, `.env*` | a change touching one stops at Ready |
| `forge.kind` | local (github when init found GitHub and `gh`) | `github`: push the job branch, PR into staging, merge pinned to the reviewed head |
| `skills.enabled` | true | false: every lane on its role prompt alone |
| `skills.use_installed` | [] | vendored skills to take from your own install instead |

Environment: `KITCHEN_CLAUDE_BIN` (the `claude` binary `kitchen run` starts), `KITCHEN_GH_BIN` (the `gh` Kitchen's
merge uses), `KITCHEN_PROTECTED_BRANCHES` (more branches the push guard protects), `KITCHEN_ALLOW_PROTECTED_PUSH=1`
(turns the push guard off for one Claude Code session: a person's own).
