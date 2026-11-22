# W3a results (2026-11-22)

Claude Code 2.1.330 (`sonnet` for strong roles, `haiku` for medium: the verifier), Codex CLI 0.171.0 via `npx` (the default tier map: `gpt-5.6-terra` for strong and medium). macOS, Docker Desktop, fixture A copies. All runs below are on the branch's final code unless marked as an earlier attempt.

## Exit table (PLAN §7 W3a)

| exit | result | evidence |
|---|---|---|
| FEATURE ticket end to end on Claude Code | PASS | `e2e.ts claude feature`: intake → spec → build → gate → drives → verify → review; 5 mechanical criteria, all PASS by the engine; new migration + header + settings form (3 files, +71/−2); manifest verifies (99 entries) |
| FEATURE ticket end to end on Codex | PASS | `e2e.ts codex feature`: same path; 2 mechanical criteria PASS; 3 files +94/−2 |
| BUG ticket end to end on Claude Code | PASS | `e2e.ts claude bug`: intake (low, inline criteria) → repro → build → gate → drives → verify → review. `kitchen drive --repro` on the base: `wait "theme-dark"` timed out (failed as expected); fix is the one-line `WHERE`; C1 PASS after |
| BUG ticket end to end on Codex | PASS | `e2e.ts codex bug`: same path and repro result |
| (extra) a judged criterion judged by a real verifier, both tools | PASS | `e2e.ts claude\|codex visual`: the verifier opened the engine's screenshots and cited them; the engine accepted the citations (`C1 verifier PASS e6`, Codex `e30 e35`) |
| Forged citation refused | PASS | `engine.ts attacks` round 1: `C3 cites e9999, which is not in the manifest` → FAIL, a round spent |
| Stale citation refused | PASS | round 2 cites round 1's ids: `stamped in round 1, not 2` → FAIL |
| Builder self-check cited as proof refused | PASS | round 3: `stamped for 27ebf42a, not HEAD …` (also refused by role: only engine/verifier entries are citable, unit-tested) |
| Feature drive containing code refused | PASS | drives attempt 1 (```js block + `eval` step): `refused: line 3: a feature drive file can't hold code`; never committed (`git log -p` shows no such content); attempt 2 clean, passes `toolkit check --feature` |
| Builder commit touching Toolkit primitives stripped | PASS | `bin/dev` edit, new `lib/extra.mjs`, the repro drive and `kitchen.yaml`: each kept off the branch with its reason (`rounds/1/build-refused.md`); branch diff = server.js + feature drives only |
| Repro sneaking in a fix | PASS | the fix is kept off the repro commit (`the repro adds a regression test; it doesn't change existing files`); the repro still fails as expected on the base |
| kill -9 mid-Verify, resume | PASS | `engine.ts kill`: SIGKILL with C1 decided and C2 two steps in; resume: `proofs already decided before a restart, not run again: C1 PASS`; C1 ran once, C2 twice (the cut run, once more), C3 once; manifest verifies; verdict PASS; job at review |
| `docker ps` clean | PASS | every spike checks its own job's containers; after all runs `docker ps --filter label=kitchen.toolkit=a-web` is empty |
| npm test / typecheck / lint | PASS | 251 tests; `tsc` both configs; biome clean |

Script totals on the final code: `engine.ts attacks` 23/23, `engine.ts kill` 8/8, `e2e.ts` claude feature 5/5, codex feature 5/5, claude bug 7/7, codex bug 7/7, claude visual 6/6, codex visual 6/6.

## Per stage: models, time, cost (final runs)

Times are the stage's wall time from the move into it to the move out (including Toolkit `up`, proofs and role runs); agent seconds and cost from the ledger. Codex reports tokens, no dollars.

**Claude, feature** (91 s, $0.314)

| stage | → | secs | role, model, secs, cost, tokens in/out |
|---|---|---|---|
| intake | spec | 10.3 | intake sonnet 10 s $0.081 64k/1.1k |
| spec | build | 19.8 | spec sonnet 17 s $0.087 79k/2.4k |
| build | gate | 23.1 | builder sonnet 21 s $0.138 208k/2.6k |
| gate | drives | 0.9 | engine only |
| drives | verify | 25.5 | verifier (drives) haiku 20 s $0.008 216k/3.8k |
| verify | review | 11.4 | engine only (no judged criteria) |

**Codex, feature** (283 s, 1.03M in / 8.6k out tokens)

| stage | → | secs | role, model, secs, tokens |
|---|---|---|---|
| intake | spec | 45 | intake gpt-5.6-terra 45 s 171k/1.4k |
| spec | build | 57.6 | spec gpt-5.6-terra 55 s 166k/1.9k |
| build | gate | 110.8 | builder gpt-5.6-terra 109 s 431k/3.6k |
| gate | drives | 0.9 | engine only |
| drives | verify | 63 | verifier (drives) gpt-5.6-terra 57 s 263k/1.7k |
| verify | review | 4.9 | engine only |

**Claude, bug** (41 s, $0.114)

| stage | → | secs | role, model, secs, cost, tokens |
|---|---|---|---|
| intake | repro | 9.5 | intake sonnet 9 s $0.048 36k/1.1k (rated low, inline criteria) |
| repro | build | 9.3 | engine only: the proof needed nothing new; `--repro` on a fresh app |
| build | gate | 15.3 | builder sonnet 13 s $0.066 109k/1.1k |
| gate | drives | 0.9 | engine only |
| drives | verify | 1.3 | engine only (no new drives) |
| verify | review | 4 | engine only |

**Codex, bug** (136 s, 421k in / 3.3k out)

| stage | → | secs | role, model, secs, tokens |
|---|---|---|---|
| intake | repro | 66 | intake gpt-5.6-terra 66 s 175k/1.9k |
| repro | build | 9.3 | engine only |
| build | gate | 53.7 | builder gpt-5.6-terra 52 s 245k/1.4k |
| gate | drives | 0.9 | engine only |
| drives | verify | 1.4 | engine only |
| verify | review | 3.9 | engine only |

**Extra, visual** — Claude: 48 s, $0.119 (intake sonnet $0.050, builder sonnet $0.064, verifier (verify) haiku 9 s $0.005). Codex: 184 s, 777k/4.9k tokens (intake 44 s, builder 59 s, verifier drives 47 s, verifier verify 20 s).

**Earlier attempts (spent, kept for the record):** Claude bug #1 $0.155 (passed; repro needed a second try, see below), Claude feature #1 $0.448 (ended needs-human: `GAP: none` read as a gap), Claude visual #1 $0.158 (passed on the INCONCLUSIVE free retry: the verifier could not open the screenshots), Claude visual #2 ≈$0.05 (intake NEEDS-INFO: the fixture already styled the button, a fair question), Codex bug #1 508k/3k tokens (passed; spike checks were stale). **Real-agent total: Claude ≈ $1.53, Codex ≈ 3.3M input tokens.**

## What proving changed (engine and role prompts)

| seen | change |
|---|---|
| Claude bug #1: intake's repro used the existing `settings.toggle-dark`, whose `wait "theme-dark"` times out on the buggy base: "step failed", not reproduced. The haiku repro agent then *edited the shared drive* to read the class instead | (engine) a `wait` that times out after every earlier step ran counts as failed as expected (the state the criterion expects never showed up); (engine) a job may add drive blocks to a feature file but never change an existing one (`changedExistingDrive`, repro and drives stages); the repro's drive files are the builder's no-go list even when nothing new was committed |
| Claude feature #1: drives agent wrote `GAP: none`; the engine took "none" as a missing primitive → toolkit → needs-human | (engine) `named()`: none/n-a/-/placeholders name no gap. (prompt, `roles/verifier.md`) "GAP: … write this line only when one is missing" |
| Claude feature #1: the spec wrote `toolkit login … ; open --path /home` (second segment without `toolkit`); spec-lint refused, the retry fixed it | (engine) later toolkit segments may leave out the word `toolkit` |
| Claude visual #1: haiku in verify mode could not open the PNGs (Claude's Read tool refuses files outside the worktree) and said INCONCLUSIVE | (engine) the judged criteria's evidence files are copied into `<worktree>/.kitchen-out/evidence/` (never committed) for the verifier to open; the Verdict still checks ids against the signed manifest |
| attacks #1: `git add` refused the `:(exclude).kitchen-out` pathspec because fixture A's .gitignore lists `.kitchen-out/` (W1 bug) | (engine) stage everything, then unstage the outbox |
| attacks #1: port 31001 "already allocated": the concurrent W2 builder's Docker published 0.0.0.0:31001, which a 127.0.0.1 probe misses on macOS | (engine) `probePort` checks loopback and the wildcard address |
| kill #1: after a resume the app stayed up (the reclaimed slot was not re-taken, so the runner never freed it) | (engine) the runner takes the slot again when job.json names one the registry dropped |
| job ids over 41 chars broke `bin/dev --id` and collided across repos | (engine) `slotId` = `<n>-<10 hex of the job uid>` |

No role prompt had to change for the four exit tickets to pass beyond the `GAP:` line above.

## Not proven here

- INCONCLUSIVE twice → paused (toolkit-ticket) and TOOLKIT-GAP from Verify with the real Toolkit: covered by `machine.test.ts` only; the W1 `paths.ts` scenarios for bug/gap/inconclusive relied on the W1 stubs and no longer apply (see `spikes/w1/README.md`).
- Review, ready and report: W3b/W4 (jobs stop at review).
- `toolkit check --feature` is this wave's engine check (reset, drive, reset, drive) through the W1 seam, not W2's `src/toolkit/check.ts` (not merged when this was built).
