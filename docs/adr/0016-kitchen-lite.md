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
- `/kitchen run`, inside Claude Code (or Codex), is the orchestrator. It reads the queue, plans what can run in parallel (respecting dependencies between tickets: a ticket's `AFTER:` line; see the 2026-11-23 amendment), and spawns one agent per lane: intake, build, QA, review. It moves each job through those lanes.
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

## Amendment, 2026-11-23: file overlap no longer holds a job

A paid run on library-demo (a renew-loan endpoint and a React UI, both touching `server.js` and `README.md`) held job 002 until 001 merged, which doubled the wall time. Now:
- Only an explicit dependency holds a job: a ticket's `AFTER:` line (intake writes it when the ticket builds on another job). Intake's `FILES:` is a hint, not a lock.
- Jobs touching the same files build side by side. Git merges each into `staging`; a conflict (or red checks on the merged result) sends the job back to Build, as before.
- Every Build round after the first starts with Kitchen merging `staging`'s tip into the job branch: committed when clean, left in progress for the builder to resolve when it conflicts. `kitchen job finish` refuses a build whose branch doesn't contain that tip, and the job's base moves to it, so review and the diff size see only the job's own change.

## Amendment, 2026-11-23: fresh data between QA's checks

In the same run the app kept its state in a gitignored `data/library.json` and `kitchen.yaml` had no `app.reset`, so QA deleted the file by hand and one criterion ran on data an earlier check had changed. Now:
- `kitchen init` takes the reset from a `db:reset`, `reset`, `reset:db`, `seed:reset`, `db:seed` or `seed` script (or Makefile target); without one it leaves `app.reset` unset and says how to add it.
- `kitchen qa reset <job>` is down, `app.reset`, up. The QA role uses it before a criterion that needs seed data and never touches the app's data files itself; with no `app.reset` the command says the data isn't fresh and QA notes it.
- Not chosen: a per-instance data directory in an env variable (app-specific), or deleting gitignored files Kitchen didn't create (it can't tell the app's data from dependencies and build output).

## Amendment, 2026-11-23: intake sees the queue

A 4-ticket run on library-demo overlapped: intake for "let people search books" added a page search box the ticket never named, and intake for "show my overdue loans in red and add a search box" planned a second one while its builder recomputed overdue on the server, which job 001 already did. That job conflicted twice and used all 3 rounds. Now:
- The intake brief has "Other jobs in the queue": every other unfinished job and the last few merged (7 days, at most 5), with id, title and stage, plus criteria, FILES and LEFT OUT once accepted, or the ticket text while still in intake (a wave's intakes run side by side). Capped at about 3,500 characters.
- The intake role doesn't promise what another job covers: `AFTER: <id>` when it needs that job's code, or `LEFT OUT:` naming the job. A ticket worded about behaviour gets the API only unless it names a page.
- The build brief lists its AFTER: jobs and whether they are merged, so the builder reuses their code.

## Amendment, 2026-11-23: intake is never held for room

In the same run, with `parallel: 3`, the planner gave free slots downstream first, so job 004 waited about 4 minutes for an intake agent while 001–003 held every slot. Now every job in intake starts in the next wave, even past `parallel` (intake is short and read-only); intake lanes, running or starting, still take room, and review, QA and build share what is left, downstream first. The default `parallel` is 4. Not chosen: a reserved intake slot (one slot still queues a burst of tickets behind each other).
