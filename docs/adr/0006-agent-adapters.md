# Agent adapters: exact flags, writable roots, and what W0 proved

Kitchen runs every role headless through one interface (`src/agents/adapter.ts`), with two real adapters (`claude.ts`, `codex.ts`) and a scripted one (`fake.ts`). Every agent gets a scrubbed environment built from an allowlist (`env.ts`). The writable root is enforced by each tool's own OS sandbox (Seatbelt on macOS), not by prompt. Docker is **not** reachable from inside either sandbox, so the Toolkit always runs in the engine, outside the agent (the PLAN §3 fallback). Measured on 2026-11-21 with Claude Code 2.1.330 and Codex CLI 0.171.0 (`npx -y @openai/codex@0.171.0`) on macOS; rerun with `spikes/w0/README.md`.

## Invocation

| | Claude Code | Codex |
|---|---|---|
| non-interactive | `claude -p`, prompt on stdin | `codex exec … -` (prompt on stdin) |
| structured output | `--output-format json`: one result object | `--json`: JSONL events (`thread.started`, `item.started/completed`, `turn.completed`, `turn.failed`, `error`) |
| model | `--model haiku` (alias or full name) | `--model gpt-6-luna` (cheapest listed in `~/.codex/models_cache.json`), `-c model_reasoning_effort="low"` |
| session id | pre-assigned: `--session-id <uuid>` (known even if the run is killed); echoed as `session_id` | `thread_id` of the `thread.started` event |
| resume | `--resume <id>` | `codex exec resume [opts] <id> -`. It has no `-C`/`-s`: the root is the process cwd and the sandbox comes from `-c sandbox_mode="workspace-write"` |
| usage | `total_cost_usd`, `usage.{input,output,cache_*}_tokens` | `turn.completed.usage.{input_tokens,cached_input_tokens,output_tokens}`. No dollars. Nothing if the run is killed before the turn ends |
| max turns | `--max-turns N` (hidden from `--help`, works); result `subtype: "error_max_turns"` | no flag. The adapter counts `item.started` of `command_execution`/`file_change`/`mcp_tool_call`/`web_search` and kills the process past N |
| wall clock | execa `timeout` + SIGKILL 5 s later | same |
| transcript | `~/.claude/projects/<cwd, non-alphanumerics → '-'>/<id>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` |
| isolation from the user's setup | `--setting-sources ""` `--strict-mcp-config` `--disable-slash-commands` (CLAUDE.md is still read) | `--ignore-user-config` (auth still from `CODEX_HOME`) `--ignore-rules` `--skip-git-repo-check` |
| rate limit | `is_error` + text matching rate/usage limit/429 | `turn.failed`/`error` message, same match |

`--bare` is not usable: it refuses OAuth/keychain auth, so subscription users could not run Kitchen.

## Tiers

**Claude Code**, both tiers: `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false}}' --permission-prompts none` (anything that would ask is denied; `allowUnsandboxedCommands:false` removes the `dangerouslyDisableSandbox` escape).
- `write`: `--permission-mode acceptEdits --tools Bash,Read,Edit,Write,Glob,Grep`. Edits inside the cwd are accepted; Bash runs sandboxed with writes limited to the cwd; network goes through the sandbox proxy, which allows no domain.
- `read`: `--permission-mode dontAsk --tools Read,Glob,Grep,Write --allowedTools Read Glob Grep 'Edit(//<out>/**)' 'Write(//<out>/**)'`, plus `--add-dir <out>` when the out folder is outside the cwd. No shell.

**Codex**, both tiers: `-c approval_policy="never" -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false -c sandbox_workspace_write.exclude_slash_tmp=true -c sandbox_workspace_write.exclude_tmpdir_env_var=true`. The writable root is the `-C` dir; everything else is read-only.
- `write`: `-C <worktree>`.
- `read`: `-C <out folder>`. The agent reads the repo by absolute path. `read-only` mode can't be used because it can write nowhere, not even the out folder.

**How the writable root is enforced:** Claude Code: the `sandbox` setting (Seatbelt) for Bash, the permission system for its file tools. Codex: the `workspace-write` sandbox (Seatbelt) for commands, and `apply_patch` refuses paths outside the project ("patch rejected: writing outside of the project"). A detached child inherits the sandbox on both.

The role writes its one file to `<cwd>/.kitchen-out/<file>`, or to an engine scratch dir for read roles without a worktree. The adapter deletes any stale copy before the run and returns `outPath` only if the file exists afterwards.

## Scrubbed environment (`env.ts`)

An allowlist (HOME, USER, PATH, SHELL, LANG/LC_*, TERM, TMPDIR, TZ, the tool's own auth and proxy vars), then: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<file with empty credential.helper>`, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=` (command scope, so it also beats a helper in the repo's own `.git/config`), `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, `GIT_SSH_COMMAND=false`, `GH_CONFIG_DIR=<empty dir>`, `GH_PROMPT_DISABLED=1`. No `GH_TOKEN`, `GITHUB_TOKEN` or `SSH_AUTH_SOCK`.

Claude's sandbox **replaces** `GIT_SSH_COMMAND` with its own proxy command, so on Claude Code it is the sandbox's network proxy, not our variable, that stops SSH.

## Integrity results (real runs, from inside the agent, scrubbed env)

The test repo has `.kitchen/jobs/` and a job worktree at `.worktrees/001-spike` (the agent's cwd), a throwaway bare remote beside it, and `credential.helper=osxkeychain` set in the repo's local config. A control run of the same probe with the scrubbed env and **no** agent/sandbox shows the file-remote push and the jobs write succeed, so the sandbox is what stops them.

| check | Claude Code | Codex |
|---|---|---|
| a. `git push` to a local bare remote | PASS: exit 1, "failed to push some refs", no branch created | PASS: same |
| a. `git push` to an SSH remote | PASS: exit 128 (sandbox proxy) | PASS: exit 128 (`GIT_SSH_COMMAND=false`) |
| a. `git push` over HTTPS | PASS: exit 128, "CONNECT tunnel failed, response 403" | PASS: exit 128, "Could not resolve host" |
| a. keychain not used | PASS: `git credential fill` exit 128, "terminal prompts disabled", no password | PASS: same |
| b. `gh auth status` | PASS: exit 1, "You are not logged into any GitHub hosts" | PASS: same |
| c. write into `.kitchen/jobs/` by shell | PASS: "Operation not permitted", `job.json` unchanged | PASS: same (`mkdir` too) |
| c. write into `.kitchen/jobs/` by file tool | PASS: "Permission … denied … no approval surface" | PASS: "patch rejected: writing outside of the project" |
| d. role file in `.kitchen-out/` returned | PASS | PASS |
| read tier: repo not writable, file in engine scratch dir returned | PASS ("running in don't ask mode") | PASS ("Operation not permitted") |
| e. detached process outlives the call | PASS: 4 beats at return, 8 seven seconds later | PASS: 8 → 11 |
| f. `docker version` inside the sandbox | FAIL: "permission denied … docker.sock" | FAIL: same |
| max turns stops the run | PASS: `error_max_turns` | PASS: killed at the 2nd command |
| wall-clock timeout | PASS: 4.4 s | PASS: 4.0 s |
| resume keeps context | PASS: same session id, right answer | PASS: same thread id, answered from context |

## Decisions that follow

- **Docker / the Toolkit run in the engine, never inside an agent sandbox, on both tools.** `codex sandbox --allow-unix-socket <docker.sock>` does reach Docker, and Claude has `sandbox.network.allowUnixSockets`, but the Docker socket is root-equivalent (`docker run -v /:/host`) and would void the writable root. Agents prove behaviour only through `kitchen drive`, which the engine runs.
- **A detached process keeps the sandbox of the session that started it** (its write outside the root got EPERM on both tools). So `kitchen run --detach` launched from a sandboxed session could not write `.kitchen/jobs/` or reach the network. The `/kitchen` skill must start it unsandboxed: on Claude Code, sessions are unsandboxed by default; on Codex the default `workspace-write` needs a one-time escalation approval for that command. W2 must prove this from the user's real session.
- **No network inside either sandbox.** Dependency installs belong to the Toolkit's `prepare`, which the engine runs.
- Agents can't `git commit` in a worktree either: its git dir lives in the main repo's `.git/worktrees/`, outside the root. That fits "the engine commits".

## Skill locations (`/kitchen`)

- **Claude Code:** `.claude/skills/<name>/SKILL.md` in the repo, also in nested folders between the repo root and the cwd. User level: `~/.claude/skills/`. It does **not** read `.agents/skills`. (Probed with one haiku call from a nested folder.)
- **Codex:** `.agents/skills/` in every folder from the repo root down to the cwd, and `<repo>/.codex/skills/`. User level: `~/.agents/skills/`. System: `$CODEX_HOME/skills/.system`. Plus plugin caches. It does **not** read `.claude/skills`. (Probed with `codex debug prompt-input`, no model call.)
- Kitchen installs `.claude/skills/kitchen/` and `.agents/skills/kitchen/`, with the same SKILL.md.

## Not verified

- `kitchen run --detach` from the user's own interactive session on each tool: only the role sandbox was tested. W2.
- Whether a user's login shell rc re-exports secrets. Codex runs commands through `zsh -lc`, and Claude snapshots the user's shell. Both showed no `GH_TOKEN` here, but a `.zprofile` that exports one would re-add it. `kitchen doctor` should run the probe.
- Codex `exec` with a Docker socket allowance through config (`network.allow_unix_sockets` exists in permission profiles). Not pursued, given the decision above.
- Linux (bubblewrap) behaviour of either sandbox.
- Rate-limit detection: only the text match is in place. No run hit a limit.
