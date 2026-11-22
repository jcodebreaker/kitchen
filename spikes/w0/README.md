# W0 spike: agent adapters and integrity

Real runs of `src/agents/{claude,codex}.ts` that print `PASS`/`FAIL` lines. Findings: `docs/adr/0006-agent-adapters.md`.

Each command builds a throwaway layout under `spikes/w0/.work/<tool>/` (ignored): a repo with `.kitchen/jobs/`, a job worktree at `.worktrees/001-spike` (the agent's cwd), a bare remote beside it, and an agent home with the scrubbed git and gh config. Nothing touches your real repos, remotes, `~/.claude` or `~/.codex` config.

```sh
npm install
npx tsx spikes/w0/run.ts control              # no agent: probe with the scrubbed env, no sandbox (free)
npx tsx spikes/w0/run.ts integrity claude     # a b c d e f from inside the agent (1 run)
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

Models: Claude `haiku`, Codex `gpt-6-luna` (override with `W0_CODEX_MODEL`). Claude runs `/opt/homebrew/bin/claude` unless `KITCHEN_CLAUDE_BIN` is set. Codex runs as `npx -y @openai/codex@0.171.0`.

- `probe.sh` is what the agent runs. It prints one `key: exit=<n> | <line>` per check into `probe.out` and never prints a credential.
- `detach.mjs` and `hb.mjs` stand in for `kitchen run --detach`. The heartbeat also records whether the detached child can write outside the root.
- Results go to `.work/results.jsonl`, and the raw Codex events to `.work/codex-events.jsonl`.
- If the agent refuses to run the probe, the integrity run prints `FAIL … probe ran`. Haiku refused once until the prompt said what the test is for.
