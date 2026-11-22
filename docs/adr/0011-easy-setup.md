# Easy setup: first ticket running in under five minutes

**Status.** Proposed, 2026-11-22. Builds on ADR 0010 (quick `kitchen init`, `kitchen toolkit build` on demand) and does not change it. Ideas taken from super-board (EricTechPro/super-board v3.3.0, MIT © 2026 Eric Tech); no code was copied.

**Goal.** Someone new goes from nothing to a first ticket running in under 5 minutes, after reading almost nothing. We measure it from a clean clone of fixture e-library: wall-clock time and number of commands until the first job is done, before and after this change.

## Decisions

1. **Three commands in the README's Quick start.** Every detail moves to `docs/` or a collapsed section: the approval table, the full config, the safety model.
   ```
   npm i -g devkitchen          # or: /plugin install kitchen  (from Claude Code)
   kitchen init                 # seconds, no agent (ADR 0010)
   kitchen ticket "…" && kitchen run --detach && kitchen dashboard
   ```
2. **Preflight inside `kitchen init`**, before it writes anything:
   - It checks node ≥ 20.11, git and a commit, `claude` or `codex` (found by `find-bin`, and signed in), and optionally `gh`.
   - It prints one line per tool, ✓ or ✗.
   - Each ✗ comes with the exact command to fix it for this OS: brew, apt, winget, `claude` then `/login`, `gh auth login`.
   - Kitchen never installs a system tool or signs anyone in on its own. The person runs the command; inside Claude Code, the permission prompt for Bash is the consent.
   - After a fix, success is judged by checking again, not by the installer's exit code.
3. **Recommended defaults; Enter accepts.**
   - Every question init or `toolkit build` asks shows the recommended answer first, and Enter takes it. In the terminal that is a `[Y/n]` prompt or a numbered list with the default marked. Inside Claude Code, the `/kitchen` skill uses `AskUserQuestion` with the recommended option first.
   - `--yes` accepts every default, for CI.
4. **Resume from the failed step.**
   - ADR 0010 keeps `state.json` per step. Each answer is also written atomically to `.kitchen/init/answers.json` the moment it is given.
   - Running init again shows the step it stopped at and continues there. "Start over" moves the old state to `.bak`.
   - Every halt prints the one command that resumes it.
5. **Progress during long steps.**
   - `kitchen toolkit build` prints an agenda strip, e.g. `✓ Read the repo · ▸ Writing the Toolkit · Prove it`. Every few seconds it adds a heartbeat line taken from the worker's live activity (the same stream as ADR 0009): `writing features/loans.md`, `running toolkit check (2 of 3)`.
   - Nothing stays silent for more than 10 seconds.
6. **A Claude Code plugin and a Codex plugin, next to the npm package.**
   - This repo becomes a plugin marketplace (`.claude-plugin/marketplace.json`). The plugin carries the `/kitchen` skill, so `/kitchen set up` works in any repo before Kitchen is in it.
   - The plugin runs the CLI with `npx -y devkitchen@<pinned version>`, which needs the npm package published. Publishing to npm is a separate step the user approves.
   - The same skill ships for Codex.

## Not taken from super-board
- Auto-merge as the recommended default.
- Pushes or remote board changes as a side effect of picking an option.
- Installing helper packs with `npx …@latest` unpinned.
- `rm -rf` followed by a copy into the user's skill folders.
- Reading `.env` files.

## Alternatives
A `curl … | bash` installer like super-board's `get.sh` (atomic `main()`, refuses root). It is useful where npm isn't, but npm and the plugin cover our users. We keep it as a later option.
