# Kitchen starts each lane itself

**Status.** Accepted, 2026-11-24, by the user on a call ("Yeah, that works"). Replaces the orchestrator session of ADR 0016 §1 for `kitchen run`; keeps ADR 0023 (per-lane models), 0025 §3 (the preflight) and 0029 §5 (sessions in their own process group).

## Why

1. **A finished lane waits for the slowest one.** `kitchen run` starts one headless `claude -p` session that runs the /kitchen skill. It starts the lanes of a wave as several Agent calls in one message, and their results come back only when all of them have returned. A lane that finished early can't be finalized (`kitchen job finish`) until then:
   - its card says "running" after its agent is done;
   - its slot stays held, so the next queued job can't start until the slowest lane of the batch ends.
2. **Codex can't run the queue headless.** `kitchen run` refuses `agent.tool: codex`: Codex has no subagent tool for an orchestrator session to start lanes with.
3. **The queue is code already.** Which lanes start (`planWave`), what each gets (`kitchen job start`) and what happens after (`kitchen job finish`) are Kitchen's verbs. The orchestrator model only calls them in order, at a cost, and can drift from the order.

## Decision

1. **`kitchen run` is a Node scheduler, with no orchestrator model session.** It loops:
   - plan the wave (`kitchen job next`);
   - for each `start` entry, open the lane as `kitchen job start` does, which returns `{ prompt, model, cwd }`;
   - start one agent session for that lane, in its own process group (`runAgentSession`, ADR 0029 §5);
   - the moment a session ends, run `kitchen job finish` for its job, plan again at once, and fill the free slots. It never waits for the other lanes.
2. **The tool is the one `agent.tool` names, with the lane's model** (ADR 0023):
   - Claude Code: `claude -p <prompt> --model <m> --permission-mode acceptEdits --allowedTools … --output-format stream-json --verbose`, plus `--max-budget-usd` under `--max-usd`.
   - Codex: `codex exec --json -m <m> --sandbox workspace-write --skip-git-repo-check -C <checkout> --add-dir <job folder> [--add-dir <commit paths>…] <prompt>`, started in the lane's checkout. Never `--dangerously-bypass-approvals-and-sandbox`.
     - The job folder is writable for the lane's files.
     - A Build commits. Its checkout is a git worktree whose `.git` file points into `<repo>/.git/worktrees/<name>`, which workspace-write keeps read-only under the root. So exactly the paths a commit writes are writable roots of their own: that worktree git dir (index, HEAD, its reflog), `objects/`, and `refs/heads/kitchen/` with `logs/refs/heads/kitchen/` (the job branch's ref and reflog; git writes `<ref>.lock` and renames it, so the folder). Never the rest of `.git`: its config (`core.hooksPath`, `core.fsmonitor`), `hooks/`, `packed-refs`, other branches. A narrower root wins over the checkout's carve-out on both sandboxes (macOS allows the union of the roots' rules; Linux binds roots shallow to deep).
     - QA and the merge check drive the app on localhost: `-c sandbox_workspace_write.network_access=true` for those lanes only.
     - Codex reports tokens, not dollars: a run with a budget says no cap applies, and the ledger keeps each lane's tokens.
     - The worktree's git dir is writable, so a lane could point its `commondir` at a git dir of its own, or add a `config.worktree`, and Kitchen's own git there would read hooks and config from it. So finish refuses a lane whose worktree's `commondir` no longer names the repo's git dir (`git rev-parse --git-common-dir`), whose `gitdir` no longer names the worktree, or whose `config.worktree` is new or changed since the lane opened (its hash is recorded then: `git worktree add` writes one in a sparse checkout). Kitchen's git in a linked worktree names that worktree's git dir outright (`GIT_DIR`, from its `.git` file, which the sandbox keeps read-only), and only that: `GIT_COMMON_DIR` would reach the person's hooks, and a hook's own `git -C <another repo>` would land in this one.
     - Other jobs' `kitchen/<id>` branches are writable too (the folder). Each lane records their tips when it opens; finish refuses it if one moved while no lane of that job worked.
     - Claude Code's guard hooks don't run for Codex: the sandbox, those roots and Kitchen's checks at finish guard it.
     - What the sandbox limits is where a lane writes, not what its code does: Kitchen runs the repo's checks (and the app) on the lane's code, unsandboxed, after Build and before a merge, as it always has. A lane can put anything in that code.
   - `agent.command` still replaces the binary. Each session starts in the repo, so the repo's guard hooks load, and its prompt tells it to `cd` into its checkout (as a lane subagent did). Its environment names its job (`KITCHEN_JOB`): the hooks bind it from there, since a top-level session has no subagent id. `kitchen run` brings the repo's installed hook scripts up to date before it starts, so the binding is there.
   - A lane session has no Agent or Task tool: it is the lane's one agent.
3. **`job.running` says what is true.** While a lane runs, `running.session` holds its pid and process start. When the session ends, `running.session.ended` is set, then finish runs and clears the lane. The dashboard shows a lane whose session ended but isn't finished as "Finishing". Finish is fast; the state covers a crash in between.
   - A session that crashed and left no files goes through the existing refusal path: finish refuses, the lane runs again, three refusals go to a person.
   - On start, `kitchen run` ends any lane group a gone run left alive and restarts stranded lanes (`--restart-stranded`): one whose session is gone, or one opened with no session (an in-session orchestrator's subagent) whose activity stream, which the activity hook appends to on each of its tool calls, has been quiet for 10 minutes while that orchestrator's heartbeat is older than 15 minutes, however long its wave takes. A lane `kitchen run` opens is claimed for its session at once (a placeholder session), so an in-session restart leaves it while the run's lock lives. `kitchen run`'s own plans mark the heartbeat as its own, `kitchen job start` and `finish` from a session refresh it, and the dashboard shows "Finishing" only while the run lives.
   - `finish` takes the lane run's key (`kitchen job start` returns it; `kitchen job finish --key`): a lane another run opened since is refused, untouched. `start` checks and claims the lane in one write under the job lock.
   - **A tool that fails before any work** (not signed in, a rate limit, a model it doesn't know, no network): a session that ends non-zero, or with an error result, before any message or tool call. The lane stays open and isn't finished (no try is spent), and the run stops with the tool's last line: "Nothing more started". Three lane sessions in a row that crash (non-zero, no final line) stop the run too.
   - **The person stopped it.** When `kitchen stop` or `kitchen remove` ended a lane's session (its lane is closed or another's now), the run says "stopped by the person" and goes on: no crash, no early death, no finish.
   - **Kitchen's own git.** Every git call Kitchen makes runs with `core.fsmonitor=false`. The person's repo hooks (pre-commit, husky) still run on Kitchen's commits and merges, as before: a Codex lane can't write `.git/hooks` or the config, and a Claude lane can run any shell anyway, so disabling hooks would change the repo's behaviour and protect nothing. (A check at finish for a bare `update-ref` on the target, base or main was tried and dropped: a Codex lane can't write those refs, and the check only burnt tries.)
4. **Logs and cost.** Each session's stream goes to two places:
   - `.kitchen/jobs/<id>/rounds/<n>/<lane>.jsonl`, raw and appended, for debugging;
   - the lane's activity stream (`running.stream`), each line stamped with `_t`, which the dashboard's Activity tab and live line read.

   A session's cost, from its result line, goes into the ledger as a `session` line under its job and lane. The dashboard's cost sums those, as it summed the orchestrator's, and each card shows its own job's.
5. **What stays.**
   - run.json and the heartbeat: run.json names the scheduler, while it lives. One run per repo is decided first, by `.kitchen/run.lock`: exclusive, held for the scheduler's life, written whole (a temp file linked into place) and taken over only from a dead owner or a garbled file. Owners are told apart by pid and process start, read in the C locale and UTC whatever the caller's (a dashboard's wake and a terminal must read the same text). Two runs started together never both start lanes. `--detach` doesn't take it: its child does, and the parent waits up to 5 s for that, and says "already running" if the child found one.
   - `--max-usd` is the run's budget. Each lane, once opened, holds a reserve: what is left split over the lanes still to start in the wave (intakes too), at least $0.25 (or the whole budget when that is less), passed as `--max-budget-usd`. Its result line replaces the reserve with what it spent; a session cut off before its result counts its whole reserve; either way the reserve is given back when the session ends. While less than $0.25 is left nothing new starts ("budget left $X is below what a lane needs"), and starts again when a reserve comes back. A lane that reaches its share (`error_max_budget_usd`) is cut off, not failed: it stays open, no try is spent, and nothing new starts in this run.
   - `--detach`, and the preflight of ADR 0025 §3 and 0029 §4.
   - `--stop` ends the scheduler (with its group when it leads one), which ends every lane's group, then any lane group still alive; `--stop`, `kitchen stop` and `kitchen remove` wait for each group to go, and SIGKILL what is left. A group is ended only while its pid's process start matches. A lane cut off stays open and the next run restarts it; one whose agent had already sent its final line is finished by the next run.
   - `kitchen stop <id>` and `kitchen remove <id>` close the lane first, then end its session, so its result is dropped as before, and now the agent stops at once.
   - The drained sweep of ADR 0029 §5.
   - Steering reaches the next lane through `kitchen job start`, unchanged.
6. **`/kitchen run` in a session the person opened works as before**: that session is the orchestrator and starts lane subagents, for watching live. The skill and the README say that `kitchen run` (the CLI) is the headless default.

## Not chosen

- **Background Agent calls in the orchestrator session** (`run_in_background`): a lane's result still comes back through the model's turn, and a headless session that ends its turn stops the run. The model stays in a loop that code runs exactly.
- **One `kitchen run` process per lane**: one scheduler holds the budget, the slots and `--stop` in one place.
- **Keeping the orchestrator session and adding a watcher that finishes lanes**: two things would move jobs, and the session's view of the wave would go stale.
