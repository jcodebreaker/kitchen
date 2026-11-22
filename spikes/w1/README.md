# W1 spikes: the engine skeleton, proven by running it

Asserting scripts that drive the real `kitchen` CLI (`node src/cli.ts … --repo <dir>`) as child processes. Each prints `PASS`/`FAIL` lines and exits 1 on any miss. Results: `results.md`.

Every script builds throwaway repos under the scratch dir you give it (default `spikes/w1/.work/`, ignored): a git repo with a `kitchen.yaml`, a fake Toolkit (`.kitchen/toolkit/bin/dev`, a shell script answering `describe`/`doctor`/`up`/`down`), and its own `KITCHEN_HOME`. Nothing touches your real repos or `~/.kitchen`.

```sh
node spikes/w1/paths.ts <scratch>          # every stage path with the fake adapter (free, ~30 s)
node spikes/w1/kill.ts <scratch>           # kill -9 mid-stage (in-process fake, a real agent subprocess, a gate check), restart, resume; run-lock take-over by heartbeat age (free)
node spikes/w1/faults.ts <scratch>         # refused human commands, corrupt job.json, half-made worktree, engine-error, empty run.lock, torn ledger line (free)
node spikes/w1/detach.ts <scratch>         # `run --detach` outlives its shell; `status` shows it (free, ~10 s)
node spikes/w1/bridge-checks.ts <scratch>  # the builder's `checks` tool on `kitchen mcp`, over stdio (free)
node spikes/w1/smoke.ts claude <scratch>   # ONE real agent call: intake on haiku through the runner
node spikes/w1/smoke.ts codex <scratch>    # ONE real agent call: intake on gpt-6-luna (npx @openai/codex@0.171.0)
node spikes/w1/smoke.ts codex <scratch> a-web  # ONE real agent call: intake on a copy of fixtures/a-web, default `cheap` tier (PLAN §7)
```

`kill.ts` part 2 runs the Claude adapter against `stub-agent.ts` (a `claude` stand-in started through a wrapper script given as `agent.command`): a real subprocess that reads the prompt, does what the fake script says for its role, can hang until killed, and logs every start (with any earlier run still alive) to `.kitchen/stub-agents.log`.

`W1_VERBOSE=1` prints every CLI line. Claude runs `/opt/homebrew/bin/claude` unless `KITCHEN_CLAUDE_BIN` is set; the Codex model can be changed with `W1_CODEX_MODEL`.

## How the fake agent works

`kitchen.yaml` says `agent: { tool: fake, script: spikes/w1/fake-script.ts }`, so the runner loads that module as the `FakeAdapter`'s script. Each ticket names a scenario (`scenario: <name>` in its text); `scenarios.ts` lists, per role, what each successive call writes (`DECISION: ACCEPT …`, `STATUS: READY`, `VERDICT: INCONCLUSIVE` …) or does (rate limit, hang until killed, sleep, edit the worktree, add a primitive to the fake Toolkit). Calls are counted per job and role in `$KITCHEN_FAKE_STATE`, so the count survives a kill.

The forge is `forge: { kind: fake }`: a JSON file (`.kitchen/fake-forge.json`) holding PRs, CI state, Toolkit PRs and Toolkit tickets. The spikes flip it (CI pending → pass, Toolkit PR merged, ticket closed) to clear `paused` jobs, and read its per-key call counters to prove no side effect ran twice.

## Files

- `lib.ts`: repo builder, CLI runner, PASS/FAIL tally, ledger path reader.
- `fake-script.ts`, `scenarios.ts`: the scripted roles.
- `stub-agent.ts`: the `claude` stand-in for `kill.ts` part 2.
- `paths.ts`, `kill.ts`, `faults.ts`, `detach.ts`, `bridge-checks.ts`, `smoke.ts`: the exit checks.
