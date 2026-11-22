# Two-speed init: start in a minute, build the Toolkit when a ticket needs it

**Status.** Accepted and built, 2026-11-22 (docs/BUILD-LOG.md "ADR 0010"). The open questions are settled at the end.

**Problem.** `kitchen init` pays the whole price up front. It surveys the repo, builds a Toolkit, self-tests it, then has the engine prove it again, before a single ticket can run.

- On library-demo, an 8-file API with no dependencies, this took about 5 minutes and about $1 on opus, with three self-test rounds.
- On superchat-lite it stopped on "build a 10 GB host image?" before any work could start.

The reference factory (zazencodes v2) installs in about a minute: it fills in `checks.sh` with the project's lint and test commands and checks that they pass. It never starts the app. The user found ours heavy next to that.

**Decision.** Split setup into two speeds.

1. **Quick init (default, about a minute).**
   - Writes `kitchen.yaml` and the skill.
   - Detects the project's checks (lint, typecheck, test, build) from `package.json`, `Makefile`, `pyproject.toml`, CI config and AGENTS.md. It uses one short agent call, or none when the scripts are obvious.
   - Runs them once on the base and records the result.
   - No Toolkit, no app start, no Docker, no questions about images.
   - Jobs can run straight away. Their proofs are limited to the kinds that need no running app: `test <file>`, `cmd`, and the gate's checks.
2. **Toolkit on demand.** It gets built at the first of these:
   - `kitchen init --toolkit`;
   - a ticket whose criteria need the running app. Intake marks a criterion that needs a drive, and the job pauses at `toolkit` with reason `no-toolkit`: "this ticket needs Kitchen to drive the app; build the Toolkit now? (~3–15 min)". The person answers in the dashboard or with `kitchen feedback`.

   The Toolkit build is today's setup role and `toolkit check`, unchanged, including the sandbox, the proof and the `kitchen/setup` merge.

**What a job without a Toolkit claims.** Its Report says plainly that it was proven by checks and tests only, with no app driven. Criteria that need a drive are shown as **not proven (no Toolkit)**, never as passed. Risk rules still apply: a high-risk ticket (auth, payments, migrations) needs a Toolkit before it can reach ready.

**Names match what they do.** `init` in every other tool (`git init`, `npm init`) writes a few files in seconds. A user typing `kitchen init` doesn't expect an agent to write code, start their app twice and make 110 HTTP calls (library-demo, 2026-11-22: "suddenly check this"). So:

- `kitchen init` is quick init only.
- **`kitchen toolkit build`** is the Toolkit step: survey, write, prove. It is run by name, or offered when a ticket first needs it.

**Quiet output by default.** Each phase prints one line saying what it did, its time and its cost, then one line with the total and the next step:

```
Teaching Kitchen to run library-demo…
  ✓ Read the repo          API on node server.js · 5 features                31s
  ✓ Wrote the Toolkit      start · health · reset · call as a member          2m 50s
  ✓ Proved it              7 checks × 2 (after a reset) · 2 copies at once    25s
Done in 3m 46s · $0.98 · on branch kitchen/setup
Next: review it (git log -p main..kitchen/setup), then git merge kitchen/setup
```

The per-drive lines, the evidence ids and the sandbox notes go behind `--verbose`; they are always written to `.kitchen/init/init.log`. A failure prints the failing step in full.

**Also trims setup itself.**
- Setup runs on the `medium` tier (sonnet) by default.
- The survey prompt is told not to re-read files already in context.

**Why not keep one speed.** Proof by driving the real app is Kitchen's point, but making every project pay for it on day one hides that point behind a long, sometimes blocked, setup. Most first tickets are small. The Toolkit arrives when a ticket actually needs it, and the user is asked first.

**Settled (were open questions).**
- No background auto-build. A ticket that needs the running app pauses with reason `no-toolkit` and the message "This ticket needs Kitchen to drive the app; run `kitchen toolkit build` (about 3–15 min), then `kitchen resume <id>`." The pause is where the criteria are first linted: intake for a low-risk ticket, spec for a medium one; a high-risk job pauses at spec before any agent runs (or after review, if the diff raised it). The runner wakes it once a Toolkit is on the base; `kitchen resume` without one goes on with checks and tests only, unless the job is high risk or a bug whose reproduction drives the app.
- Check detection is deterministic first (package.json scripts with the package manager from the lockfile, Makefile targets, pyproject.toml pytest/ruff/mypy, a unittest `tests/` folder, go.mod, Cargo.toml); one short read-only agent call on the `cheap` tier, without the bridge, only when none of these says anything.
- The answer to the user's "how does the person answer": `kitchen toolkit build`, then `kitchen resume <id>` (or the dashboard later). Not `kitchen feedback`: a paused job takes `resume`.
