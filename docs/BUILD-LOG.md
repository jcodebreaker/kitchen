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
