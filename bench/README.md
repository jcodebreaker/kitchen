# Kitchen benchmark

**The rule: no ADR merges without a bench number.** A branch that changes Kitchen's behaviour (an ADR, a role prompt, the scheduler, the merge) lands with a row in [results/SUMMARY.md](results/SUMMARY.md) from a run on its own commit: a `--dry` row always, and a real row whenever the owner approves the spend. Compare it with the last real row on `main`; a drop in oracle passes, or a rise in cost or rounds, is explained in the PR or the change doesn't land.

## Run it

```sh
npm run bench -- --dry                              # the whole pipeline with a stand-in agent: $0, about 15 s
npm run bench -- --estimate                         # what a real run should cost, per lane
npm run bench -- --paid                             # a real run: 10 tickets, preset cheap, at most $10 (the owner approves each one)
npm run bench -- --paid --tickets search,renew --models haiku --max-usd 3
```

| flag | meaning |
|---|---|
| `--tickets a,b` | only these tickets (keys below); default all ten |
| `--models <preset>` | `cheap` (default): intake haiku, build sonnet, QA haiku, review haiku. `haiku`: every lane haiku. `default`: Kitchen's own defaults (intake and build opus, QA and review sonnet). The merge check runs on QA's model |
| `--dry` | a stand-in agent (`dry/agent.mjs`, set as `KITCHEN_CLAUDE_BIN`, as the scheduler tests do) plays every lane the right way: intake makes the right call, Build commits the reference change (`dry/ref.mjs`), QA, review and the merge check pass. Everything else is Kitchen's real code: init, the scheduler, moves, checks, merges into staging, catch-ups. It proves the pipeline and the oracles, never Kitchen's quality |
| `--paid` | required for a real run; without it (and without `--dry`) the bench prints the estimate and starts nothing |
| `--max-usd n` | the run's budget, passed to `kitchen run --max-usd` (default 10) |
| `--estimate` | print the expected cost and exit; `--ledger <ledger.jsonl>` adds a real repo's lane costs to what it knows |
| `--out <dir>` | where the run folder goes (default the OS temp dir; never inside this repo) |
| `--keep` | keep the run folder (the repo, `run.log`, `bench.log`, each oracle's log) |
| `--timeout-min n` | stop the run (`kitchen run --stop`) after n minutes (default 120, `--dry` 10) |

## What a run does

1. Copies `fixtures/e-library` (a small lending library API: books, members, loans, one JSON file, no dependencies) to a fresh temp folder, makes the planted bugs, `git init` and one commit.
2. `kitchen init --yes`, then `kitchen models set` for the preset, commits the setup and moves `staging` onto it. Its own `KITCHEN_HOME` in the run folder: the person's dashboard and repos list are never touched.
3. **Baseline**: runs every code oracle on staging before any work. Each must fail there; one that passes proves nothing and is listed in the results (`vacuousOracles`).
4. Files the tickets with `kitchen ticket --no-run` (`--check` for the check).
5. `kitchen run --max-usd n` until the queue drains: what is left waits on a person.
6. Judges every ticket with its **oracle** (`oracles/<key>.mjs`) on the merged `staging`: for a code ticket, the app started from staging's tree on fresh seed data and driven over HTTP; for the others, the job's state. Oracles are never shown to Kitchen or its agents, and they don't trust Kitchen's own QA.
7. Writes `results/<date>-<sha>-<preset>[-dry].json` and adds a row to `results/SUMMARY.md`.

## The tickets

All small, so cheap models can do them.

| key | kind | what a correct run ends in | the oracle checks |
|---|---|---|---|
| `search` | feature | merged | `?q=` matches title or author in any case; no `q` lists all six |
| `members-me` | feature | merged | `/members/me` is the caller's id, name, role; no member is 401 |
| `renew` | feature | merged | +14 days from the due date, once; a second renewal and a returned loan are 409 |
| `healthz-version` | feature | merged | `/healthz` has `"version": "0.3.1"` and keeps its fields |
| `returned-stuck` | bug (planted in `lib/loans.js`) | merged | a returned copy is available and can be borrowed again |
| `zero-copies` | bug (planted in `server.js`) | merged | 0 copies is a 400; 1 is fine, 21 still refused |
| `families` | ambiguous | needs-info (a question or refine) | stage needs-info, never built or merged |
| `check-limit` | check | done, every criterion passing | a check (`kind: check`), all criteria pass, no finding, never built or merged |
| `request-id` | shared file | merged, the others intact | every response, errors included, has its own `X-Request-Id`. It changes the response helper every route shares, so the other tickets merging around it exercise the merge, its catch-ups and the checks on the merged result; all oracles run on the same final staging, so one ticket breaking another shows as the other's FAIL |
| `push-main` | out of bounds | rejected | stage rejected, never built, `main` unmoved, the tests still on staging |

## Columns

`results/SUMMARY.md`, one row per run:

| column | meaning |
|---|---|
| date | the run's day (UTC) |
| mode | `real` (model calls, paid) or `dry` (the stand-in, $0) |
| Kitchen | the commit measured (`git rev-parse --short HEAD`), `-dirty` when `src/`, `roles/`, `skills/` or `hooks/` had changes |
| preset | the model preset |
| oracle pass | tickets whose oracle passed, of those run: **the number that matters** |
| merged | jobs Kitchen merged into staging (7 of the 10 should be) |
| needs you | jobs left waiting on a person: needs-info, needs-human, ready or paused (1 is right: `families`) |
| rounds | Build rounds over every job (a catch-up after staging moved is not a round; the JSON counts those as `catchUps`). 7 is the floor: one per code ticket |
| wall | the whole bench, set-up and oracles included (the JSON has `runSecs`, the queue alone) |
| $ | spent, from the ledger: the sum of every lane session's `usd` |
| per ticket | each ticket's oracle result |

The JSON also has, per ticket: the job id, its final stage (and what it waits for), merged or not, rounds, catch-ups, the lanes it ran, its cost, the oracle's note and the baseline result; and every lane session's lane, model and cost (`lanes`), which `--estimate` reads from past real runs.

## Notes

- A real run uses Claude Code signed in as the owner, through `kitchen run`, exactly as a person would. The repo is what `kitchen init --yes` makes of the fixture, so it has no `app.reset` (init says so): QA's restarts keep the data earlier checks left, as in a repo whose owner skipped that hint.
- The `default` preset is likely to need more than the $10 default budget (`--estimate --models default`).
- Never run a real bench from CI or a script: each paid run is started by hand.

## Older bench data

`set.yaml`, `oracle/` and the `2026-11-22-*` files in `results/` come from the bench before ADR 0016, which drove the removed runner and proof runner. They are kept as data and no longer run.
