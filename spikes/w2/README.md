# W2 spikes: Toolkit and setup, proven by running

Asserting scripts that drive the real `kitchen` CLI (`node src/cli.ts … --repo <dir>`) as child processes. Each prints `PASS`/`FAIL` lines and exits 1 on any miss. Results: `results.md`; one JSON record per real setup run in `runs/`.

Every script copies a fixture into a throwaway git repo under the scratch dir you give it (default `spikes/w2/.work/`, ignored) with its own `KITCHEN_HOME`. Nothing touches your real repos or `~/.kitchen`. Docker: at most 2 app stacks at a time (the check's two slots); every container is removed at the end and the scripts check for leftovers by Kitchen's name prefix.

```sh
node spikes/w2/flow.ts [scratch]                          # free: scripted setup role + real Toolkit/Docker. No-TTY questions (exit 3 → --answers → resume), the setup commit, toolkit check, base-change re-proof (smoke, full, broken → queue paused + ticket, fixed)
node spikes/w2/init-fixture.ts <fixture> claude [scratch] # ONE real setup: kitchen init on a fresh fixture copy (sonnet, effort medium), merge kitchen/setup, toolkit check on the base
node spikes/w2/init-fixture.ts <fixture> codex [scratch]  # the same on Codex (gpt-6-luna, effort medium, npx @openai/codex@0.171.0)
node spikes/w2/superchat.ts [scratch]                     # the superchat-lite measurement (not a gate): clone, init on Claude, 60-minute cap
```

Fixtures: `a-web` (its hand-made Toolkit is deleted from the copy first, so it is regenerated from scratch), `b-cli`, `c-adopt`, `d-api` (these three ship without a Toolkit). `W2_MODEL`, `W2_EFFORT` and `W2_CODEX_CMD` override the defaults; `W2_VERBOSE=1` prints every CLI line in `flow.ts`.

## Files

- `lib.ts`: fixture repo builder, CLI runner (buffered and live), PASS/FAIL tally, container check.
- `fake-setup.ts`: the scripted setup role for `flow.ts` (survey asks one question; build copies fixture A's hand-made Toolkit).
- `flow.ts`, `init-fixture.ts`, `superchat.ts`: the exit checks.

## Credits

The setup role (`roles/setup.md`) and the Toolkit's shape (Launch / Doctor / Drive / Evidence / Cleanup, the feature map) are ported from pstack's `create-verification-skill` and `maintain-verification-skill`, MIT License, Copyright (c) 2026 Lauren Tan.
