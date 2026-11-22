# Two-speed init: start in a minute, build the Toolkit when a ticket needs it

**Status.** Proposed, 2026-11-22. To be built after ADR 0009, the interactive dashboard.

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

**Also trims setup itself.**
- Setup runs on the `medium` tier (sonnet) by default.
- The survey prompt is told not to re-read files already in context.

**Why not keep one speed.** Proof by driving the real app is Kitchen's point, but making every project pay for it on day one hides that point behind a long, sometimes blocked, setup. Most first tickets are small. The Toolkit arrives when a ticket actually needs it, and the user is asked first.

**Open questions.**
- Should quick init auto-build the Toolkit in the background after it finishes, so it's usually ready before the first ticket needs it?
- Is detecting checks without an agent reliable enough for Python and Go repos, or does it always need the short agent call?
