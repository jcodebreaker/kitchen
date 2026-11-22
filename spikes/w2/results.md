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

## W2 review round (2026-11-22)

Every finding of the Wave 2 review, its fix and what proves it. Free spikes first (no model), then the real agent runs. Rerun with `README.md`.

| finding | fix | proof |
|---|---|---|
| **Blocker:** a `bin/dev` timeout never fired while a child held stdout (2 s timeout returned after 146 s) | `src/toolkit/run.ts`: own process group (procs.ts conventions); timeout or stall kills the group (TERM, KILL after 2 s) and returns at once (`exit 124`, `timedOut`, "timed out after Ns: its process group was killed"); `exit`, not `close`, ends the wait, and the pipes get 1 s to drain. Signature unchanged (new optional `stallMs`) | `timeout.ts` 6/6: a 2 s timeout returns in 2.0 s with a `sleep` holding stdout, and the group is gone; a bin/dev that exits leaving a child on stdout returns in 1.1 s with its JSON; a stall is killed after `stallMs` |
| A broken Toolkit passed `toolkit check` | `check.ts` holds every call to exactly one JSON line; `up` url http(s) (cli: an absolute URL); `doctor` ≥1 check; `surface` enum; the **contract probe** after the reset round: every primitive once (args from a probe table, else the first feature-drive step that uses it), then `read` of a missing target → `ok:false`, `open`/`http` of `http://example.invalid/…` and `//example.invalid/…` refused, a duplicated `--id` refused | `probe.ts` 14/14: the reviewer's fake (ok to everything, stdout logs, two describe lines, unimplemented `frobnicate`, `url:"x"`, `checks:[]`) fails; each fault alone fails at its step, named (`describe printed 2 lines…`, `url "x" is not an absolute URL`, `doctor must run at least one check`, `frobnicate {}: not a primitive answer … is frobnicate implemented?`, four `another origin … answered ok:true`, `a flag given twice (--id) is refused`); the fault-free fake passes. **Fixtures A–D still pass:** fixture A's hand-made Toolkit (`sandbox.ts`, through the bridge) and all 7 generated Toolkits from the W2 runs (A, B, C on Claude and Codex, D on Claude), re-checked with the new code: every one PASS, contract probe ok (Claude: A 31 s, B 7 s, C 74 s, D 12 s; Codex: A 22 s, B 4 s, C 33 s) |
| Feature `paths` could be empty (re-proof weakened) | `parseFeature` refuses a block without `paths`; the check refuses globs that match no file tracked at the base (`git ls-tree --full-tree`) | `probe.ts`: `empty-paths` and `typo-glob` (`srver.js`) fail at `features`, named; unit tests |
| `parallel:false` not enforced | runner: `effectiveConcurrency(config.concurrency, proven)`; init no longer regex-edits `kitchen.yaml` | `flow.ts`: proven `parallel:false`, `kitchen.yaml` still `concurrency: 2`, `kitchen run` prints "one job at a time (kitchen.yaml says 2)" |
| An init re-run after a failed check said done | only `check.ok && !check.static` is done; a failed or static check runs again; else exit 1 with the real state. A build that ended BLOCKED is built again | `flow.ts`: state set to a failed check → the re-run checks again and passes; set to static → the full check runs; no agent call either time |
| Setup from inside the tools held one long Bash call | `kitchen init --detach` + `.kitchen/init/status.json` + `kitchen init --status [--wait ≤110 s]`, one init per repo; skill rewritten (start detached outside the sandbox, poll with `--wait`, resume a running or waiting init, never answer questions for the user) | `flow.ts` (detached questions → `--answers --detach` → done; a second init refused while one runs); real runs below |
| Secrets could be committed | `src/init/secrets.ts`: every staged file is scanned before each setup commit; refuses `sk_live_`/`rk_live_`, `AKIA`/`ASIA`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `xox[baprs]-`, PEM private keys, and any secret-looking value equal to one in the developer's untracked root `.env*`; unstages and names file, line and key | unit tests (6); `flow.ts`: a live-looking Stripe key and a value copied from the developer's `.env` → init exits 1 naming `.env.kitchen:7 STRIPE_SECRET_KEY` and `.env.kitchen:5 SEED_ALICE_PASSWORD`, nothing committed, `--status` says failed with the reason |
| Checkout GC could delete a checkout in use | leases per checkout (pid + start time, `release()`), live slots' `toolkitBin`, one per-repo lock for create and GC | `gc.ts` 6/6: leased (by this process, by another live process) kept; owner `kill -9` → removed; a live slot's checkout kept; released → removed; `keep` still wins |
| setup-mcp ran agent-written code unconfined | ADR 0008; `src/init/sandbox.ts`: the bridge wraps `bin/dev` in `sandbox-exec` (deny read/write of `~/.ssh`, `~/.aws`, `~/.config/gh`, gcloud, azure, kube, gnupg, netrc, git-credentials, `~/.claude*`, `~/.codex`, Keychains, `$KITCHEN_HOME` except its scrub config). Linux: unhandled, logged on start | `sandbox.ts` 9/9: a planted bin/dev reads `~/.ssh/*`, `~/.config/gh`, `~/.claude`, `~/.codex`, `$KITCHEN_HOME/engine.key`: every read denied through the bridge, every one readable unsandboxed; fixture A's Toolkit passes the full `toolkit_check` through the sandboxed bridge (Docker, two slots, probe) in 30 s |
| minor: `.env.kitchen` could set `NODE_OPTIONS`, `DYLD_*`, `LD_*`, `PATH` | `DENIED_APP_ENV` dropped in `untrustedEnvOf` (also `BASH_ENV`, `PYTHONPATH`, Kitchen's own names) | unit test |
| minor: `describe.surface` free text | enum `web\|cli\|api` | unit test |
| minor: prepare cached per sha only | also per lockfile hash for the same source tree (`prepareKey`: lockfiles, the Toolkit's package files, the tree's birth time) | typecheck; `flow.ts` re-proofs |
| minor: no `setup` model key; placeholder URL in the `kitchen.yaml` header | `models.setup` (default strong); the header names the package and the schema | `inside.ts` runs with `models: { setup: medium }` |
| minor: no `kitchen toolkit up\|down` | `toolkit up` (foreground, its own slot, Ctrl-C brings it down), `toolkit down --id` (a slot left by kill -9) | `probe.ts`: up prints the url and holds the slot; SIGINT → down, slot freed, exit 0; kill -9 → `toolkit down --id` stops it and frees it |
| minor: prepare stall | `stallMs` (5 min without output) on every prepare | `timeout.ts` |

Also green after the changes: `flow.ts` 36/36, `spikes/w1/paths.ts` 54/54, `npm test` 250/250, typecheck, lint. One `flow.ts` run failed its smoke `up` while a real `inside.ts` check ran beside it with a different `KITCHEN_HOME` (each home has its own slot registry, so both took ports 31000–31019); the rerun alone passed 36/36. Kitchen's registry is per machine by design; only the spikes give each run its own home.

### Real agent runs

**Question round + `/kitchen` setup inside Claude Code** (`inside.ts claude e`, sonnet for the user's session and for Kitchen's setup role, effort medium). Fixture E = D whose catalog is `CATALOG=eu|us` with no default, and whose README says the orders team decides which one dev uses.

- Attempt 1 (turn 1, $0.06, 7 s): the agent ran `kitchen init --detach` (fine), then `sleep 60 && kitchen init --status`, which **Claude Code refused** ("Blocked: sleep 60 followed by: kitchen init --status…"); it checked once and ended its turn with "I'll check again when you ask". The detached init kept going and stopped at the question. Fix: `kitchen init --status --wait <≤110>` (Kitchen waits, not `sleep`); the skill polls with it in the same turn and starts with `--status`, so a running or waiting init is resumed, not restarted.
- Then, in the same repo with the updated skill (`W2_INSIDE_REUSE=1`): turn 1 (123 s, $0.056): `kitchen init --status` → questions; the agent relayed the question with its why and default and stopped without answering. (It also chained `|| npx devkitchen init --status`, which ran because `--status` exited 3 on questions; `--status` now exits 0 for every state.) Turn 2, `--resume` with "Use the EU catalog (eu).", 242 s, $0.087: it wrote `.kitchen/setup-answers.json` `{"answers":{"q1":"eu"}}`, ran `kitchen init --answers .kitchen/setup-answers.json --detach`, polled `kitchen init --status --wait 90` three times, and relayed done.
- Kitchen's setup role underneath: survey 31 s, $0.16, asked exactly one question ("Which catalog should the dev/verification environment use, eu or us?", default us); build 225 s, $0.78, resumed the survey's session with the answer; engine check PASS in 9.6 s (86 evidence entries). The Toolkit uses the answer: `.env.kitchen` has `CATALOG=eu` and the drives use the EU SKUs. `inside.ts` 11/11 (`runs/inside-claude-e.json`).
- Total: about $1.14 (the user's session $0.20, setup $0.94).

**What the user approves, Claude Code:** `kitchen init` as a Bash command. This run granted exactly `--allowedTools "Bash(kitchen init:*)" Read Write` (Read for `.kitchen/setup-questions.json`, Write for `.kitchen/setup-answers.json`). Claude Code's Bash isn't sandboxed by default, so the detached init runs outside any sandbox; a user who turned the Bash sandbox on must let this one command run unsandboxed (W0: a detached process keeps its session's sandbox). Nothing else: `--status --wait` is the same command prefix.

**Codex: blocked by the account's usage limit.** Fixture D on Codex (`init-fixture.ts d-api codex`, `gpt-5.6-terra`, the medium tier): the survey passed (70 s, no question); the build stopped after 160 s with "You've hit your usage limit … try again at Dec 21st, 2026 11:21 PM" (`runs/d-api-codex.json`: init exit 1, 186k in / 2.5k out tokens). A one-line `codex exec` probe on `gpt-6-luna` got the same error, so the `/kitchen` setup inside `codex exec` (`inside.ts codex b`, written and ready) was not run. Init handled the failure as designed: exit 1 with the reason, the survey kept, a re-run resumes the build.

**What the user approves, Codex** (shown without a model, `codex-sandbox.ts` 3/3): `kitchen init --detach` run inside Codex's workspace sandbox (`codex sandbox -P :workspace`) detaches but keeps the sandbox, and fails at its second step (`EPERM … mkdir .agents/skills/kitchen`; it couldn't write `.git`, reach Docker or start the setup agent either); `kitchen init --status` works inside the sandbox; the same init run outside (an approved, escalated call) finishes. So on Codex the user approves `kitchen init` once, escalated (`require_escalated`; "always allow" writes `prefix_rule(pattern=["kitchen","init"], decision="allow")` under `~/.codex/rules/`); `--status` needs no approval. For `codex exec` (nobody to approve) that rule must exist beforehand; `inside.ts codex` writes it to `~/.codex/rules/kitchen-w2-spike.rules` for the run and removes it after. Unproven until the quota resets: that an execpolicy `allow` runs the command outside the sandbox.
