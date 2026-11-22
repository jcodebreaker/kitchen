# W1 results

Run on 2026-11-22, macOS, Node 26.9, git 2.39, Claude Code 2.1.330, Codex CLI 0.171.0. Rerun with `README.md`. Last full rerun after the Wave 1 round-2 review fixes (see "Review fixes" below).

| exit check | result | evidence |
|---|---|---|
| Scripted jobs walk every stage path (fake adapter) | **PASS** 54/54 | `paths.ts`, paths below |
| Every refused move prints its reason | **PASS** | 5 refusals across the runs, each `<id>  refused <from> → <to>: <reason>` or `refused no move <from> → <to>` |
| kill -9 mid-stage, restart, resume, no duplicate side effects, no orphaned agent or check | **PASS** 34/34 | `kill.ts`, below |
| Faults: refused human commands, corrupt job, half-made worktree, engine-error, empty lock, torn ledger, lost lock, torn procs record | **PASS** 27/27 | `faults.ts`, below |
| `run --detach` survives its shell, `status` shows it | **PASS** 8/8 | `detach.ts` |
| Builder `checks` tool on `kitchen mcp` | **PASS** 7/7 | `bridge-checks.ts` |
| Real smoke, Claude haiku | **PASS** 5/5 | 1 call, 8.5 s, $0.0021, 24k in / 1.5k out tokens (before the review fixes) |
| Real smoke, Codex gpt-6-luna | **PASS** 5/5 | 1 call, 23.8 s, 117k in (mostly cached) / 0.9k out tokens (before the review fixes) |
| Codex smoke on fixture A (PLAN §7), default `cheap` tier | **PASS** 6/6 | 1 call, gpt-5.6-luna, 33.7 s, below |
| Unit tests | **PASS** 228 tests | `npm test`; the machine test fails if any table row lacks a legal or a refused case |

## Stage paths (`paths.ts`, from the de-duplicated ledger)

| scenario | path |
|---|---|
| feature, medium (report refused once: unknown id `e999`) | intake → spec → build → gate → drives → verify → review → ready → report → report → done |
| chore, low (no spec, no review lens on a small diff) | intake → build → gate → drives → verify → review → ready → report → done |
| bug, medium (not reproduced once, then reproduced and committed) | intake → spec → repro → repro → build → gate → drives → verify → review → ready → report → done |
| bug, low, never reproduced | intake → repro → repro → needs-info |
| Toolkit gap round trips + paused(toolkit-pr) | intake → spec → toolkit → spec → build → gate → drives → toolkit → drives → verify → review → ready → paused → ready → report → done |
| rate limited once: paused(backoff) | intake → build → paused → build → gate → drives → verify → review → ready → report → done |
| CI pending: paused(ci) | intake → build → gate → drives → verify → review → ready → paused → ready → report → done |
| INCONCLUSIVE: free retry, paused(toolkit-ticket), twice more → needs-human, feedback returns to verify | intake → build → gate → drives → verify → verify → paused → verify → verify → needs-human → verify → review → ready → report → done |
| round limit, needs-human → `feedback --to build`, done → build | intake → build → gate → build → gate → build → gate → needs-human → build → gate → drives → verify → review → ready → report → done → build → gate → drives → verify → review → ready → report → done |
| judged criterion: PASS with no citation refused, then cited per criterion | intake → build → gate → drives → verify → review → ready → report → done |
| rejected from intake | intake → rejected |
| rejected from needs-info (`kitchen reject`) | intake → needs-info → rejected |
| needs-info answered (`kitchen feedback`) | intake → needs-info → intake → rejected |
| BLOCKED, feedback, BLOCKED, `kitchen reject` | intake → build → needs-human → build → needs-human → rejected |
| two failed drive attempts | intake → build → gate → drives → drives → needs-human |
| READY with nothing committed | refused twice (`build → gate: nothing committed on the job branch`) → needs-human |
| three jobs, concurrency 2 | all done; job 3's first move comes before job 1 is done |

Details checked along the way: the gap job's `toolkitRef` is pinned (`6724d7ac0920`; W1: a hash of `describe` output, W3b: the Toolkit PR's sha), each Toolkit PR and the Toolkit ticket is filed once, the smith's Toolkit primitive edits in the job worktree (`primitives.txt`, a new `bin/smith-extra`) never reach the job branch while its feature drive does, the round-limit refusal reads `gate → build: round limit: 3 of 3 rounds used`, a needs-human job remembers `escalatedFrom` (verify, gate), rounds after feedback continue at 4 and 5 (budget reset, stamps never reuse a round number), a verify citing evidence from an older HEAD is refused (`a cited id is not stamped for this HEAD, round and criterion (C1 cites e<N>, stamped for <sha>, not HEAD <sha>)`), a verify PASS with no citation for a `judged` criterion is refused (`(C2 is judged and cites no evidence)`) and the retry cites an entry the verifier stamped for C2, a backoff job stays paused until its `until`, `kitchen feedback` on a `rejected` job is refused (`no move rejected → build`), `kitchen resume` on a job that isn't paused says why.

## Kill and resume (`kill.ts`)

**Part 1, in-process fake agent.** The fake verifier hangs in the drives stage (after build committed and published, after gate stamped `e1`); the spike kills the runner with SIGKILL, then appends one unsigned manifest line (`e2`, chained correctly, but past the signed head), which is what a crash between `appendEntry` and the `job.json` head write leaves. Then `kitchen run` again:

- `run: pid …, took over the run lock (owner pid … is gone)`
- the dead runner's port slot is reclaimed with its own Toolkit's `down`
- `manifest: 1 unsigned line(s) past the signed head cut (kept in manifest.jsonl.tail-…)`; afterwards `kitchen verify` on the job: `{"ok":true,"entries":1}`
- `<id>  resume drives (interrupted …, pid …)`; the job finishes: intake → build → gate → drives → verify → review → ready → report → done, every move key once
- builder ran once (not re-run), the drives role twice (the killed call left no file), gate checks once
- fake forge: 1 PR created, 1 push, 1 comment, 1 evidence push; `filed` keys unique; ledger has `lock-takeover`, `resumed`, `manifest-truncated`
- run lock by heartbeat: a live owner with a fresh heartbeat keeps it (`kitchen run is already running (pid …)`); one whose heartbeat is 200 s old loses it (`took over the run lock (heartbeat 200s old)`)

**Part 2, a real agent subprocess.** `agent: { tool: claude, command: [<wrapper>] }` runs `stub-agent.ts` through the real Claude adapter. It hangs in drives; the runner is killed with -9.

- The agent ran as its own process group (pgid = its pid) and was recorded in `jobs/<id>/procs/<pgid>.json` (`{pgid, start, what, by, at}`).
- After the kill it was still running: the orphan the review found.
- The restart printed `<id>  killed agent verifier left running by pid <dead runner> (process group <pgid>)` **before** `<id>  resume drives`, and waited until the group was gone.
- The old agent is dead; `stub-agents.log` shows two starts of `drives.md` and one finish, and the second start saw no earlier run still alive (`overlap=` empty). Exactly one agent ran the stage to the end. The job finished and no `procs/` records were left.

**Part 3, a gate check.** A kitchen.yaml check that runs `sleep 600` (once) hangs the gate; kill -9. The check was its own process group and outlived the runner; the restart printed `killed check slow left running by pid … (process group …)`, `pgrep -g` finds nothing left in the group (shell and `sleep` both gone), and the job finished.

**Part 4, a check started through the bridge.** The stub builder starts the real bridge from its `--mcp-config` (a child in the agent's group, as Claude starts it), calls `checks` (one hangs in `sleep 600`), then SIGKILLs its own group: agent and bridge die without an exit handler, the check (its own group, recorded `by` the bridge) lives on. When the adapter returns, runRole prints `<id>  build: killed check slow left running by pid <bridge> (process group <check>)` before the retried builder starts; the check's group is empty (`pgrep -g`), the job finishes, no `procs/` records are left. With the reap commented out the same run fails 3 checks (the check outlives the stage).

## Faults (`faults.ts`)

- **Refused human commands change nothing.** `kitchen reject` ×3 on a job in build: each `refused no move build → rejected`, exit 1, and `job.json` byte for byte unchanged (no refusal counted, never needs-human); `kitchen resume` on it likewise. `kitchen feedback` ×3 on a done job: the first moves done → build, the next two are refused (`no move build → build`), the job stays in build with `attempts.refused` 0, and only the accepted feedback text is kept for the builder. The runner then finishes it.
- **Corrupt job.json.** One truncated, one with `"stage": "cooking"`, one good. `kitchen run` prints `<id>  corrupt (not JSON: …): skipped` and `<id>  corrupt (stage: Invalid option: …): skipped`, logs `corrupt` in the ledger, and runs the good job to done. `kitchen status` lists them as `corrupt(<reason>)`; `kitchen feedback` on one says `job … is corrupt (…)`.
- **Half-made worktree.** `.worktrees/<id>/` exists (a `.git` file pointing nowhere and a stray file) but job.json records no worktree: it is moved to `.worktrees/<id>.stray-<time>`, the worktree is made again, the job finishes, and the stray file is not on the job branch.
- **engine-error.** A job whose base commit doesn't exist: `git worktree add` fails, is retried once (`error (retried next tick)`), then `build → needs-human` with `engine-error: git worktree failed (exit 255): fatal: not a valid branch point …` and `escalatedFrom: build` (it was `adapter-error` before).
- **Empty run.lock.** A fresh empty lock file is waited on for its 2 s grace (2.0 s), then taken over (`took over the run lock (unreadable lock file)`); one empty for 10 s is taken over at once. The runner now creates the lock with temp file + `link()`, so a lock file is never empty while it is written.
- **Torn ledger line.** A ledger whose last line has no newline: the next append starts on its own line, and every line after the torn one parses.
- **Run lock lost mid-stage.** The `slow` builder is running when `run.lock` is rewritten to name another live process with a fresh heartbeat. When the builder returns: `<id>  build: run lock lost, left for the runner that holds it` and `run: lost the run lock to another runner, stopping`; job.json stays in build and the ledger has no move after the lock was lost; the lock still names its new owner; nothing was published (no PR, no push), but the builder's file and its `agentRuns` entry are kept. Once that owner is gone the next `kitchen run` takes the lock over, reuses the builder's file (one builder run), publishes once (1 PR, 1 push) and finishes the job.
- **Torn or start-less procs record.** Two live detached `sleep`s; one gets a torn record (`{"pgid":<pid>,"sta`), the other a record with `start: null`. `kitchen run` kills neither (a pgid alone can't tell the recorded group from one that reused the pid), removes both records, and runs the job to done.

## Detach (`detach.ts`)

`sh -c 'node src/cli.ts run --detach …; echo shell exits'` returns at once with `run detached: pid …, log …/.kitchen/run.log`. 1.5 s later the runner is alive with ppid 1 (its shell is gone); `kitchen status` shows `runner: pid …, heartbeat 2s ago, log …` and the job in `build`. The runner finishes the job, exits by itself, its log has every move, and `status` then says `runner: not running`.

## Bridge `checks` (`bridge-checks.ts`)

JSON-RPC over stdio to `kitchen mcp --job <id> --role builder`, started with a fake `GH_TOKEN` in its env. The checks run in the job worktree: one asserts `GH_TOKEN` is empty, `KITCHEN_UNTRUSTED=1` and `git push` is blocked by `kitchen-push-blocked` (exit 0), one fails with exit 3. Both are stamped `role: builder` at the worktree's HEAD with `stdout.txt`/`stderr.txt`/`call.json` in their own `e<N>/`; the fake token is in no evidence file; extra fields are refused; the verifier gets no `checks` tool (`unknown tool checks`).

## Real smoke (`smoke.ts`)

One ticket ("Add a CONTRIBUTING.md that tells contributors to run `npm test` …"), `kitchen run --once`: the intake role (read tier, no worktree yet) writes `intake.md` into its engine scratch outbox, the engine copies it into the job folder and deletes the outbox file, and the job moves one stage. Both tools rated it `DECISION: ACCEPT / KIND: chore / RISK: low` with inline criteria that passed spec-lint, so both moved **intake → build**. The repo was not touched. Agent calls used: **2** (one per tool).

**Codex on fixture A** (after the review fixes, `smoke.ts codex <scratch> a-web`): a copy of `fixtures/a-web` as the repo, `models: { intake: cheap }` and no model override, so the default tier map picked **gpt-5.6-luna**. Ticket: "Show the signed-in user's email in the settings page heading …". One call, 33.7 s; the agent read the app and answered `DECISION: NEEDS-INFO / KIND: feature / RISK: medium` with the question "Where should the signed-in user's email come from: the users table (requiring an email field and seed data), or should the existing username be treated/displayed as the email?" (the fixture's users have usernames, no email), so the job moved **intake → needs-info**. The outbox file was removed, the repo untouched, and the agent's `procs/` record gone after the call. Agent calls used: **1** (Codex), no Claude call.

## Review fixes (Wave 1 review)

| finding | fix | proof |
|---|---|---|
| Refused human commands escalated running jobs | `moveJob(…, by)`: a human command the table refuses logs the refusal and changes nothing; only runner proposals count toward twice-refused | `faults.ts` 1 |
| Orphan agents after kill -9 | `src/procs.ts`: agents, checks and per-job Toolkit calls spawn detached (own process group) and are recorded as `{pgid, start}` in `jobs/<id>/procs/`; `resumeAll` kills and waits for every live group before dispatching; a normal or SIGTERM exit kills the groups it started | `kill.ts` parts 2 and 3 |
| One corrupt job.json stopped everything | zod `JobSchema` (unknown stage rejected); `scanJobs` marks `corrupt(<reason>)`, `listJobs` skips it | `faults.ts` 2, `store.test.ts` |
| Backoff never grew | the counter is kept through a pause and its resume, reset by the first other move | `machine.test.ts` |
| Verify PASS with no citations | per-criterion `EVIDENCE C<n>: …`; every `judged` criterion needs ≥1 id stamped for this HEAD, round and that criterion | `paths.ts` judged + gap, `stages.test.ts` |
| Half-made worktree; wrong escalation code | an unrecorded folder is moved aside and the worktree made again; non-adapter errors escalate as `engine-error` | `faults.ts` 3, 4 |
| Empty run lock taken over at once | temp file + `link()`; an unreadable lock gets a 2 s grace | `faults.ts` 5 |
| Lost lock not checked | the runner checks the lock before dispatching (also under `--once`), before every role run and before every move | code (runner.ts, role.ts) |
| ready ignored gatePass | `ready>gate` row; ready proposes gate when the gate is no longer PASS on this HEAD | `machine.test.ts` |
| Toolkit edits leaked into the job branch | `stripToolkitEdits`: every job commit (and the toolkit stage) puts Toolkit files outside `features/` back as at HEAD; the rest is marked `// W3b:` | `paths.ts` gap |
| Ticket fence | `<<<TICKET-<nonce>` … `TICKET-<nonce>>>`, random per prompt, never a string in the ticket | `stages.test.ts` |
| needs-human → build skipped spec/repro | `escalatedFrom`; feedback returns there, `--to <stage>` overrides (ADR 0007) | `paths.ts` inconclusive, rounds; `machine.test.ts` |
| Torn ledger last line | append closes it with `\n` first | `faults.ts` 6 |
| Codex tier map | `cheap: gpt-5.6-luna` (same generation as `strong: gpt-5.6-terra`), configurable via `agent.models` | fixture A smoke |

## Review fixes (Wave 1 review, round 2)

| finding | fix | proof |
|---|---|---|
| MAJOR: `kitchen feedback --to` took any active stage (ready, report): a job could reach done without gate, drives or verify | `--to` only names intake, spec, repro, build, drives or verify, at or before `escalatedFrom` (build when none); the machine refuses others with the reason (`--to ready: feedback goes to one of …`, `--to build: it is past spec, where the job escalated from`) and the feedback text is not kept (ADR 0007) | `machine.test.ts` (legal: verify→build, report→drives, verify→verify, gate→intake, none→build; refused: spec→build, none→drives, gate/toolkit/review/ready/report from report); `paths.ts` rounds (`--to build` from gate) |
| A bridge check outlives its agent when the agent group is SIGKILLed | runRole, once the agent returns, reaps the job's `procs/` records whose owner (`by`) is dead (`reapGroups(dir, { deadOwners: true })`), logs `orphan-killed`; a live owner's records are left alone | `kill.ts` part 4 (fails without the reap) |
| A torn procs record (start null) killed whatever group had that pgid | records written with `writeAtomic`; a record that can't be read, or has no start time, is removed and nothing is killed; residual window (record written just after spawn) commented in `procs.ts` | `faults.ts` 8 |
| `setsid` escapes the process group | documented in the `procs.ts` header and ADR 0006 "Worktree code" residual risk | docs |
| No lost-lock spike | `faults.ts` 7; runRole now also checks the lock after the agent returns (the file is kept for the new owner), so a stage does nothing more (commit, publish) once the lock is lost | `faults.ts` 7 |

Seen while proving it, not changed: when the loop stops on a lost lock it does not wait for in-flight stages, so its `finally` releases their slots (`slot 0 released (build)`) while the stage is still finishing; the new owner's startup reap kills that runner's agents anyway.
