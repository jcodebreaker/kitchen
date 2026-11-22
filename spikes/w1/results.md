# W1 results

Run on 2026-11-22, macOS, Node 26.9, git 2.39, Claude Code 2.1.330, Codex CLI 0.171.0. Rerun with `README.md`.

| exit check | result | evidence |
|---|---|---|
| Scripted jobs walk every stage path (fake adapter) | **PASS** 47/47 | `paths.ts`, paths below |
| Every refused move prints its reason | **PASS** | 9 refusals across the runs, each `<id>  refused <from> → <to>: <reason>` or `refused no move <from> → <to>` |
| kill -9 mid-stage, restart, resume, no duplicate side effects | **PASS** 20/20 | `kill.ts`, below |
| `run --detach` survives its shell, `status` shows it | **PASS** 8/8 | `detach.ts` |
| Builder `checks` tool on `kitchen mcp` | **PASS** 7/7 | `bridge-checks.ts` |
| Real smoke, Claude haiku | **PASS** 5/5 | 1 call, 8.5 s, $0.0021, 24k in / 1.5k out tokens |
| Real smoke, Codex gpt-6-luna | **PASS** 5/5 | 1 call, 23.8 s, 117k in (mostly cached) / 0.9k out tokens |
| Unit tests (machine, config, ledger, store paths) | **PASS** 182 tests | `npm test`; the machine test fails if any table row lacks a legal or a refused case |

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
| INCONCLUSIVE: free retry, paused(toolkit-ticket), twice more → needs-human, feedback | intake → build → gate → drives → verify → verify → paused → verify → verify → needs-human → build → gate → drives → verify → review → ready → report → done |
| round limit, needs-human → feedback, done → build | intake → build → gate → build → gate → build → gate → needs-human → build → gate → drives → verify → review → ready → report → done → build → gate → drives → verify → review → ready → report → done |
| rejected from intake | intake → rejected |
| rejected from needs-info (`kitchen reject`) | intake → needs-info → rejected |
| needs-info answered (`kitchen feedback`) | intake → needs-info → intake → rejected |
| BLOCKED, feedback, BLOCKED, `kitchen reject` | intake → build → needs-human → build → needs-human → rejected |
| two failed drive attempts | intake → build → gate → drives → drives → needs-human |
| READY with nothing committed | refused twice (`build → gate: nothing committed on the job branch`) → needs-human |
| three jobs, concurrency 2 | all done; job 3's first move (ledger line 4) comes before job 1 is done (line 36) |

Details checked along the way: the gap job's `toolkitRef` is pinned (`6724d7ac0920`), each Toolkit PR and the Toolkit ticket is filed once, the round-limit refusal reads `gate → build: round limit: 3 of 3 rounds used`, rounds after feedback continue at 4 and 5 (budget reset, stamps never reuse a round number), a verify citing evidence from an older HEAD is refused (`a cited id is not stamped for this HEAD, round and criterion`), a backoff job stays paused until its `until`, `kitchen feedback` on a `rejected` job is refused (`no move rejected → build`), `kitchen resume` on a job that isn't paused says why.

## Kill and resume (`kill.ts`)

The fake verifier hangs in the drives stage (after build committed and published, after gate stamped `e1`); the spike kills the runner with SIGKILL, then appends one unsigned manifest line (`e2`, chained correctly, but past the signed head), which is what a crash between `appendEntry` and the `job.json` head write leaves. Then `kitchen run` again:

- `run: pid 2025, took over the run lock (owner pid 1738 is gone)`
- the dead runner's port slot is reclaimed with its own Toolkit's `down`
- `manifest: 1 unsigned line(s) past the signed head cut (kept in manifest.jsonl.tail-…)`; afterwards `kitchen verify` on the job: `{"ok":true,"entries":1}`
- `<id>  resume drives (interrupted …, pid 1738)`; the job finishes: intake → build → gate → drives → verify → review → ready → report → done, every move key once
- builder ran once (not re-run), the drives role twice (the killed call left no file), gate checks once
- fake forge: 1 PR created, 1 push, 1 comment, 1 evidence push; `filed` keys unique; ledger has `lock-takeover`, `resumed`, `manifest-truncated`
- run lock by heartbeat: a live owner with a fresh heartbeat keeps it (`kitchen run is already running (pid …)`); one whose heartbeat is 200 s old loses it (`took over the run lock (heartbeat 200s old)`)

## Detach (`detach.ts`)

`sh -c 'node src/cli.ts run --detach …; echo shell exits'` returns at once with `run detached: pid 2481, log …/.kitchen/run.log`. 1.5 s later the runner is alive with ppid 1 (its shell is gone); `kitchen status` shows `runner: pid 2481, heartbeat 2s ago, log …` and the job in `build`. The runner finishes the job, exits by itself, its log has every move, and `status` then says `runner: not running`.

## Bridge `checks` (`bridge-checks.ts`)

JSON-RPC over stdio to `kitchen mcp --job <id> --role builder`, started with a fake `GH_TOKEN` in its env. The checks run in the job worktree: one asserts `GH_TOKEN` is empty, `KITCHEN_UNTRUSTED=1` and `git push` is blocked by `kitchen-push-blocked` (exit 0), one fails with exit 3. Both are stamped `role: builder` at the worktree's HEAD with `stdout.txt`/`stderr.txt`/`call.json` in their own `e<N>/`; the fake token is in no evidence file; extra fields are refused; the verifier gets no `checks` tool (`unknown tool checks`).

## Real smoke (`smoke.ts`)

One ticket ("Add a CONTRIBUTING.md that tells contributors to run `npm test` …"), `kitchen run --once`: the intake role (read tier, no worktree yet) writes `intake.md` into its engine scratch outbox, the engine copies it into the job folder and deletes the outbox file, and the job moves one stage. Both tools rated it `DECISION: ACCEPT / KIND: chore / RISK: low` with inline criteria that passed spec-lint, so both moved **intake → build**. The repo was not touched. Agent calls used: **2** (one per tool).
