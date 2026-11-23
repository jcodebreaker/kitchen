# Configuration

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
| `skills` | `{ enabled: true, use_installed: [] }` | role skills (see [Role skills](../README.md#role-skills)); `enabled: false` runs every role on its prompt alone; `use_installed` names vendored skills to take from your own install; `host: claude\|codex` says where to look for the `fake` tool |

`kitchen migrate --dry-run` shows what an upgrade of Kitchen would change in `kitchen.yaml` and in the Toolkit's template files, and exits 1 when there is something to change (0 when there is nothing), so CI can check it; `kitchen migrate` writes it (you commit it).
