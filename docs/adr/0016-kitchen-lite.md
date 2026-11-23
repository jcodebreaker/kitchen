# Kitchen lite: one orchestrator session, guard hooks, Playwright QA, auto-merge to staging

**Status.** Accepted, 2026-11-22, by the user. This supersedes the parts of ADRs 0001, 0006, 0008, 0010 and 0015 that it removes.

## Why
On 2026-11-22 the user ran Kitchen and super-board on the same fresh copy of library-demo, with the same two plain-language tickets.

**super-board:**
- delivered both tickets in about 12 minutes, unattended;
- QA ran against the running server, and the UI ticket was checked in real Chromium;
- total cost $7.41.

**Kitchen:**
- delivered one ticket;
- the other stalled: an intake loop, a runner that stopped, the smith hand-writing a browser driver, then an engine error in the trust code;
- total cost $6.70.

Most of what broke was Kitchen's heavy machinery, not the idea. The user's call: "use the same and remove all heavy machinery not needed".

## Decision

### 1. One orchestrator session runs the queue
- `/kitchen run`, inside Claude Code (or Codex), is the orchestrator. It reads the queue, plans what can run in parallel (respecting dependencies between tickets, e.g. two tickets touching the same file), and spawns one agent per lane: intake, build, QA, review. It moves each job through those lanes.
- The `kitchen` CLI stays as the **single writer of job state**: `kitchen job …` verbs that refuse illegal moves (like the reference factory's `bin/job`). The orchestrator changes state only through them.
- The dashboard reads the same job folders.
- The plain-code runner loop and the `claude -p` / `codex exec` adapters are removed. `kitchen run` (a terminal command) becomes a thin wrapper that starts a headless orchestrator session, for people who aren't in Claude Code.

### 2. Guard hooks replace the OS sandbox
Every agent session runs with Claude Code hooks, as super-board does:
- no reading secret files (`.env*` except examples, ssh keys);
- no API-key literals written into files;
- no push to the base branch or `main`;
- no deleting outside the project;
- no working outside the job's worktree.

The hooks ship with Kitchen and are installed by `kitchen init`. Agents keep a scrubbed environment (no `GH_TOKEN` for agents; Kitchen's git helper pushes).

**Removed:**
- the macOS `sandbox-exec` profiles;
- the Docker guard proxy and the docker shim;
- forcing Claude Code's sandbox on agents, and the setup bridge it needed.

### 3. QA drives the real app with Playwright, with no Toolkit to build first
- `kitchen init` records how to start the app (start command, port, seed or reset command, health URL), detected from the repo like checks are, plus at most one short question.
- The QA lane starts the app from that, checks each acceptance criterion against the running app: HTTP for APIs, and Playwright (Kitchen ships and pins it) for pages, with screenshots. It writes plain evidence files.
- **Removed:**
  - the up-front Toolkit build;
  - the toolkit smith;
  - the contract and the double proof;
  - trust records, approved checkouts, approve/revoke and offers (ADR 0015's machinery);
  - `toolkit check`/`maintain`/`reproof`.
- Projects can still keep their own helper scripts, referenced from AGENTS.md.

### 4. Plain evidence
Each job folder keeps screenshots, logs, HTTP transcripts and the Report. The hash chain, the engine signing key and the evidence branch are removed. The Report still cites evidence by file.

### 5. Auto-merge to staging
- A job whose QA and review pass merges itself into a `staging` branch (created by init from the base). `--match-head-commit` pins the merge to the reviewed head, and the checks run again on staging first.
- Kitchen **never** pushes or merges to `main` or the base branch. The guard hook enforces it too.
- **High-risk jobs** (auth, payments, migrations, secrets, infra) and large diffs (over 400 changed lines) stop at Ready for a person.
- Local repos: merge into a local `staging` branch. GitHub: open the PR and merge it into `staging`.

### 6. What stays
- **Plain-language tickets:** intake writes the criteria, and the clarification thread (fix #12) stays.
- **The dashboard:** List and Board, steer/pause/stop, through the CLI verbs, which the orchestrator reads between steps.
- Quick `init`, the preflight, role skills (ADR 0014; the vendored security review stays), and the Report.

## Consequences
- Much less code and much faster setup. QA works on any app with a start command.
- Weaker isolation: guard hooks stop accidents, not a determined, injected agent. The README's safety section says so plainly.
- Merges to `staging` happen without a person; `main` stays human-only.
- Running the queue needs an orchestrator session: Claude Code open, or `kitchen run` starting a headless one.
- Signed evidence is gone: proof is plain files, and their integrity rests on QA running in its own lane.
