# W0 spike: agent adapters and integrity

Real runs of `src/agents/{claude,codex}.ts` that print `PASS`/`FAIL` lines. Findings: `docs/adr/0006-agent-adapters.md`.

Each command builds a throwaway layout under `spikes/w0/.work/<tool>/` (ignored): a repo with `.kitchen/jobs/`, a job worktree at `.worktrees/001-spike` (the agent's cwd), a bare remote beside it, and an agent home with the scrubbed git and gh config. Nothing touches your real repos, remotes, `~/.claude` or `~/.codex` config.

```sh
npm install
npx tsx spikes/w0/run.ts control              # no agent: probe with the scrubbed env, no sandbox (free)
npx tsx spikes/w0/run.ts integrity claude     # a b c d e f g h from inside the agent (1 run)
npx tsx spikes/w0/run.ts integrity codex
npx tsx spikes/w0/run.ts readtier claude      # read tier: repo read-only, file lands in an engine scratch dir (1 run)
npx tsx spikes/w0/run.ts readtier codex
npx tsx spikes/w0/run.ts limits claude        # max turns + wall-clock timeout (2 short runs)
npx tsx spikes/w0/run.ts limits codex
npx tsx spikes/w0/run.ts resume claude <session id printed by integrity>
npx tsx spikes/w0/run.ts resume codex <thread id printed by integrity>
sh spikes/w0/skills.sh            # Codex skill roots, no model call
CLAUDE=/path/to/claude sh spikes/w0/skills.sh --claude   # plus one haiku call for Claude Code
```

Toolkit, drive format, manifest, slots, untrusted env (no agent, needs Docker; ≤ 2 Postgres containers; exits 1 on any missed expectation):

```sh
node spikes/w0/run-toolkit-spike.mjs <scratch dir> [--cold]
```

Engine git: a planted `.git` redirect + `core.fsmonitor`/hooks/filter drivers; the old stamp leaks a fake `GH_TOKEN`, `sourceStamp` runs nothing (no agent, no Docker, free; exits 1 on any miss):

```sh
node spikes/w0/git-redirect.ts
```

Engine bridge (`kitchen mcp`): `selftest` talks to it over stdio (free); the others make one cheap agent call each. `codex-noapprove` is the control without `default_tools_approval_mode`. Exits 1 on any miss.

```sh
node spikes/w0/bridge.ts selftest <scratch dir>
node spikes/w0/bridge.ts claude <scratch dir>
node spikes/w0/bridge.ts codex <scratch dir>
node spikes/w0/bridge.ts codex-noapprove <scratch dir>
```

`run.ts` also exits 1 when any check FAILs. Code under `src/` runs directly on Node 26 (`node file.ts`); `tsx` works too.

Models: Claude `haiku`, Codex `gpt-6-luna` (override with `W0_CODEX_MODEL`). Claude runs `/opt/homebrew/bin/claude` unless `KITCHEN_CLAUDE_BIN` is set. Codex runs as `npx -y @openai/codex@0.171.0`.

- `probe.sh` is what the agent runs: a push/credentials, b gh, c job state, e detach, f Docker, h network (`curl`, and `nc` straight to an IP), g a rewrite of the worktree's `.git` (last). The integrity prompt also has the agent try its file tool on `jobs/001/` and on the worktree's `.git`; check g needs that attempt to show in the transcript. It prints one `key: exit=<n> | <line>` per check into `probe.out` and never prints a credential.
- `detach.mjs` and `hb.mjs` stand in for `kitchen run --detach`. The heartbeat also records whether the detached child can write outside the root.
- Results go to `.work/results.jsonl`, and the raw Codex events to `.work/codex-events.jsonl`.
- If the agent refuses to run the probe, the integrity run prints `FAIL … probe ran`. Haiku refused once until the prompt said what the test is for.
