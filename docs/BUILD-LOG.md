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

## Wave 2: Toolkit and setup (built, awaiting review)

**Built**
- `src/toolkit/contract.ts`: zod schemas for every command's JSON line and `describe` (`contract: 1`, surface, primitives, features, `seed_users`, externals, `ports.needs`, parallel), and the parser for a feature file's `kitchen` block (mapped `paths`, `check` args).
- `src/toolkit/check.ts`: `kitchen toolkit check [--feature x] [--src dir]`: describe, feature files, prepare (timed), up, doctor, every check drive through the engine's interpreter (stamped into `.kitchen/checks/<run>/`), reset, the drives again, a second slot at once, down, evidence verified against the signed head; writes `.kitchen/toolkit.proven`.
- `src/toolkit/checkout.ts`: the engine-owned checkout `.worktrees/_toolkit@<sha>`, `prepare` cached per sha and source, GC of unreferenced checkouts.
- `src/toolkit/reproof.ts`: the base-change re-proof the runner calls before taking new work (full check if Toolkit or mapped paths changed, else doctor + smoke drive; a failure pauses the queue and files one Toolkit ticket).
- `toolkit-template/`: generic `bin/dev` (contract v1), helpers, optional browser and terminal modules, `app.mjs`/`SKILL.md`/`features/` to fill in.
- `roles/setup.md` (port of pstack's create-verification-skill, MIT, credited), `src/init/` (`kitchen init`, resumable, survey → ≤3 questions → build → engine commit on `kitchen/setup` → check → ≤2 fix rounds; `--answers`, exit 3 without a TTY, `--generate-only`), `kitchen setup-mcp` (the setup role's bridge), `skills/kitchen/SKILL.md`.
- Fixtures B (Python CLI + SQLite), C (fixture A's app with its own compose setup), D (API with a Stripe-shaped payment API and SMTP); none ships a Toolkit.

**Proven by running** (`spikes/w2/results.md`): `init` + `toolkit check` pass on A (regenerated from scratch), B, C, D on Claude Code (sonnet, medium effort: 103–264 s agent time, $0.42–$0.87 each) and on A, B, C on Codex (gpt-6-luna: 208–498 s); the no-TTY question flow and the base-change re-proof (`flow.ts`, scripted setup role, 26/26); superchat-lite generated in 229 s for $1.26 (generate-only: its stack is over this laptop's Docker budget).

**Open**
- No real survey asked a question; the question flow is proven with the scripted role only.
- superchat-lite's Toolkit has never run (W3b's first step, on a machine with the Docker budget).
- Jobs still use the repo's own `bin/dev` (W1); moving them onto the engine-owned checkout comes with the smith and PR pinning (W3b).
- `toolkit up|down|maintain` are not built.
- `prepare` has no stall detection (a hung download waits for the 30-minute timeout).

## Wave 3a: proof and the core path (built, awaiting review)

**Built**
- `src/proof/assert.ts`: mechanical `expect:` matchers (`ok`, exit code, `text "…" visible`, contains, JSON path into the output or a `$var`, row count, `$var` comparisons, `and`). `src/proof/proof-line.ts`: the `proof:` line parser. `src/proof/prove.ts`: one criterion's proof through `kitchen drive` (toolkit segments via runDrive, cmd/test via stampCommand), then assert. `kitchen drive <job> <C> [--repro] [--arg k=v]…` on the CLI.
- `src/checks/spec-lint.ts` (all six rules, for spec.md and a low-risk ticket's inline criteria), `feature-lint.ts` (no code in a feature file; no job changes an existing drive), `gate.ts` (checks pinned to HEAD), `verdict.ts` (mechanical by the engine, judged per criterion with citations stamped for this HEAD/round/criterion by the engine or the verifier; manifest verified; `--args` deltas carried). `risk-floor.ts` gained tests.
- Real stages: intake, spec, repro (`--repro` on a fresh app from the base plus only the repro's files; the builder may not edit them), build (layer rules: no Toolkit file, protected path or repro file), gate, drives (resolve, lint, `toolkit check --feature` as reset/run/reset/run, the verifier writes only what is missing), verify (fresh `up`, every proof by the engine from seed state, resumable after kill -9, then the verifier for `judged` only). `src/engine/instance.ts`: prepare/up/down/reset for the job's slot.
- Roles: `roles/intake.md`, `spec.md`, `builder.md`, `verifier.md` (modes drives, repro, verify), `_proofs.md` (the shared format reference). `.kitchen/roles/<role>.md` overrides.
- Bridge: `drive {criterion}` runs a criterion's whole proof; `restart_app` for the builder; verifier `--args` deltas logged.

**Proven** (`spikes/w3a/results.md`): a feature and a bug ticket end to end on fixture A, on Claude Code and Codex, plus a styling ticket whose judged criterion a real verifier judged on both; forged, stale and self-check citations refused; a drive with code refused; builder edits to the Toolkit, the repro and kitchen.yaml stripped; kill -9 mid-Verify resumes without re-running a decided proof. `npm test` 251/251.

**Open:** `toolkit check --feature` is this wave's own check through the W1 seam until W2's `check.ts` merges; INCONCLUSIVE→paused and Verify TOOLKIT-GAP are unit-tested only; W1 `paths.ts`/`kill.ts` part 1 depend on the old stubs.
