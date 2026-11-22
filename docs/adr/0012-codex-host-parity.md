# Codex: detect the host without guessing, and prove parity with numbers

**Status.** Proposed, 2026-11-22. The host-detection approach is taken from super-board v3.3.0 (`scripts/super-board-host.sh`, `docs/hosts.md`), MIT © 2026 Eric Tech; no code was copied.

**Problem.**
- Kitchen's Codex adapter (`codex exec`) exists. Codex passed setup on three of four fixtures, but the end-to-end runs, review and the bench subset were never run, so README "Known limitations" says Codex parity is owed.
- `kitchen init` picks the tool with a guess: `CODEX_SANDBOX`/`CODEX_HOME`, otherwise Claude.

## Decisions

1. **Detection order, first match wins; never guess.**
   1. `--tool` or `KITCHEN_TOOL=claude|codex`. Any other value fails with exit 64.
   2. Env signs of the innermost host:
      - `CODEX_THREAD_ID` or `CODEX_SESSION_ID` → codex;
      - `CLAUDECODE` → claude.
   3. `agent.tool` in `kitchen.yaml`.
   4. Nothing matched: exit 65 with one line, `kitchen: can't tell whether to use Claude Code or Codex. Run with --tool claude|codex, or set agent.tool in kitchen.yaml.` In a terminal, init asks instead, recommending whichever binary `find-bin` finds, or Claude if both are installed.
   - Each env sign is written down next to the version and date it was observed, so a future host change is caught.
2. **A hosts table in `docs/hosts.md`**, kept by hand and checked by a test that runs `--version`:

   | Host | Tested version | Sign in | How roles run | Known gaps |
   |---|---|---|---|---|
   | Claude Code | (measured) | `claude` then `/login` | `claude -p`, stream-json, mid-run steering (ADR 0009) | none |
   | Codex | (measured) | `codex login` | headless `codex exec`, one per role | steering only at the next role; (more once measured) |

   No version goes in the table until a run on it has passed.
3. **Every Codex role runs as headless `codex exec`**, as super-board's lanes do, because Codex has no workflow or subagent tool. This is already Kitchen's model. From super-board we also take:
   - a typed result: `--output-schema` plus `--output-last-message`, with an enum status;
   - a permission profile that is read-only except the worktree and its git dirs, instead of loosening the whole sandbox.
4. **Close the gap with measured numbers only.** On Codex:
   - setup on fixtures A–E;
   - the end-to-end spikes (W2 inside, W3b);
   - the bench subset.

   The results go to `bench/results/<date>-codex-*.md`. README Known limitations changes only to the numbers that were measured.

## Blocked
- Codex isn't installed on the dev machine. The `codex` on PATH is a terminal shim, and the old alias points at a deleted build.
- The Codex account hit its usage limit; it resets 2026-12-21.

Steps 1–3 are built now and tested with stand-ins. Step 4 runs after the reset.

## Not taken
- super-board allows review and merge on Codex only with an explicit flag, and auto-merges on Claude. Kitchen never merges on either host.
