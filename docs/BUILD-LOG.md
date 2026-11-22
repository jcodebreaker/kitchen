# Kitchen build log

One entry per wave: what was built, review rounds and scores, what is proven, and what is left. The plan is `docs/PLAN.md`; adapter facts are in `docs/adr/0006-agent-adapters.md`.

## Wave 0: spikes (done, 9/10)

**Review rounds:** 6.5 → 8 → 8.5 → 8.5 → 9. The reviewer was an independent Opus subagent, and each round it re-ran the spikes itself.

**Built**
- Agent adapters for Claude Code and Codex (`src/agents/`), plus a scrubbed environment for agents and for app code (`env.ts`).
- Fixture A, a web app with Postgres, login, settings and a two-step form, with its own Toolkit (`fixtures/a-web/.kitchen/toolkit/`).
- An engine-side drive interpreter (`src/proof/drive.ts`).
- A hash-chained, HMAC-signed evidence manifest with a floor that blocks rollback (`src/proof/manifest.ts`).
- Port slots shared by every repo on the machine (`src/toolkit/slots.ts`).
- One helper for every engine git call (`src/engine/git.ts`).
- The `kitchen mcp` engine bridge (`src/bridge/mcp.ts`).

**Proven by running (spikes in `spikes/w0/`, all of which check their own results)**
- On both tools, from inside a real agent session:
  - pushing fails over a file path, SSH and HTTPS, and the keychain is never used;
  - `gh` shows no login;
  - writes to job state and to `.git` fail, from the shell and from the file tools;
  - direct network access fails;
  - the role file comes back through `.kitchen-out/`;
  - a detached process outlives the call;
  - max turns, timeout and resume work.
- Docker can't be reached from either sandbox, so the Toolkit always runs in the engine (ADR 0006).
- The Toolkit contract: prepare, up (about 1 s from a snapshot), doctor, reset, down, two slots side by side, and three real flows with no new primitive. All 52 of the spike's checks pass.
- Evidence integrity: an edited, dropped or reordered entry is refused, and so are a replaced file, a forged head and a rolled-back job.
- Attacks are refused: a drive overriding engine flags, `http` to another site, a `.git` redirect or a hook or filter in the worktree, and a `git` binary planted on PATH.
- The bridge works on both tools; Codex needs `default_tools_approval_mode="approve"`.

**Deferred, and documented**
- There's no OS sandbox for the app's own processes. App code runs as the user, so it could read `$KITCHEN_HOME` or edit job state. It gets no credentials through env vars, and running it under a sandbox is the first hardening item.
- `kitchen run --detach` started from the user's own session is not yet proven (Wave 2).
- In the last Codex rerun the model chose not to attempt rewriting `.git` with its file tool. The previous round showed that attempt being refused.
- Linux sandboxes are untested.

## Wave 1: engine skeleton (done, 9/10)

**Review rounds:** 7 → 8.5 → 9. The reviewer was an independent Opus subagent, and each round it re-ran the spikes itself and tried its own break tests.

**Built**
- `src/config.ts`: the kitchen.yaml schema.
- `src/engine/machine.ts`: the full transition table as one data table, plus a pure `move()`. Every row has a legal and a refused test.
- `store.ts`: job storage, validated by a zod schema; a corrupt job is listed and skipped.
- `lock.ts`: a run lock written atomically, with a heartbeat.
- `runner.ts`: slots, `--once` and `--detach`. It checks the lock before each dispatch, each role run and each move.
- `src/procs.ts`: every agent, check and per-job Toolkit call runs in its own process group, recorded on disk. On resume those groups are killed, and so are orphaned bridge checks.
- Eleven thin stage handlers.
- Ledger, prompt tickets, local and fake forges.
- CLI: `ticket`, `run`, `status`, `resume`, `feedback [--to]`, `reject`, `report`.
- A bridge `checks` tool that runs with the untrusted env.
- ADR 0007: feedback goes back to the stage the job escalated from, and never past it or past verify.

**Proven**
- Spikes, run with a fake adapter:
  - stage paths: 54/54;
  - kill and resume: 34/34, including a real agent subprocess and a SIGKILLed bridge;
  - faults: 27/27, covering corrupt jobs, a torn worktree, an empty lock, a lost lock, refused human commands, a torn ledger and torn process records;
  - `--detach`: 8/8;
  - bridge checks: 7/7.
- Real calls: one each on Claude and Codex, plus a Codex smoke run on fixture A.
- `npm test`: 228/228.

**Still stubs, swapped in at W3a and W3b:** the guards that read a role's file instead of evidence (repro on base, drives resolve, verify verdict, toolkit check), the base sync and fresh instance, the engine-owned Toolkit checkout, and the GitHub forge.

**Known gap:** when the loop stops because it lost the lock, it frees the slots of stages that are still finishing.


## Wave 2: Toolkit and setup (review fixes done, awaiting re-review)

**Built**
- `src/toolkit/contract.ts`: zod schemas for every command's JSON line and `describe` (`contract: 1`, surface, primitives, features, `seed_users`, externals, `ports.needs`, parallel), and the parser for a feature file's `kitchen` block (mapped `paths`, `check` args).
- `src/toolkit/check.ts`: `kitchen toolkit check [--feature x] [--src dir]`: describe, feature files, prepare (timed), up, doctor, every check drive through the engine's interpreter (stamped into `.kitchen/checks/<run>/`), reset, the drives again, a second slot at once, down, evidence verified against the signed head; writes `.kitchen/toolkit.proven`.
- `src/toolkit/checkout.ts`: the engine-owned checkout `.worktrees/_toolkit@<sha>`, `prepare` cached per sha and source, GC of unreferenced checkouts.
- `src/toolkit/reproof.ts`: the base-change re-proof the runner calls before taking new work (full check if Toolkit or mapped paths changed, else doctor + smoke drive; a failure pauses the queue and files one Toolkit ticket).
- `toolkit-template/`: generic `bin/dev` (contract v1), helpers, optional browser and terminal modules, `app.mjs`/`SKILL.md`/`features/` to fill in.
- `roles/setup.md` (port of pstack's create-verification-skill, MIT, credited), `src/init/` (`kitchen init`, resumable, survey → ≤3 questions → build → engine commit on `kitchen/setup` → check → ≤2 fix rounds; `--answers`, exit 3 without a TTY, `--generate-only`), `kitchen setup-mcp` (the setup role's bridge), `skills/kitchen/SKILL.md`.
- Fixtures B (Python CLI + SQLite), C (fixture A's app with its own compose setup), D (API with a Stripe-shaped payment API and SMTP); none ships a Toolkit.

**Proven by running** (`spikes/w2/results.md`): `init` + `toolkit check` pass on A (regenerated from scratch), B, C, D on Claude Code (sonnet, medium effort: 103–264 s agent time, $0.42–$0.87 each) and on A, B, C on Codex (gpt-6-luna: 208–498 s); the no-TTY question flow and the base-change re-proof (`flow.ts`, scripted setup role, 26/26); superchat-lite generated in 229 s for $1.26 (generate-only: its stack is over this laptop's Docker budget).

**Review round 1 (fixed, `spikes/w2/results.md` "W2 review round")**
- Blocker: a `bin/dev` timeout waited on a stdout pipe a child held (146 s for a 2 s timeout). `runToolkit` now kills the process group and returns at once; `timeout.ts`.
- `toolkit check` passed a broken Toolkit: one JSON line per call, http(s) url, doctor with checks, `surface` enum, and a contract probe (every primitive, plus the refusals the contract requires); `probe.ts` (the reviewer's fake and each fault fail, named). The 7 generated Toolkits of A–D and fixture A's own still pass.
- Feature `paths` required and matched against tracked files; `parallel:false` enforced by the runner (no `kitchen.yaml` regex); an init re-run never says done without a passing full check.
- `kitchen init --detach` / `--status [--wait]`, and the skill polls it; secret scan before the setup commit; checkout leases; the setup bridge's `bin/dev` under macOS `sandbox-exec` (ADR 0008, Linux unhandled); `.env.kitchen` can't set `PATH`/`NODE_OPTIONS`/loader variables; prepare cached per lockfile hash and stall-killed after 5 silent minutes; `models.setup`; `kitchen toolkit up|down`.
- Real runs: a real survey asked a question (fixture E: which catalog the team uses) and the whole `/kitchen` setup ran inside `claude -p` (detach, poll, relay the question, answer on resume, done), about $1.14 on sonnet. Two findings from it fixed: Claude Code refuses `sleep 60` between polls (now `--status --wait`), and `--status` exiting 3 made the agent chain a fallback (now exit 0).
- New: `npm test` 250/250; spikes `timeout.ts` 6/6, `probe.ts` 14/14, `gc.ts` 6/6, `sandbox.ts` 9/9, `codex-sandbox.ts` 3/3, `flow.ts` 36/36, `inside.ts claude e` 11/11, `spikes/w1/paths.ts` 54/54.

**Open**
- Codex: the account hit its usage limit (until 2026-12-21) mid-run: D on Codex stopped after its survey, and the `/kitchen` setup inside `codex exec` (`inside.ts codex b`) has not run. What Codex needs approved is shown without a model (`codex-sandbox.ts`); that an execpolicy `allow` rule runs `kitchen init` outside the sandbox is unproven.
- The sandbox covers the setup bridge only; `toolkit check` after the commit and every job's Toolkit calls run unsandboxed (ADR 0006/0008). Linux has no sandbox at all.
- superchat-lite's Toolkit has never run (W3b's first step, on a machine with the Docker budget).
- Jobs still use the repo's own `bin/dev` (W1); moving them onto the engine-owned checkout comes with the smith and PR pinning (W3b).
- `toolkit up|down|maintain` are not built.
- `prepare` has no stall detection (a hung download waits for the 30-minute timeout).

## Wave 3a: proof and the core path (in review: round 1 6.5/10)

**Built**
- `src/proof/assert.ts`: mechanical `expect:` matchers (`ok`, exit code, `text "…" visible`, contains, JSON path into the output or a `$var`, row count, `$var` comparisons, `and`). `src/proof/proof-line.ts`: the `proof:` line parser. `src/proof/prove.ts`: one criterion's proof through `kitchen drive` (toolkit segments via runDrive, cmd/test via stampCommand), then assert. `kitchen drive <job> <C> [--repro] [--arg k=v]…` on the CLI.
- `src/checks/spec-lint.ts` (all six rules, for spec.md and a low-risk ticket's inline criteria), `feature-lint.ts` (no code in a feature file; no job changes an existing drive), `gate.ts` (checks pinned to HEAD), `verdict.ts` (mechanical by the engine, judged per criterion with citations stamped for this HEAD/round/criterion by the engine or the verifier; manifest verified; `--args` deltas carried). `risk-floor.ts` gained tests.
- Real stages: intake, spec, repro (`--repro` on a fresh app from the base plus only the repro's files; the builder may not edit them), build (layer rules: no Toolkit file, protected path or repro file), gate, drives (resolve, lint, `toolkit check --feature` as reset/run/reset/run, the verifier writes only what is missing), verify (fresh `up`, every proof by the engine from seed state, resumable after kill -9, then the verifier for `judged` only). `src/engine/instance.ts`: prepare/up/down/reset for the job's slot.
- Roles: `roles/intake.md`, `spec.md`, `builder.md`, `verifier.md` (modes drives, repro, verify), `_proofs.md` (the shared format reference). `.kitchen/roles/<role>.md` overrides.
- Bridge: `drive {criterion}` runs a criterion's whole proof; `restart_app` for the builder; verifier `--args` deltas logged.

**Proven** (`spikes/w3a/results.md`): a feature and a bug ticket end to end on fixture A, on Claude Code and Codex, plus a styling ticket whose judged criterion a real verifier judged on both; forged, stale and self-check citations refused; a drive with code refused; builder edits to the Toolkit, the repro and kitchen.yaml stripped; kill -9 mid-Verify resumes without re-running a decided proof. `npm test` 251/251.

**Open:** `toolkit check --feature` is this wave's own check through the W1 seam until W2's `check.ts` merges; INCONCLUSIVE→paused and Verify TOOLKIT-GAP are unit-tested only; W1 `paths.ts`/`kill.ts` part 1 depend on the old stubs.

- `toolkit maintain` is W4.

**Review round 1 fixes** (`spikes/w3a/results.md` "Review round 1 fixes", PLAN "Changes from the Wave 3a review"): strict `GAP:` names (free text is a failed drives write / INCONCLUSIVE); the drives check runs each affected criterion's whole proof twice and drive files must pass W2's feature rules; negative expects need a creating step and fail on error pages, failed responses and empty reads; every mechanical criterion runs on the base first (`base-check.json`, one spec retry, NON-DISCRIMINATING flag); the builder can't touch `test` proof files, what Gate runs through or package.json `scripts`, and a seed/migration diff is high risk and listed for review; cmd proofs stay in the worktree, bridge results are redacted; cmd/test imply exit 0; a repro's timed-out wait counts only for the expect's own text; judged needs appearance/copy and a screenshot; `repro: true` only on bugs; a refused manifest is INCONCLUSIVE; `--save <var>` on a primitive proof segment (found by the real run). The W1 stub-bound paths are ported to fixture A (`spikes/w3a/paths.ts`: repro-retry, gap, bad-gap, inconclusive, backoff) and removed from `spikes/w1/paths.ts`.

**Proven:** the review's ticket ("admins see every user's projects with owner; regular users still see only their own") reached review on Claude with a negative criterion that creates bob's project first ($0.308; an earlier run, $0.583, found the `--save` gap), and the same spec FAILs a scripted builder that leaks every project. Codex not run: its account usage limit is reached until 2026-12-21. Attacks 26/26 (role-rule self-check case added), kill 8/8, paths 24/24, W1 paths 34/34. `npm test` 274/274, typecheck and lint clean.

**Still open:** Codex re-run of the admin ticket; W2's sandbox-exec for cmd/test proofs (marked `// W2 sandbox:` in `prove.ts`); `toolkit check --feature` remains this wave's chain check until W2's `check.ts` is wired in; ready/report (W3b/W4).
