# Agent adapters: exact flags, writable roots, and what W0 proved

> **Superseded by [ADR 0016](0016-kitchen-lite.md)** (Kitchen lite, 2026-11-22): what this records was removed. Kept as history.

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
| isolation from the user's setup | `--setting-sources ""` `--strict-mcp-config` `--disable-slash-commands` (CLAUDE.md is still read; the worktree's `.mcp.json` and `.claude/settings.json` are ignored, see "Bridge") | `--ignore-user-config` (auth still from `CODEX_HOME`; also drops project trust, so the worktree's `.codex/config.toml` stays disabled) `--ignore-rules` `--skip-git-repo-check` |
| engine bridge | `--mcp-config <json>` `--allowedTools 'mcp__kitchen__*'` | `-c mcp_servers.kitchen.*` incl. `default_tools_approval_mode="approve"` |
| rate limit | `is_error` + text matching rate/usage limit/429 | `turn.failed`/`error` message, same match |

`--bare` is not usable: it refuses OAuth/keychain auth, so subscription users could not run Kitchen.

## Tiers

**Claude Code**, both tiers: `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"filesystem":{"denyRead":["<KITCHEN_HOME>"],"denyWrite":["<cwd>/.git"]}},"permissions":{"deny":["Read(/<KITCHEN_HOME>/**)","Edit(/<cwd>/.git)","Edit(/<cwd>/.git/**)"]}}' --permission-prompts none` (anything that would ask is denied; `allowUnsandboxedCommands:false` removes the `dangerouslyDisableSandbox` escape; `denyRead` and the `Read()` deny rule keep Bash and the file tools out of `$KITCHEN_HOME`, the engine key's folder; `denyWrite` and the `Edit()` deny rules, which also cover Write, keep Bash and the file tools off the worktree's `.git`, file or folder, so an agent can't point the worktree at another gitdir, see "Engine git").
- `write`: `--permission-mode acceptEdits --tools Bash,Read,Edit,Write,Glob,Grep`. Edits inside the cwd are accepted; Bash runs sandboxed with writes limited to the cwd; network goes through the sandbox proxy, which allows no domain.
- `read`: `--permission-mode dontAsk --tools Read,Glob,Grep,Write --allowedTools Read Glob Grep 'Edit(//<out>/**)' 'Write(//<out>/**)'`, plus `--add-dir <out>` when the out folder is outside the cwd. No shell.

**Codex**, both tiers: `-c approval_policy="never" -c default_permissions="kitchen" -c 'permissions.kitchen.filesystem={":root"="read","<KITCHEN_HOME>"="deny",":workspace_roots"={"."="write"}}' -c permissions.kitchen.network.enabled=false`. The writable root is the `-C` dir (the workspace root); everything else is read-only, `$KITCHEN_HOME` is unreadable, there is no network. Codex itself keeps `.git` under a writable root read-only, also when it is a linked worktree's `.git` file: confirmed in the second integrity rerun (row g), no extra setting needed. Until the W0 review this was `-c sandbox_mode="workspace-write"` with `network_access=false`, `exclude_slash_tmp=true`, `exclude_tmpdir_env_var=true`; that mode can't deny reads, and Codex agents could read the engine key. The permission profile keeps the same writable root (checked with `codex sandbox -P kitchen`, no model call: workspace writable; `$KITCHEN_HOME`, `/tmp`, `$TMPDIR`, `$HOME` not; HTTPS fails) and the integrity run below was repeated with it.
- `write`: `-C <worktree>`.
- `read`: `-C <out folder>`. The agent reads the repo by absolute path. `read-only` mode can't be used because it can write nowhere, not even the out folder.

**How the writable root is enforced:** Claude Code: the `sandbox` setting (Seatbelt) for Bash, the permission system for its file tools. Codex: the `workspace-write` sandbox (Seatbelt) for commands, and `apply_patch` refuses paths outside the project ("patch rejected: writing outside of the project"). A detached child inherits the sandbox on both.

The role writes its one file to `<cwd>/.kitchen-out/<file>`, or to an engine scratch dir for read roles without a worktree. The adapter deletes any stale copy before the run and returns `outPath` only if the file exists afterwards.

## Scrubbed environment (`env.ts`)

An allowlist (HOME, USER, PATH, SHELL, LANG/LC_*, TERM, TMPDIR, TZ, the tool's own auth and proxy vars), then: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<file with empty credential.helper>`, `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=` and `GIT_CONFIG_KEY_1=url.kitchen-push-blocked:///.pushInsteadOf GIT_CONFIG_VALUE_1=` (command scope, so they also beat the repo's own `.git/config`; the second rewrites every push URL, including a plain local path, to an unknown transport, so `git push` fails while fetch works), `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, `GIT_SSH_COMMAND=false`, `GH_CONFIG_DIR=<empty dir>`, `GH_PROMPT_DISABLED=1`. No `GH_TOKEN`, `GITHUB_TOKEN` or `SSH_AUTH_SOCK`.

### Worktree code: `untrustedEnv`

Every process that runs code from a worktree (the app, its tests, cmd proofs, Toolkit primitives) gets `untrustedEnv(src)`: the same allowlist **without** the agent tool's auth, the same git/gh scrub, plus the worktree's `.env.kitchen` (fake values; the scrub wins over it). `toolkitEnv(src)` adds `DOCKER_HOST`/`DOCKER_CONTEXT` for `bin/dev` and names them in `KITCHEN_CONTROL_ENV`; `bin/dev` strips those before starting the app or the browser driver. `src/toolkit/run.ts` is the one place the engine runs `bin/dev`.

Proven by `spikes/w0/run-toolkit-spike.mjs` with a fake `GH_TOKEN` in the engine's env and an app whose startup runs `git push origin` (a local bare remote) and `gh auth status`:
- control, same probe with the engine's env: push exit 0 (branch created), `gh` sees `GH_TOKEN`;
- through `up`: `ps eww <appPid>` shows no `GH_TOKEN`, no fake token, no agent keys, no Docker or Kitchen control vars; push exit 128 (`'remote-kitchen-push-blocked' is not a git command`), no branch; `gh auth status` exit 1, "You are not logged into any GitHub hosts".

**Residual risk, later hardening:** this hands app code no credentials but does not confine it. cmd/test proofs and the kitchen.yaml checks now run under the proof sandbox (next section); the rest of app code does not: the app the Toolkit starts and the primitives of a merged Toolkit sha run as the user without a sandbox (they need Docker and the network, which the proof profile denies), and on Linux nothing is sandboxed. That code can unset these variables, read files under `$HOME` (including `~/.config/gh`, `~/.ssh`, and `$KITCHEN_HOME/engine.key`), reach the Docker socket by its default path, and write anywhere the user can, `.kitchen/jobs/` included. Nor are they confined in time: the engine runs every check and Toolkit call in its own process group and kills the group when the call ends or a dead runner's records are reaped (`src/procs.ts`), but a process that daemonises (`setsid`, a double fork into a new session) leaves the group and is never killed. An OS sandbox for app processes (Seatbelt / bubblewrap profile, or the app in a container) is the hardening item; it is not required for v0.1.

### cmd and test proofs and checks: the proof sandbox (W3a review rounds 2 and 3)

`cmd` and `test` proofs and the kitchen.yaml checks (Gate's, and the builder's `checks` bridge tool, which runs the same list) run code the builder wrote, as the engine, so they are the app processes Kitchen confines. On macOS `stampCommand(…, sandbox: true)` runs each as `sandbox-exec -f $KITCHEN_HOME/sandbox/proof-<hash>.sb sh -c …` (`src/proof/sandbox.ts`, built on W2's deny list from `src/toolkit/sandbox.ts`), with a profile written for that one run and removed after it: no network except loopback (bind/inbound on localhost, outbound to localhost only: `(allow network* (local ip …))` also matched outbound sockets and was dropped); writes only in the job worktree, a temp dir the engine makes fresh for the run (`kitchen-proof-*`, set as its `TMPDIR`, removed after), `/dev` and `~/.npm`. Not `/tmp` or `/var/folders` as a whole (round 2 allowed both): a repo that lives there would have let a proof write into every other job's worktree (round 3; `contain.ts tmp` proves the sibling write is denied and fails on the round-2 profile); nothing under `$HOME` readable except the worktree, the toolchains on `PATH` that live under `$HOME` (nvm, volta, pyenv…), the npm cache and the `package.json` files above the worktree (node fails on EPERM there); and, wherever they are, W2's credential paths, `$KITCHEN_HOME` (the engine key), the repo's `.kitchen/jobs/` and the repo's shared git config denied for reading and writing. Each entry is stamped `sandboxed: true|false`. Every evidence file a proof writes (stdout, stderr, `call.json`, a primitive's text output) goes through `proof/redact.ts` **before** it is hashed into the manifest, so a secret the code prints never lands on disk. **spec-lint's `cmd` denylist (outside paths, `~`/`$HOME`, `env`/`printenv`, network tools) is only a first line that catches the obvious; the sandbox is the boundary**: `node -e`, `python3 -c` and any test file can do what the denylist names without naming it. Checks get the same profile; a project whose checks legitimately need the network (a package install) sets `checks_network: true` in kitchen.yaml, which drops the network rules and keeps every filesystem rule (default false; cmd/test proofs never get it). A check that needs Docker can't run there (the socket is under `$HOME` or a unix socket the profile doesn't open); that belongs in the Toolkit. Proven by `spikes/w3a/contain.ts`, with the repo under `$HOME` (`home`) and under `/tmp` (`tmp`): `node -e` reading `engine.key` (EPERM), `node -p process.env` with fake tokens in `.env.kitchen` (redacted on disk), `python3` urllib and a raw socket to 1.1.1.1 (denied; both connect unsandboxed), `cat .env.kitchen` (redacted), a write outside the worktree, a write into a sibling job's worktree and a read of `job.json` (denied; the sibling write succeeds unsandboxed), and a real `node --test` file still passes; then Gate on fixture A (`node --check server.js` and a `node --test` check) PASSes with its test run, the builder's `checks` tool running a check that reads `engine.key` or curls `https://1.1.1.1` is denied, and with `checks_network: true` the curl goes out while the key read is still denied. **Linux:** no profile; proofs and checks run unsandboxed, prove logs `UNSANDBOXED` and the gate file says so (bubblewrap/Landlock is the later item).

**Residual risk (round 3):** unsandboxed today are the app the Toolkit starts and the primitives (`bin/dev` of a merged Toolkit sha; an unmerged one runs under ADR 0008's profile, which denies credentials but not the network or Docker), because they need Docker and the network; and everything on Linux. A proof can still read outside `$HOME` (a sibling worktree of a repo under `/tmp` is readable, not writable), and a check with `checks_network: true` can send what it can read (the worktree, `.env.kitchen`'s fake values) out.

Claude's sandbox **replaces** `GIT_SSH_COMMAND` with its own proxy command, so on Claude Code it is the sandbox's network proxy, not our variable, that stops SSH.

## Integrity results (real runs, from inside the agent, scrubbed env)

The test repo has `.kitchen/jobs/` and a job worktree at `.worktrees/001-spike` (the agent's cwd), a throwaway bare remote beside it, and `credential.helper=osxkeychain` set in the repo's local config. A control run of the same probe with the scrubbed env and **no** agent/sandbox shows the jobs write succeeds, so the sandbox is what stops it. (Before the W0 review the control's file-remote push succeeded too; the `pushInsteadOf` scrub now stops every push even without a sandbox.)

Rerun on 2026-11-22 after the review (Codex on the permission profile, Claude with `denyRead`): `npx tsx spikes/w0/run.ts integrity codex|claude`, 11/11 checks each, every push exit 128 (`remote-kitchen-push-blocked`), `gh` not logged in, jobs write "Operation not permitted", file-tool write refused, detached process alive with outside writes EPERM, Docker "permission denied". The table is the original run, plus rows g and h.

Second rerun, 2026-11-22, after the second review (Claude with `denyWrite` on `.git`; probe with checks g and h): 15/15 checks each. Claude haiku $0.0051 (99k in / 2.9k out tokens); Codex gpt-6-luna 99k in / 1.1k out tokens. The control (scrubbed env, no sandbox) shows the `.git` rewrite succeeds and `nc` reaches 1.1.1.1:443, so the sandbox is what stops both. The file-tool check (g) also requires a Write/Edit/`apply_patch` call on `.git` in the transcript, so a model that skips the attempt fails it.

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
| g. rewrite the worktree's `.git` by shell (`printf 'gitdir: …' > .git`) | PASS: "Operation not permitted", `.git` unchanged | PASS: same |
| g. rewrite the worktree's `.git` by file tool | PASS: Write refused, "File is in a directory that is denied by your permission settings" | PASS: `apply_patch` (Delete File `.git`) "patch rejected: writing outside of the project" |
| h. network: `curl https://example.com` | PASS: exit 56, "CONNECT tunnel failed, response 403" (sandbox proxy) | PASS: exit 6, "Could not resolve host" |
| h. network: `nc -z -w 3 1.1.1.1 443` (no DNS, no proxy) | PASS: exit 1 | PASS: exit 1 |
| max turns stops the run | PASS: `error_max_turns` | PASS: killed at the 2nd command |
| wall-clock timeout | PASS: 4.4 s | PASS: 4.0 s |
| resume keeps context | PASS: same session id, right answer | PASS: same thread id, answered from context |

## Decisions that follow

- **Docker / the Toolkit run in the engine, never inside an agent sandbox, on both tools.** `codex sandbox --allow-unix-socket <docker.sock>` does reach Docker, and Claude has `sandbox.network.allowUnixSockets`, but the Docker socket is root-equivalent (`docker run -v /:/host`) and would void the writable root. Agents prove behaviour only through `kitchen drive`, which the engine runs.
- **A detached process keeps the sandbox of the session that started it** (its write outside the root got EPERM on both tools). So `kitchen run --detach` launched from a sandboxed session could not write `.kitchen/jobs/` or reach the network. The `/kitchen` skill must start it unsandboxed: on Claude Code, sessions are unsandboxed by default; on Codex the default `workspace-write` needs a one-time escalation approval for that command. W2 must prove this from the user's real session.
- **No network inside either sandbox.** Dependency installs belong to the Toolkit's `prepare`, which the engine runs.
- Agents can't `git commit` in a worktree either: its git dir lives in the main repo's `.git/worktrees/`, outside the root. That fits "the engine commits". Nor can they rewrite the worktree's `.git` file (row g), and the engine never reads it anyway ("Engine git").

## Skill locations (`/kitchen`)

- **Claude Code:** `.claude/skills/<name>/SKILL.md` in the repo, also in nested folders between the repo root and the cwd. User level: `~/.claude/skills/`. It does **not** read `.agents/skills`. (Probed with one haiku call from a nested folder.)
- **Codex:** `.agents/skills/` in every folder from the repo root down to the cwd, and `<repo>/.codex/skills/`. User level: `~/.agents/skills/`. System: `$CODEX_HOME/skills/.system`. Plus plugin caches. It does **not** read `.claude/skills`. (Probed with `codex debug prompt-input`, no model call.)
- Kitchen installs `.claude/skills/kitchen/` and `.agents/skills/kitchen/`, with the same SKILL.md.

## Not verified

- `kitchen run --detach` from the user's own interactive session on each tool: only the role sandbox was tested. W2.
- Whether a user's login shell rc re-exports secrets. Codex runs commands through `zsh -lc`, and Claude snapshots the user's shell. Both showed no `GH_TOKEN` here, but a `.zprofile` that exports one would re-add it. `kitchen doctor` should run the probe.
- Codex `exec` with a Docker socket allowance through config (`network.allow_unix_sockets` exists in permission profiles). Not pursued, given the decision above.
- Linux (bubblewrap) behaviour of either sandbox, including the Codex permission profile and Claude's `denyRead`.
- Rate-limit detection: only the text match is in place. No run hit a limit.
- A crash between a manifest append and the `job.json` head write leaves one unsigned line, which `verifyManifest` refuses. W1's resume must truncate the manifest back to the signed head (that entry's `e<N>/` folder is then overwritten) before the next drive.

## Manifest integrity and the engine key

`src/proof/manifest.ts`. Each entry carries `prev` (sha256 of the previous line; `0…0` for e1) and `files: [{path, sha256}]` for every file in its `e<N>/` folder, `call.json` included. After every append the engine writes `manifestHead {n, hash, mac}` into `job.json`: the entry count, the sha256 of the last line, and `HMAC-SHA256(engine key, "kitchen-manifest-v1\n<job uid>\n<n>\n<hash>")`. `verifyManifest(dir, head, seal)` requires the head (no sibling-file default) and refuses: a bad or missing MAC, a line count other than `n`, an id other than `e<i>`, a broken chain, a missing or changed evidence file, a last-line hash other than `head.hash`, and a missing manifest when `n > 0`. Ids come from the head, so a deleted manifest restarted from `e1` does not verify. The key is `$KITCHEN_HOME/engine.key` (default `~/.kitchen`, folder 700, file 600, created on first use; a key file readable by group or others is refused).

**Rollback.** A head and manifest put back together from an earlier point (both validly signed, consistent with each other) would pass the checks above. So the engine also keeps a per-job counter, `$KITCHEN_HOME/heads/<job uid>` (folder 700, file 600): the highest `n` it ever stored, written right after `job.json` on every append (`storeHead`; a crash in between leaves it low, never high). `sealOf(job)` reads it as `Seal.floor`, and `verifyManifest` refuses a head with `n` below it. Proven by `run-toolkit-spike.mjs` (job.json + manifest from round 1 restored after round 2: "head has 37 entries but the engine already recorded 92: rolled back, refused") and a unit test.

**What it protects.** The engine's records against out-of-band edits by anything that cannot read the key: a hand edit of `job.json` or the evidence, a head copied from another job (the job's random `uid` is in the MAC), a tool that can write the job folder but not read `~/.kitchen`. Agents can neither write `.kitchen/jobs/` (their writable root is the worktree) nor, now, read `$KITCHEN_HOME`.

**Can the agent sandboxes read `~/.kitchen`?** By default, yes, on both tools: both sandboxes allow reads anywhere (checked: `codex sandbox -P :workspace -- cat <key>` printed it). So the adapters deny it: Claude with `sandbox.filesystem.denyRead` plus a `Read(/<KITCHEN_HOME>/**)` deny rule (Bash and the file tools), Codex with the `kitchen` permission profile (`"<KITCHEN_HOME>" = "deny"`). Proven in the bridge runs below: `cat engine.key` gives "Operation not permitted" on both, Claude's Read tool "File is in a directory that is denied by your permission settings", Codex's file read `PermissionError`, and the key's bytes appear in no report, transcript or event log.

**Residual risk.** Unsandboxed processes running as the user can read the key and write job state: app code started from a worktree (see "Worktree code"), the user's own shell, and anything they run. Until app processes get an OS sandbox, the manifest's integrity against hostile *app* code rests on nothing stronger than "the app would have to target Kitchen on purpose".

## Engine git (`src/engine/git.ts`, second W0 review)

**Finding.** `sourceStamp` ran `git -C <worktree> …` with the engine's full env. In a linked worktree `.git` is a file the worktree controls (`gitdir: <path>`). The reviewer pointed it at a gitdir whose config set `core.fsmonitor="echo PWNED-$GH_TOKEN > …"`, and the stamp wrote the token. A `core.hooksPath` with a `post-index-change` hook (run by `read-tree`/`add`) works the same way, and the stamp reported the attacker repo's HEAD.

**Decision.** Every engine git call goes through `openGit(repo).run(args)`:
- **The gitdir is resolved once, engine side, when the job is created** and stored in `job.json` (`gitDir`). A linked worktree: `linkedWorktree(mainRepo, id, wt)` = `<mainRepo>/.git/worktrees/<id>`, both real directories (no symlinks), checked against the back-pointer git keeps in that folder (`gitdir`), never against the worktree's `.git`. A plain checkout (fixtures, spikes): `plainCheckout(src)` requires `<src>/.git` to be a real directory; a `.git` file or symlink is refused. `kitchen job create … --repo <main> --worktree-id <id>` for a linked worktree.
- **Every call is** `git --git-dir=<gitDir> --work-tree=<wt> --no-pager -c … <cmd>`: no `-C`, no discovery. The command-scope config beats every config file and reaches child git processes (`GIT_CONFIG_PARAMETERS`). It turns off each key that makes the commands the engine runs (rev-parse, read-tree, add, write-tree, status, commit, push) execute a program: `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.sshCommand=false`, `core.askPass=`, `credential.helper=`, `protocol.ext.allow=never`, `core.editor=false`, `sequence.editor=false`, `core.pager=cat`, `commit.gpgSign=false`, `tag.gpgSign=false`, `push.gpgSign=false`, `submodule.recurse=false`, `diff.ignoreSubmodules=all`, `status.submoduleSummary=false`. Filter drivers (run by add, status, commit; chosen by the worktree's `.gitattributes`) can't be wildcarded, so `openGit` lists the drivers the config defines (`git config --get-regexp ^filter\.`, which runs nothing) and empties each (`filter.<d>.clean=`, `smudge=`, `process=`, `required=false`; an empty command is a pass-through, checked on git 2.39). Not covered, because the engine never runs the commands that use them: diff/textconv drivers (diff, log -p), merge drivers, `core.alternateRefsCommand` (fetch). The push path (W3) must push to an explicit URL with `--receive-pack`, so no `remote.<name>.*` program applies.
- **Env:** `engineGitEnv()`, the untrusted allowlist and scrub (`GIT_CONFIG_NOSYSTEM=1`, the engine-written `GIT_CONFIG_GLOBAL`, no credentials, push blocked) **without** the worktree's `.env.kitchen`, which could otherwise set `PATH` or `GIT_*` for git itself. `run(args, {credentials})` refuses credentials for anything but `push`: that is the one place the push path may add them.
- **Agents can't write `.git`** in the worktree: Claude `denyWrite` + `Edit()` deny rules, Codex built in (integrity row g).

**Proof.** `node spikes/w0/git-redirect.ts` (no agent, no Docker), 11/11. Control 1, the old stamp, follows the planted redirect, runs the fsmonitor and the hook (`PWNED-<fake GH_TOKEN>`) and stamps the attacker's HEAD. Control 2, an explicit gitdir without the neutral config, still runs a filter driver and a hook defined in the main repo. The fixed `sourceStamp` runs nothing (planted fsmonitor, hook, nested-repo redirect, main-repo filter and hook) and stamps the real worktree HEAD and on-disk tree. A mismatched back-pointer, a `..` id, a `.git` file or symlink in a plain checkout, and a folder without git are refused. `run-toolkit-spike.mjs` adds a linked worktree whose `.git` is redirected after `job create`: the drive stamps the real HEAD.

**Residual risk.** The main repo's own config and `$KITCHEN_HOME` are trusted. Unsandboxed app code running as the user can still edit them (see "Worktree code").

## Bridge (`kitchen mcp`, W0 review)

`src/bridge/mcp.ts`, a ~150-line hand-rolled JSON-RPC 2.0 stdio server (no SDK dependency): `initialize`, `ping`, `tools/list`, `tools/call`. `kitchen mcp --job <id> --role <role> --repo <dir>` resolves `<repo>/.kitchen/jobs/<id>/job.json` and refuses to start for a bad job id or a role without a bridge (intake, reviewers, report, retro). Tools:
- `drive {feature, args?, criterion?}` or `drive {primitive, primitive_args?, criterion?}`: exactly one of the two; any other field (e.g. `job`) is refused. Runs through `runDrive` with the caller's role stamped, under the per-job lock.
- `toolkit_status {}`: the Toolkit's `doctor` for the job's slot.

The adapters take it as `AgentRequest.bridge`, built by `bridgeServer()`, which passes `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `TZ`, `KITCHEN_HOME`, `DOCKER_HOST`, `DOCKER_CONTEXT` explicitly and nothing else:
- **Claude:** `--mcp-config '{"mcpServers":{"kitchen":{"type":"stdio","command":…,"args":[…],"env":{…}}}}' --allowedTools 'mcp__kitchen__*'`. `--strict-mcp-config` keeps it the only server.
- **Codex:** `-c mcp_servers.kitchen.command=… -c mcp_servers.kitchen.args=[…] -c mcp_servers.kitchen.env={…} -c mcp_servers.kitchen.default_tools_approval_mode="approve" -c mcp_servers.kitchen.tool_timeout_sec=300`. Codex gives an MCP server only `HOME, LOGNAME, PATH, SHELL, USER, LANG, LC_ALL, TERM, TMPDIR, TZ` plus `env`, hence the explicit env. **The approval setting is required:** with `approval_policy="never"` alone Codex refuses every call. Control run (`bridge.ts codex-noapprove`: the same adapter args minus that one setting): four `mcp_tool_call` items failed with "MCP tool call requires approval, but approval policy is never", zero manifest entries.

Both tools start the MCP server outside their command sandbox: the bridge wrote evidence into `.kitchen/jobs/` (outside the writable root) and `doctor` reached Docker.

**Project config in the worktree.** The bridge worktree had a committed `.mcp.json` (server `evil`), `.claude/settings.json` (a `SessionStart` hook) and `.codex/config.toml` (a `developer_instructions` canary + MCP server `evil`), each of which would have touched a canary file if loaded. After both runs: no canary file, no canary text in the transcripts. Claude ignores them through `--setting-sources ""` and `--strict-mcp-config`. Codex loads `.codex/config.toml` as a project layer only for a trusted project; trust comes from the user config, which `--ignore-user-config` drops (codex-rs `config/src/loader`: `load_project_layers` disables the layer of an untrusted project). So these paths don't need to be protected paths, and the adapter doesn't refuse worktrees that contain them (many real repos commit `.claude/` or `.codex/`). If a later Codex trusts projects some other way, the canary checks in `bridge.ts` catch it.

**Results** (2026-11-22, Claude Code 2.1.330 with `haiku`, Codex 0.171.0 with `gpt-6-luna`, one call each; `node spikes/w0/bridge.ts selftest|claude|codex|codex-noapprove <dir>`):

| check | selftest (no agent) | Claude | Codex |
|---|---|---|---|
| (i) `drive settings.toggle-dark` through the bridge, stamped `role: builder`, `criterion: C1`, sha = worktree HEAD, PNG in its `e<N>/` | PASS, 11 entries | PASS, e1–e11 | PASS, e1–e11 |
| (ii) `login {id: p2}` refused, nothing stamped | PASS | PASS: `login: "id" is set by the engine and can't be passed by a step` | PASS, same |
| (ii) `screenshot {out: <abs>}` refused, nothing written | PASS | PASS | PASS |
| (ii) `http {path: "http://evil.example/x"}` refused by the driver, stamped `ok:false` | PASS (e12) | PASS (e12) | PASS (e12) |
| engine key unreadable from the agent | – | PASS | PASS |
| worktree project config ignored (canaries) | – | PASS | PASS |
| `toolkit_status` (doctor, via Docker) | PASS 5/5 | – | – |
| manifest verifies against the signed head | PASS | PASS (n=12) | PASS (n=12) |
| cost | – | $0.0047; 60k in / 2k out tokens | 223k in (mostly cached) / 1.1k out tokens |

## Round 3 (W0 review): PATH and planted binaries

- Every env Kitchen builds keeps only absolute PATH entries (`safePath`), and engine git runs an absolute `git` resolved once from those entries, with `cwd` set to the gitdir, never the worktree. `spikes/w0/planted-git.ts` plants an executable `git` in a linked worktree and runs `sourceStamp` with `PATH=":$PATH"`: the planted binary does not run.
- `plainCheckout` reads the filter-driver list once per `openGit`; it is for fixtures and engine-owned checkouts only. Job worktrees always use `linkedWorktree`.
- The rollback floor in `$KITCHEN_HOME/heads/` can be bypassed by deleting the counter file. That needs write access to `$KITCHEN_HOME`, which agents don't have (denied on both tools); unsandboxed app code does, and that is the documented app-sandbox gap.
- Codex integrity rerun with the result file written first: check d passes. In two reruns the model chose not to attempt the file-tool `.git` rewrite (0 attempts, `.git` unchanged), so that one check came back unproven rather than failed; the attempt-and-refusal was shown in the previous round ("patch rejected: writing outside of the project").

## W3b: the engine pushes and fetches (`pushTo`, `fetchFrom`, `mergeRev`)

- **Push and fetch go to an explicit URL** (`forge.url`, default `https://github.com/<forge.repo>.git`; a local bare path in the spikes) with `--receive-pack=git-receive-pack` / `--upload-pack=git-upload-pack`, never a named remote, so no `remote.<name>.*` program applies. Credentials are given to `push` and `fetch` only (fetch too, because a private repo's base can't be read without them; still engine-only): the command-scope `pushInsteadOf` block of the scrub is dropped for that one call (`GIT_CONFIG_COUNT=0`) and one helper is named after the neutral config's empty one (`-c credential.helper=!gh auth git-credential`, the engine's own `gh`). Agents and worktree code keep the block (`spikes/w0` integrity results unchanged).
- **The base** is `refs/kitchen/base`, fetched from that URL (GitHub forge) or the main checkout's HEAD (local forge). A Toolkit sha counts as merged when it is an ancestor of **that forge's** base (`mergedIntoBase`, `mergeBaseRef`): on the GitHub forge only the fetched `refs/kitchen/base`, never the local HEAD, so a Toolkit branch someone merged in their own checkout but not on the remote stays sandboxed (W3b review M3, `spikes/w3b/forge.ts`).
- **Ready's merge** (`mergeRev`) refuses a repo whose config defines a `merge.<driver>.driver` (a merge driver runs a program; NEUTRAL_CONFIG can't wildcard them); hooks stay off. On a conflict the merge is aborted; the build stage starts it again with the markers left for the builder, and the engine's commit concludes it. If the builder's resolution changes a file the base changed and the layer rules refuse it (a Toolkit file, a protected path, a proof's test file), committing would put it back to this branch's version and drop the base's change silently; the engine aborts the merge instead and the job goes to needs-human, naming the files (W3b review M2).
- **The evidence branch: pruning is not deletion.** A job folder older than `evidence_keep_days` is removed from the tip of `kitchen-evidence`, but every earlier commit of the branch still holds it (and anyone who fetched it has it). What protects a secret is the redaction when the bundle is built (`proof/redact.ts`, again at publish), not the prune; a leaked value needs a history rewrite and a key rotation, which Kitchen does not do.
- **Paths from the top.** The main repo's gitdir is inside its work tree, so engine git run with `cwd` = gitdir sees a `.git/` prefix: path-limited commands on the main repo (`ls-tree`, `rm --cached`) must use `--full-tree` / `:(top)` pathspecs (found by `spikes/w3b/forge.ts`: retention pruning silently matched nothing).
