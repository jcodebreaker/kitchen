# W2 results

Run on 2026-11-22, macOS (4 CPU, 6 GB for Docker), Node 26.9, git 2.39, Docker 29.5, Claude Code 2.1.330, Codex CLI 0.171.0 (`npx -y @openai/codex@0.171.0`). Rerun with `README.md`. One JSON record per real run in `runs/`.

**Models.** Claude: `sonnet`, `--effort medium` (not the strongest model, to keep cost sane). Codex: `gpt-6-luna`, `model_reasoning_effort="medium"`. Kitchen's config maps Codex's strong tier to `gpt-5.6-terra`; Codex reports tokens, not dollars, and nothing on this machine gives terra's price, so its cost couldn't be shown to be sonnet-equivalent and the cheapest listed model was used (ADR 0006's W0 choice).

## Exit table

| exit check | result | evidence |
|---|---|---|
| `kitchen init` → `toolkit check` passes, fixture A regenerated from scratch (hand-made Toolkit and `.env.kitchen` deleted from the copy), Claude | **PASS** | `runs/a-web-claude.json`: init 166 s, check on the merged base 22 s, 4 features |
| same, fixture B (Python CLI + SQLite), Claude | **PASS** | `runs/b-cli-claude.json`: 110 s, 5 features, terminal module (`cli {argv}`, `read stdout`) |
| same, fixture C (adopt: existing compose), Claude | **PASS** | `runs/c-adopt-claude.json`: 331 s; the Toolkit wraps the repo's `docker-compose.yml`, one compose project per id |
| same, fixture D (API + payment API + mail), Claude | **PASS** | `runs/d-api-claude.json`: 223 s; `externals: [stripe: mock, smtp: mock]`, a Stripe-shaped mock and SMTP catcher in the Toolkit, signed webhooks as a primitive |
| same, fixture A, Codex | **PASS** | `runs/a-web-codex.json`: 239 s |
| same, fixture C, Codex | **PASS** (2nd attempt) | `runs/c-adopt-codex.json`: 527 s. Attempt 1 failed: see "What broke" |
| extra: fixture B, Codex | **PASS** | `runs/b-cli-codex.json`: 212 s |
| No-TTY question flow: exit 3 → `.kitchen/setup-questions.json` → `init --answers` resumes | **PASS** (scripted setup role) | `flow.ts` 26/26: exit 3 with the question; the second run doesn't re-run the survey, resumes its session, the answer reaches the build prompt quoted; a third `init` does nothing new. No real agent asked a question on A–D or superchat-lite (every survey answered from the repo), so the flow is proven with the scripted role only |
| Base-change re-proof: Toolkit-mapped change → next `kitchen run` re-checks; broken → queue paused + Toolkit ticket | **PASS** | `flow.ts`: base = proven → no check; README change → doctor + smoke drive; `server.js` (mapped by the features' `kitchen` blocks) → full check; broken `bin/dev` committed → full check fails at `up`, `.kitchen/queue.json`, one ticket in `tickets.jsonl` with the failing step and stderr, the queued job untouched (stage intake, 0 moves), `kitchen status` shows `queue: paused (…)`, the next run stays paused without re-checking or filing again; revert → re-proven, the queue runs, the job is taken |
| superchat-lite measurement (not a gate) | measured | below |
| Agent time under 20 minutes (v0.1 measure §0.1) | every passing run | max 498 s (C on Codex) |
| `npm test`, typecheck, lint | **PASS** | 237 tests (9 new, pure: contract schemas, feature `kitchen` blocks, globs) |
| W1 spikes after the merge with main | **PASS** | `spikes/w1/paths.ts` 54/54 |
| `docker ps` clean of our containers | **PASS** | every spike checks; see "Docker" |

## Agent runs, time and cost

Agent time is the sum of the setup role's runs (survey + build, no fix rounds were needed). Claude reports dollars; Codex only tokens.

| fixture | tool | runs | survey | build | agent time | cost | tokens in / out | engine check of the commit |
|---|---|---|---|---|---|---|---|---|
| A web + Postgres | Claude sonnet | 2 | 18 s | 126 s | 144 s | $0.56 | 544k / 17k | 21 s |
| A | Codex gpt-6-luna | 2 | 29 s | 197 s | 227 s | n/a | 1.52M / 10k | 12 s |
| B CLI + SQLite | Claude sonnet | 2 | 11 s | 92 s | 103 s | $0.42 | 435k / 14k | 7 s |
| B | Codex gpt-6-luna | 2 | 62 s | 146 s | 208 s | n/a | 1.29M / 12k | 4 s |
| C adopt (compose) | Claude sonnet | 2 | 23 s | 241 s | 264 s | $0.60 | 695k / 19k | 67 s |
| C | Codex gpt-6-luna | 2 (+1 failed attempt: 1 run, 39 s, 180k / 2k) | 67 s | 431 s | 498 s | n/a | 2.86M / 21k | 28 s |
| D API + externals | Claude sonnet | 2 | 30 s | 181 s | 211 s | $0.87 | 1.18M / 31k | 11 s |
| superchat-lite (generate only) | Claude sonnet | 2 | 53 s | 174 s | 227 s | $1.26 | – | static only |

Plus one aborted run (A on Claude, attempt 1): killed by hand after ~17 min, about $1.86 by the transcript's token counts. In all: 10 real `kitchen init` runs (Claude: A twice, B, C, D, superchat-lite; Codex: A, B, C twice), 19 agent runs; Claude spend about $6.0 including the aborted run.

## What broke, and what changed because of it

- **A on Claude, attempt 1: `prepare` hung for 14 minutes.** The agent pinned `playwright@1.49.1`, whose headless-shell download (build 1148) stalled at 160 KB; `bin/dev prepare` waited on it, and the agent, seeing only `exited 1` after I killed the download, retried the same prepare. I stopped the run. Fix: the template's `package.json` now pins `playwright@1.65.0` (its browser is in the shared cache), and `TEMPLATE.md` / `lib/browser.mjs` say why. Attempt 2 passed in 144 s agent time. Remaining gap: the check's `prepare` timeout is 30 minutes and gives no progress; a stalled download should fail faster (later).
- **C on Codex, attempt 1: no `survey.md`.** Codex chained `git status --short && cat > .kitchen-out/survey.md …`; `git status` failed in its sandbox (the worktree's gitdir is outside its writable root), so the write never ran, and the model reported success anyway. Fix: when a setup run ends `ok` without its file, `init` resumes the same session once with a short "write it now, on its own" prompt (`src/init/init.ts`). Attempt 2 passed (the nudge wasn't needed).
- **The first real check rejected `seed_users` objects** (`{user, role, …}`); the agent fixed it from the check's message in one step. The template now says plain strings.
- **C: the compose bind mount of `./db` into `/docker-entrypoint-initdb.d` didn't seed** when the stack ran from the scratch dir (`/private/tmp/…`); the generated `up` falls back to piping `db/*.sql` through `psql` and the check exercised that path. Probably Docker Desktop file sharing for that path; not reproduced under `/Users`. Recorded in the generated `setup.md`, the way the role asks.
- **Compose-built images were left behind** (`<project>-app`, one per check instance). The template's `down` now runs `compose down -v --remove-orphans --rmi local`; the leftovers from those runs were removed.
- `.kitchen-out` as an exclude pathspec makes `git add` fail when the repo ignores it; the setup commit deletes the outbox first instead.

## superchat-lite (measurement, not a gate)

Cloned `e91173afc8b7` (branch `durable-conversation`) into the scratch dir; the real checkout and its running stack were not touched. Its stack is Postgres + `superchat/engine` (2.85 GB image) + one `superchat/host` container per person at 2 GB each: over this laptop's Docker budget, so it ran `kitchen init --generate-only` (the agent may only run `describe`; the engine checks describe and the feature files statically; no `toolkit.proven`).

- **Time and cost:** 229 s wall, survey 53 s ($0.27) + build 174 s ($0.99) = $1.26. No questions. Well inside 60 minutes, no hand fixes.
- **Generated** (one commit on `kitchen/setup`, 15 files, +1226 lines): the **adopt** path over `deployment/compose.yaml` as one compose project per id (`COMPOSE_PROJECT_NAME`, which the engine also uses as the host-name prefix, so hosts don't collide); ports web, engine, mock model, browser; `.env.kitchen` with fake Postgres password, proxy secret, vault key and LiteLLM key; `mock-llm.mjs`, an Anthropic/OpenAI-shaped model stand-in (incl. streaming and `count_tokens`) that records each request, reached through the engine's own LiteLLM path; primitives = the browser module + `login` (single-user mode: opens `/` as `local`), `api`, `model_requests`, `hosts`; features `conversation.send`, `models-settings.open`, `engine-api.health`. `describe` and the 3 feature files pass the contract.
- **Unproven / likely to break when run** (from the agent's own `setup.md`): `prepare` = `deployment/build.sh` (image builds, minutes and GBs); whether the fake vault key format is accepted; whether a host started from `superchat/host:local` reaches the engine at `host.docker.internal`; whether the `claude` harness accepts the mock's streaming events through the model proxy (the survey's open risk); whether the mock's `/v1/models` shape is what the engine reads; selectors read from source, not from a run; host volumes may survive `down`; `reset` is a full `compose down -v` + up (slow, no snapshot); only single-user mode, no multi-person header path.
- **Stop rule (PLAN checkpoint W2):** under 60 minutes and no hand fixes for generation. Running it needs a machine with the Docker budget for the engine + host images; that is the W3b superchat-lite ticket's first step.

## Docker

At most two app stacks of ours at a time (the check's two slots); fixtures ran one after another except B (no Docker), which ran beside C. Another session on this machine was running fixture-A jobs (`kitchen-a-web-001-…` containers from a W3a worktree) during the last runs; the spikes' leftover check now only counts our instance ids (`chk-…`, `setup-…`). After the last run `docker ps` shows none of ours.
