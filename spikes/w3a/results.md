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

# Review round 1 fixes (2026-11-22)

Same machine and tools. Claude Code (`sonnet` strong, `haiku` medium); Codex could not run (below).

## Finding → fix → proof

| # | finding | fix | proof |
|---|---|---|---|
| 1 | `named()` / verdict `agentGap` took the first word of free text (`GAP: the \`read\` primitive fails…` → "the") | `gapName`: one primitive-shaped name, alone or before a separator, not in describe; otherwise drives counts a failed write (cap), Verify an INCONCLUSIVE | `paths.ts bad-gap`: `drives → drives → verify → review`, no toolkit stage, `drives-check-1.md` says why; unit tests |
| 2 | drives checked each new drive alone from seed | each affected criterion's whole proof, twice, reset between, every step must run (`checkChain`); drives-written and repro-written feature files must pass W2's `parseFeature` + a `check:` line per drive + describe listing, or are kept off the branch | `engine.ts attacks`: chain check stamped for C1 and C3 on both passes; the new file carries its `check:` line; unit tests |
| 3a | a negative expect could hold because the thing never existed | spec-lint: the absent text must be an arg of an earlier segment of the same proof | the real admin run's first spec was refused for `$alicelink != ""`; the retry made `bob-hidden-proj` first; unit tests |
| 3b | `not visible` on an error page, `!=` on an empty read | a negative clause fails on an error/not-found page, a failed response (`status ≥ 400`) or an empty read | unit tests |
| 3c | nothing showed a criterion already held before the change | `base-check.json`: every mechanical criterion runs once on the base (fresh app, `phase: base`) in spec (and build, for inline criteria); a feature criterion passing there sends the spec back once, then is flagged `NON-DISCRIMINATING` in the verdict | admin run: `base check: C1 step-failed, C2 step-failed, C3 pass`; verdict flags C3 (a guard of existing behaviour) |
| 4 | the builder controlled what proofs run through | builder may not change `test` proof files, files Gate's checks / `test_cmd` run through, package.json `scripts`; a diff in `seed_paths` → risk high + `seed-diff.md` + review prompt | `contract.test.ts`; attacks still strips Toolkit/repro/kitchen.yaml edits |
| 5 | cmd proofs unrestricted | spec-lint refuses outside paths, `~`/`$HOME`, `env`/`printenv`, network tools, redirections out; untrusted env kept (`// W2 sandbox:` marks where sandbox-exec goes, not on main yet); bridge results pass `proof/redact.ts`; `_proofs.md` states the real rule | unit tests (`spec-lint.test.ts`, `redact.test.ts`) |
| 6 | a cmd/test expect could pass on a crash | `exit 0` is implied unless the expect names `exit` | unit-level (prove) |
| 7 | any timed-out wait counted as a reproduction | only when the waited text is what the criterion's expect asks for; `roles/spec.md`, `verifier.md` aligned | `paths.ts repro-retry`: try 1's wait for "Preferences" timed out → not reproduced; try 2 assert-fail → build |
| 8 | judged regex too broad, no screenshot required | layout/appearance/style/tone/copy only; the proof must take a screenshot | unit tests |
| 9 | refused manifest could PASS | INCONCLUSIVE | unit test |
| 10 | no attacks case for the role rule alone | after review, a builder bridge self-check stamped for this HEAD (clean), round 4, C3 is cited: refused as "a builder self-check, not proof" | `engine.ts attacks` 26/26 |
| 11 | spec role assumed primitive behaviour; `repro: true` anywhere | spec role told to check primitives through the bridge; spec-lint refuses `repro: true` on non-bugs | unit test |
| new | the first real admin spec wrote `read … --save owner`, which bin/dev got as an arg (no var kept; the builder rightly said BLOCKED) | `--save <var>` on a primitive proof segment keeps its output, like a drive's `save:` | the second admin run passed with three `--save` reads |
| new | a job could never fix a drive it added itself on a retry (compared against HEAD) | "existing" drives are the base's (and the repro's, for the drives stage) | `paths.ts repro-retry` |

## The review ticket, real agents

"Admins see every user's projects with owner; regular users still see only their own."

**Claude, run 2 (final code): PASS, 96 s, $0.308.** intake sonnet 10 s $0.053 → spec sonnet ×2 (first refused by spec-lint: `$alicelink != ""` unbacked) $0.174 → base check (C1, C2 fail on the base; C3 passes: the guard) → builder sonnet 23 s $0.081 (server.js +4/−2) → gate → drives (no new drives) → verify: C1, C2, C3 PASS by the engine, C3 flagged non-discriminating (a guard) → review. The negative criterion:

```
- [C3] A regular user still sees only their own projects: after the admin creates `bob-hidden-proj`, alice's Projects page (fresh full-page GET) lacks it but still lists `onboarding`.
  proof: toolkit projects.create --user bob-admin --slug bob-hidden-proj ; toolkit login --as alice ; toolkit http --method GET --path /projects
  expect: contains "project-link-onboarding" and not contains "project-link-bob-hidden-proj"
```

**The same spec against a wrong builder** (`wrong.ts claude`, no model): the real build with `user.is_admin → true` in `GET /projects` (every project, with owner, for everyone). Verify: C1 PASS, C2 PASS, **C3 FAIL** (`not contains "project-link-bob-hidden-proj"`: the HTML has it) → verdict FAIL. 4/4.

**Claude, run 1 (spent): needs-human, $0.583.** The spec used `read … --save owner`; the engine passed `--save` to bin/dev and kept no var, so C1, C2, C4 failed on the right build; the round-2 builder said BLOCKED with exactly that reason. Fixed in the engine (`--save` above), not the prompt.

**Codex: not run.** The account's Codex usage limit is reached ("try again at Dec 21st, 2026"); the intake call was rate limited after 4 s and the job paused (backoff), as it should. Nothing else was spent.

Real-agent total this round: Claude $0.891, Codex 0 tokens.

## Spike totals (final code)

`engine.ts attacks` 26/26, `engine.ts kill` 8/8, `paths.ts` 24/24 (repro-retry 5, gap 5, bad-gap 4, inconclusive 7, backoff 3; inconclusive re-run alone after fixing its own round assertion), `wrong.ts claude` 4/4, `e2e.ts claude admin` 8/8, W1 `paths.ts` 34/34 with the stub-bound scenarios removed (ported here).

# Review round 2 fixes (2026-11-22)

Same machine and tools. Claude Code (`sonnet` strong, `haiku` medium). No Codex (usage limit until 2026-12-21). Branch merged with main's W2 round-2 fixes first (`src/toolkit/sandbox.ts`).

## Finding → fix → proof

| # | finding | fix | proof |
|---|---|---|---|
| 1 | The spec can leave out part of the ticket: the round-1 admin run dropped "with no owner shown" and every check passed | Structural, no extra agent (ADR 0003): intake writes `## Requirements` (R1..Rn, each a quote or faithful paraphrase; `(negative)` for what must not happen, `(out of scope)` + why for a rescope); every criterion carries `covers: R…`; spec-lint rule 7 refuses a criterion covering nothing or an unknown R, an R in scope covered by nothing, and a negative R that no covering criterion asserts an absence for. An ACCEPT without requirements is refused at intake (machine guard `intake>spec`, inline lint for low risk). `roles/intake.md`, `spec.md`, `_proofs.md` | `e2e.ts claude admin` on the reviewer's ticket, verbatim: 12/12, $0.382 (below). `wrong.ts claude owner`: 5/5. Unit tests (`spec-lint.test.ts`, `machine.test.ts`) |
| 2 | The base check skipped every criterion whose proof needed a new drive | After the drives stage (features only), those criteria run on `.worktrees/<id>.base`: the base commit plus only the job's new feature drive files and the contract's test files, same slot, fresh app, `phase: base`, then the checkout is removed and the job worktree's prepare marker kept. A pass is NON-DISCRIMINATING (`base-check.json` `afterDrives`): in the verdict's row and footer, the verifier's judging prompt, and the review prompt (`facts.review.nonDiscriminating` for W4's report) | `paths.ts nondisc` 10/10: C1 (new drive, reads the Appearance heading) skipped by the first base check, run after drives on base + `settings-heading.md` only, 5 entries stamped `phase: base` on the base sha, passes → flagged in the verdict row and footer; C2 (needs the build) not flagged |
| 3 | cmd/test proofs ran unconfined; only bridge replies were redacted | `src/proof/sandbox.ts`: cmd and test proofs run under `sandbox-exec` (loopback only; `$HOME` unreadable except the worktree, toolchains on PATH under home, the npm cache and the `package.json` files above the worktree; writes in the worktree, temp, `/dev`, `~/.npm`; W2's credential list, `$KITCHEN_HOME`, the repo's `.kitchen/jobs` and git config denied). Entries stamped `sandboxed`; Linux logs UNSANDBOXED. stdout, stderr, `call.json` and every primitive text output are redacted before they are hashed into the manifest. The cmd denylist stays as the first line; `_proofs.md` and ADR 0006 say the sandbox is the boundary | `contain.ts` 11/11: `node -e` reading `engine.key` → EPERM, key nowhere in evidence (control: the same command unsandboxed prints it); `node -p process.env` with a fake `sk_test_…` and `ghp_…` in `.env.kitchen` → `[redacted]` on disk; `python3` urllib → URLError, and a raw socket to 1.1.1.1:443 → `PermissionError` (control: connects); `cat .env.kitchen` → redacted; a write outside the worktree and a read of `job.json` → denied; a real `node --test` file still passes. spec-lint passes every one of these attacks: the sandbox is what stops them |
| 4 | A drive could work only after an earlier segment of a proof, then fail W2's re-proof once merged | The drives stage runs every `check:` line the job added alone from seed (reset, that drive with its check args); a failure sends it back to the drives role, which `roles/verifier.md` now tells to make the check line self-sufficient | `paths.ts nondisc`: drives attempt 1's drive has no login step: C1's whole proof passes twice (the proof logs in first), the check line fails alone (`step "press" failed`); attempt 2 adds the login and passes |
| 5 | `$o == ""` held whenever the element was missing | The lint treats equality to empty as a negative: it needs an earlier step that makes something (a feature drive or a writing `http`) | unit test |
| 6 | Builder policy was a ternary chain | `BUILDER_RULES`: a table of (rule, reason), first match wins | `contract.test.ts` |
| found | `(allow network* (local ip "localhost:*"))` in the profile let an outbound socket to 1.1.1.1 through (the DNS failure had hidden it) | bind/inbound on local localhost, outbound only to remote localhost | `contain.ts` C8 + its control; `sandbox.test.ts` |

## The review ticket, real agents

"Admins see every user's projects with the owner shown; regular users still see only their own, with no owner shown."

**Claude: PASS, 133 s, $0.382.** intake sonnet 14 s $0.080 (high risk, ui+security) wrote:

```
## Requirements
- R1: admins see every user's projects (in the Projects list)
- R2: admins see the owner shown on each project
- R3 (negative): regular users still see only their own projects
- R4 (negative): no owner is shown to regular users
```

spec sonnet ×2 ($0.118 + $0.087): the first spec covered R4 with `not contains "project-owner"` (a test id no step makes) and was refused as an unbacked negative; the second:

```
- [C4] A regular user sees no owner on their own projects: alice owns a new project, and her project list shows the project but never her username as an owner.
  proof: toolkit projects.create --user alice --slug adm-noowner ; toolkit login --as alice ; toolkit open --path /projects ; toolkit read --target "[data-testid=project-list]" --save list
  expect: $list contains "Launch plan" and $list not contains "alice"
  covers: R4
```

→ base check (C1, C2 fail on the base; C3 and C4 pass: guards, flagged) → builder sonnet 30 s $0.096 (server.js +4/−2: a role-aware query and the owner span for admins) → gate → drives (no new drives) → verify: C1–C4 PASS by the engine, C3 and C4 flagged NON-DISCRIMINATING → review.

**Against wrong builders** (`wrong.ts`, no model, the real build mutated):
- `owner`: the regular user's query also joins the owner and the markup's admin check is forced true (regular users still get only their own projects): **C4 FAIL** (`$list not contains "alice": got "Onboarding alice\nLaunch plan alice"`), C3 PASS → verdict FAIL. 5/5.
- `leak`: every project with its owner for everyone: C3 FAIL and C4 FAIL → verdict FAIL. 4/4.

Real-agent total this round: Claude $0.382, Codex 0.

## Spike totals (final code)

`contain.ts` 11/11, `engine.ts attacks` 26/26, `engine.ts kill` 8/8, `paths.ts` 34/34 (repro-retry 5, gap 5, bad-gap 4, inconclusive 7, backoff 3, nondisc 10), `wrong.ts claude owner` 5/5, `wrong.ts claude leak` 4/4, `e2e.ts claude admin` 12/12. W1 `paths.ts` 34/34. `npm test` 294/294, typecheck and lint clean.

## Round 3: the proof sandbox, tightened (2026-11-22)

| finding | fix | proof |
|---|---|---|
| The proof profile allowed writes anywhere under `/private/tmp` and `/private/var/folders`: with the repo there, a proof could write into another job's worktree | Writes only in the job worktree, a temp dir the engine makes fresh for each run (`kitchen-proof-*`, set as its `TMPDIR`, removed after, with that run's profile), `/dev` and `~/.npm` (`src/proof/sandbox.ts`, `stamp-cmd.ts`) | `contain.ts tmp` (repo under `/private/tmp/kitchen-contain-*`) 21/21 and `contain.ts home` 20/20: new C9, `node -e` writing into the sibling job's worktree → EPERM (control: the same command unsandboxed writes it). On the round-2 profile `contain.ts tmp` fails C5 and C9 (19/21): the mode discriminates. `sandbox.test.ts`: the write rule names the run's tmp and neither temp root |
| Gate's checks and the builder's `checks` bridge tool ran builder-written code unsandboxed | `runChecks` stamps every check with `sandbox: true` under the same profile; kitchen.yaml `checks_network: true` (default false) drops only the network rules; the gate file says UNSANDBOXED where there is no sandbox-exec; the bridge reply carries `sandboxed` | `contain.ts`: Gate on the sibling job (`node --check server.js`, `node --test test/`) PASS, the test's output in the evidence (`pass 1`), every entry `sandboxed: true`; the `checks` tool (fake builder over the real bridge) with a check reading `engine.key` → EPERM, key nowhere in evidence, and `curl https://1.1.1.1` → "Failed to connect"; with `checks_network: true` the curl gets 301 and the key read is still denied (gate FAIL on readkey only). `sandbox.test.ts`: network on leaves the filesystem rules identical |

Still unsandboxed (ADR 0006): the app the Toolkit starts and the primitives of a merged Toolkit sha (they need Docker and the network); everything on Linux.

Totals on this code: `contain.ts home` 20/20, `contain.ts tmp` 21/21, `engine.ts attacks` 26/26 (its gate check `node --check server.js` ran sandboxed in all four gates), `paths.ts` 34/34. `npm test` 295/295, typecheck and lint clean. No agent calls.
