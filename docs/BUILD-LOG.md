# Kitchen build log

One entry per wave: what was built, review rounds and scores, what is proven, and what is left. The plan is `docs/PLAN.md`; adapter facts are in `docs/adr/0006-agent-adapters.md`.

## Wave 0: spikes (done, 9/10)

**Review rounds:** 6.5 → 8 → 8.5 → 8.5 → 9. The reviewer was an independent Opus subagent, and each round it re-ran the spikes itself.

**Built**
- Agent adapters for Claude Code and Codex (`src/agents/`), plus a scrubbed environment for agents and for app code (`env.ts`).
- Fixture A, a web app with Postgres, login, settings and a two-step form, with its own Toolkit (`fixtures/a-web/.kitchen/toolkit/`).
- An engine-side drive interpreter (`src/proof/drive.ts`).
- A hash-chained, HMAC-signed evidence manifest with a floor that blocks rollback (`src/proof/manifest.ts`).
- Port slots shared by every repo on the machine (`src/toolkit/slots.ts`).
- One helper for every engine git call (`src/engine/git.ts`).
- The `kitchen mcp` engine bridge (`src/bridge/mcp.ts`).

**Proven by running (spikes in `spikes/w0/`, all of which check their own results)**
- On both tools, from inside a real agent session:
  - pushing fails over a file path, SSH and HTTPS, and the keychain is never used;
  - `gh` shows no login;
  - writes to job state and to `.git` fail, from the shell and from the file tools;
  - direct network access fails;
  - the role file comes back through `.kitchen-out/`;
  - a detached process outlives the call;
  - max turns, timeout and resume work.
- Docker can't be reached from either sandbox, so the Toolkit always runs in the engine (ADR 0006).
- The Toolkit contract: prepare, up (about 1 s from a snapshot), doctor, reset, down, two slots side by side, and three real flows with no new primitive. All 52 of the spike's checks pass.
- Evidence integrity: an edited, dropped or reordered entry is refused, and so are a replaced file, a forged head and a rolled-back job.
- Attacks are refused: a drive overriding engine flags, `http` to another site, a `.git` redirect or a hook or filter in the worktree, and a `git` binary planted on PATH.
- The bridge works on both tools; Codex needs `default_tools_approval_mode="approve"`.

**Deferred, and documented**
- There's no OS sandbox for the app's own processes. App code runs as the user, so it could read `$KITCHEN_HOME` or edit job state. It gets no credentials through env vars, and running it under a sandbox is the first hardening item.
- `kitchen run --detach` started from the user's own session is not yet proven (Wave 2).
- In the last Codex rerun the model chose not to attempt rewriting `.git` with its file tool. The previous round showed that attempt being refused.
- Linux sandboxes are untested.

## Wave 1: engine skeleton (done, 9/10)

**Review rounds:** 7 → 8.5 → 9. The reviewer was an independent Opus subagent, and each round it re-ran the spikes itself and tried its own break tests.

**Built**
- `src/config.ts`: the kitchen.yaml schema.
- `src/engine/machine.ts`: the full transition table as one data table, plus a pure `move()`. Every row has a legal and a refused test.
- `store.ts`: job storage, validated by a zod schema; a corrupt job is listed and skipped.
- `lock.ts`: a run lock written atomically, with a heartbeat.
- `runner.ts`: slots, `--once` and `--detach`. It checks the lock before each dispatch, each role run and each move.
- `src/procs.ts`: every agent, check and per-job Toolkit call runs in its own process group, recorded on disk. On resume those groups are killed, and so are orphaned bridge checks.
- Eleven thin stage handlers.
- Ledger, prompt tickets, local and fake forges.
- CLI: `ticket`, `run`, `status`, `resume`, `feedback [--to]`, `reject`, `report`.
- A bridge `checks` tool that runs with the untrusted env.
- ADR 0007: feedback goes back to the stage the job escalated from, and never past it or past verify.

**Proven**
- Spikes, run with a fake adapter:
  - stage paths: 54/54;
  - kill and resume: 34/34, including a real agent subprocess and a SIGKILLed bridge;
  - faults: 27/27, covering corrupt jobs, a torn worktree, an empty lock, a lost lock, refused human commands, a torn ledger and torn process records;
  - `--detach`: 8/8;
  - bridge checks: 7/7.
- Real calls: one each on Claude and Codex, plus a Codex smoke run on fixture A.
- `npm test`: 228/228.

**Still stubs, swapped in at W3a and W3b:** the guards that read a role's file instead of evidence (repro on base, drives resolve, verify verdict, toolkit check), the base sync and fresh instance, the engine-owned Toolkit checkout, and the GitHub forge.

**Known gap:** when the loop stops because it lost the lock, it frees the slots of stages that are still finishing.


## Wave 2: Toolkit and setup (done, 9/10: Claude complete, Codex proofs owed)

**Review rounds:** 6 → 8 → 9.

**Conditional on Codex:** the Codex account hit its usage limit and resets on 2026-12-21. When it does, run `spikes/w2/init-fixture.ts d-api codex` and `spikes/w2/inside.ts codex b`, and re-check one Codex-generated Toolkit against the stricter probe. If any of those fails, Wave 2 drops back to 8.

**Final review:** all four Claude-generated Toolkits (fixtures A–D) pass the stricter contract probe.

**Score status:** Claude complete; Codex fixture D and /kitchen-inside-Codex owed when the Codex quota resets (2026-12-21): run `spikes/w2/inside.ts codex b` and `init-fixture.ts d-api codex` first in W3b.

**Built**
- `src/toolkit/contract.ts`: zod schemas for every command's JSON line and `describe` (`contract: 1`, surface, primitives, features, `seed_users`, externals, `ports.needs`, parallel), and the parser for a feature file's `kitchen` block (mapped `paths`, `check` args).
- `src/toolkit/check.ts`: `kitchen toolkit check [--feature x] [--src dir]`: describe, feature files, prepare (timed), up, doctor, every check drive through the engine's interpreter (stamped into `.kitchen/checks/<run>/`), reset, the drives again, a second slot at once, down, evidence verified against the signed head; writes `.kitchen/toolkit.proven`.
- `src/toolkit/checkout.ts`: the engine-owned checkout `.worktrees/_toolkit@<sha>`, `prepare` cached per sha and source, GC of unreferenced checkouts.
- `src/toolkit/reproof.ts`: the base-change re-proof the runner calls before taking new work (full check if Toolkit or mapped paths changed, else doctor + smoke drive; a failure pauses the queue and files one Toolkit ticket).
- `toolkit-template/`: generic `bin/dev` (contract v1), helpers, optional browser and terminal modules, `app.mjs`/`SKILL.md`/`features/` to fill in.
- `roles/setup.md` (port of pstack's create-verification-skill, MIT, credited), `src/init/` (`kitchen init`, resumable, survey → ≤3 questions → build → engine commit on `kitchen/setup` → check → ≤2 fix rounds; `--answers`, exit 3 without a TTY, `--generate-only`), `kitchen setup-mcp` (the setup role's bridge), `skills/kitchen/SKILL.md`.
- Fixtures B (Python CLI + SQLite), C (fixture A's app with its own compose setup), D (API with a Stripe-shaped payment API and SMTP); none ships a Toolkit.

**Proven by running** (`spikes/w2/results.md`): `init` + `toolkit check` pass on A (regenerated from scratch), B, C, D on Claude Code (sonnet, medium effort: 103–264 s agent time, $0.42–$0.87 each) and on A, B, C on Codex (gpt-6-luna: 208–498 s); the no-TTY question flow and the base-change re-proof (`flow.ts`, scripted setup role, 26/26); superchat-lite generated in 229 s for $1.26 (generate-only: its stack is over this laptop's Docker budget).

**Review round 1 (fixed, `spikes/w2/results.md` "W2 review round")**
- Blocker: a `bin/dev` timeout waited on a stdout pipe a child held (146 s for a 2 s timeout). `runToolkit` now kills the process group and returns at once; `timeout.ts`.
- `toolkit check` passed a broken Toolkit: one JSON line per call, http(s) url, doctor with checks, `surface` enum, and a contract probe (every primitive, plus the refusals the contract requires); `probe.ts` (the reviewer's fake and each fault fail, named). The 7 generated Toolkits of A–D and fixture A's own still pass.
- Feature `paths` required and matched against tracked files; `parallel:false` enforced by the runner (no `kitchen.yaml` regex); an init re-run never says done without a passing full check.
- `kitchen init --detach` / `--status [--wait]`, and the skill polls it; secret scan before the setup commit; checkout leases; the setup bridge's `bin/dev` under macOS `sandbox-exec` (ADR 0008, Linux unhandled); `.env.kitchen` can't set `PATH`/`NODE_OPTIONS`/loader variables; prepare cached per lockfile hash and stall-killed after 5 silent minutes; `models.setup`; `kitchen toolkit up|down`.
- Real runs: a real survey asked a question (fixture E: which catalog the team uses) and the whole `/kitchen` setup ran inside `claude -p` (detach, poll, relay the question, answer on resume, done), about $1.14 on sonnet. Two findings from it fixed: Claude Code refuses `sleep 60` between polls (now `--status --wait`), and `--status` exiting 3 made the agent chain a fallback (now exit 0).
- New: `npm test` 250/250; spikes `timeout.ts` 6/6, `probe.ts` 14/14, `gc.ts` 6/6, `sandbox.ts` 9/9, `codex-sandbox.ts` 3/3, `flow.ts` 36/36, `inside.ts claude e` 11/11, `spikes/w1/paths.ts` 54/54.

**Review round 2 (fixed, `spikes/w2/results.md` "W2 review round 2")**
- Major: init's own check of `kitchen/setup`, its fix rounds and `toolkit check --rev` ran agent-written `bin/dev` unsandboxed. Every run of a sha not merged into the base (not an ancestor of `HEAD`) now goes through the setup bridge's `sandbox-exec` profile (`toolkitCheckout`). `sandbox.ts`: a planted, working Toolkit that writes a marker when it can read `~/.ssh` or the engine key leaves none through `kitchen init` or `toolkit check --rev kitchen/setup`, and leaves one after the merge (the control). ADR 0008 now names the Docker daemon as outside the sandbox (`docker run -v $HOME:/h`) and the planned W3b+ bind-mount rule.
- Found while proving it: a Toolkit commit without `.env.kitchen` staged nothing (a git 2.39 pathspec quirk); fixed.
- Minor: an uncovered primitive must answer `ok:true` with no args, or is probed with its declared args (`probe.ts`: the reviewer's `frobnicate` stub fails, named); secret scan adds `sk-ant-`, `sk-proj-`, long bare `sk-`, `github_pat_`, `AIza`, `glpat-`, `npm_`; the sandbox denies `~/.npmrc`, `~/.pypirc`; the README states Linux runs the setup bridge unsandboxed (v0.1).
- New: `npm test` 276/276, typecheck, lint; `probe.ts` 16/16, `sandbox.ts` 14/14, `flow.ts` 36/36.

**Open**
- Codex: the account hit its usage limit (until 2026-12-21) mid-run: D on Codex stopped after its survey, and the `/kitchen` setup inside `codex exec` (`inside.ts codex b`) has not run. What Codex needs approved is shown without a model (`codex-sandbox.ts`); that an execpolicy `allow` rule runs `kitchen init` outside the sandbox is unproven.
- The sandbox covers agent-written code until it is merged (the bridge, init's checks, `--rev` of an unmerged sha); merged Toolkits (every job's Toolkit calls, the re-proof) run unsandboxed (ADR 0006/0008). Containers started through the Docker daemon are outside it. Linux has no sandbox at all.
- superchat-lite's Toolkit has never run (W3b's first step, on a machine with the Docker budget).
- Jobs still use the repo's own `bin/dev` (W1); moving them onto the engine-owned checkout comes with the smith and PR pinning (W3b).
- `toolkit up|down|maintain` are not built.
- `prepare` has no stall detection (a hung download waits for the 30-minute timeout).

## Wave 3a: proof and the core path (done, 9/10: Claude complete, Codex re-proof owed)

**Review rounds:** 6.5 → 7.5 → 8.5 → 9.

**Conditional on Codex:** the 9 is withdrawn if the Codex run of the admin ticket fails to reach review once the quota resets on 2026-12-21.

**Stands on:**
- a structural check that the spec covers every requirement in the ticket;
- a base check after drives;
- builder limits on the files that proofs and checks run through;
- sandboxed cmd/test proofs and sandboxed gate and builder checks;
- evidence redacted when it is written.

**Built**
- `src/proof/assert.ts`: mechanical `expect:` matchers (`ok`, exit code, `text "…" visible`, contains, JSON path into the output or a `$var`, row count, `$var` comparisons, `and`). `src/proof/proof-line.ts`: the `proof:` line parser. `src/proof/prove.ts`: one criterion's proof through `kitchen drive` (toolkit segments via runDrive, cmd/test via stampCommand), then assert. `kitchen drive <job> <C> [--repro] [--arg k=v]…` on the CLI.
- `src/checks/spec-lint.ts` (all six rules, for spec.md and a low-risk ticket's inline criteria), `feature-lint.ts` (no code in a feature file; no job changes an existing drive), `gate.ts` (checks pinned to HEAD), `verdict.ts` (mechanical by the engine, judged per criterion with citations stamped for this HEAD/round/criterion by the engine or the verifier; manifest verified; `--args` deltas carried). `risk-floor.ts` gained tests.
- Real stages: intake, spec, repro (`--repro` on a fresh app from the base plus only the repro's files; the builder may not edit them), build (layer rules: no Toolkit file, protected path or repro file), gate, drives (resolve, lint, `toolkit check --feature` as reset/run/reset/run, the verifier writes only what is missing), verify (fresh `up`, every proof by the engine from seed state, resumable after kill -9, then the verifier for `judged` only). `src/engine/instance.ts`: prepare/up/down/reset for the job's slot.
- Roles: `roles/intake.md`, `spec.md`, `builder.md`, `verifier.md` (modes drives, repro, verify), `_proofs.md` (the shared format reference). `.kitchen/roles/<role>.md` overrides.
- Bridge: `drive {criterion}` runs a criterion's whole proof; `restart_app` for the builder; verifier `--args` deltas logged.

**Proven** (`spikes/w3a/results.md`): a feature and a bug ticket end to end on fixture A, on Claude Code and Codex, plus a styling ticket whose judged criterion a real verifier judged on both; forged, stale and self-check citations refused; a drive with code refused; builder edits to the Toolkit, the repro and kitchen.yaml stripped; kill -9 mid-Verify resumes without re-running a decided proof. `npm test` 251/251.

**Open:** `toolkit check --feature` is this wave's own check through the W1 seam until W2's `check.ts` merges; INCONCLUSIVE→paused and Verify TOOLKIT-GAP are unit-tested only; W1 `paths.ts`/`kill.ts` part 1 depend on the old stubs.

- `toolkit maintain` is W4.

**Review round 1 fixes** (`spikes/w3a/results.md` "Review round 1 fixes", PLAN "Changes from the Wave 3a review"): strict `GAP:` names (free text is a failed drives write / INCONCLUSIVE); the drives check runs each affected criterion's whole proof twice and drive files must pass W2's feature rules; negative expects need a creating step and fail on error pages, failed responses and empty reads; every mechanical criterion runs on the base first (`base-check.json`, one spec retry, NON-DISCRIMINATING flag); the builder can't touch `test` proof files, what Gate runs through or package.json `scripts`, and a seed/migration diff is high risk and listed for review; cmd proofs stay in the worktree, bridge results are redacted; cmd/test imply exit 0; a repro's timed-out wait counts only for the expect's own text; judged needs appearance/copy and a screenshot; `repro: true` only on bugs; a refused manifest is INCONCLUSIVE; `--save <var>` on a primitive proof segment (found by the real run). The W1 stub-bound paths are ported to fixture A (`spikes/w3a/paths.ts`: repro-retry, gap, bad-gap, inconclusive, backoff) and removed from `spikes/w1/paths.ts`.

**Proven:** the review's ticket ("admins see every user's projects with owner; regular users still see only their own") reached review on Claude with a negative criterion that creates bob's project first ($0.308; an earlier run, $0.583, found the `--save` gap), and the same spec FAILs a scripted builder that leaks every project. Codex not run: its account usage limit is reached until 2026-12-21. Attacks 26/26 (role-rule self-check case added), kill 8/8, paths 24/24, W1 paths 34/34. `npm test` 274/274, typecheck and lint clean.

**Still open:** Codex re-run of the admin ticket; W2's sandbox-exec for cmd/test proofs (marked `// W2 sandbox:` in `prove.ts`); `toolkit check --feature` remains this wave's chain check until W2's `check.ts` is wired in; ready/report (W3b/W4).

## Wave 3b: Toolkit stage, forge, benchmark (built, awaiting review)

**Built**
- **Jobs run the engine-owned Toolkit.** `toolkitRef` is a real sha from job creation (the base, when it has a Toolkit); every stage, the bridge and `kitchen drive` run `bin/dev` from `_toolkit@<toolkitRef>` (`src/engine/job-toolkit.ts`), wrapped in sandbox-exec while the sha isn't merged. `prepare` reruns when the checkout changes. The repo's own `.kitchen/toolkit/bin/dev` is never run by a job.
- **Toolkit smith + stage** (`roles/toolkit-smith.md`, `src/engine/stages/toolkit.ts`): the smith works in its own engine worktree on `kitchen/toolkit/<job>-<n>` with the setup bridge (`toolkit`, `toolkit_check`) on it; the engine commits only `.kitchen/toolkit/` outside `features/`, requires describe to list the gap, runs the full `toolkit check` of that commit sandboxed, opens the Toolkit PR via the forge, pins `toolkitRef` to the commit. `roles/_proofs.md` gained one bullet: name the missing primitive rather than work around it (shared file; the W3a fixer owns the spec role).
- **Ready** (`stages/ready.ts`): open Toolkit PR → paused(toolkit-pr); sync with the base by engine merge (`mergeRev`) → conflict → build (merge restarted with markers for the builder, concluded by the engine's commit; base-only files pass the layer rules when they equal the base) / clean → base and toolkitRef move, push, Gate/drives/Verify again; CI from the forge → paused(ci) / red → build (`ci.md`); gate still valid → report. Machine: `ready>gate` and `ready>drives` carry `newBase`/`toolkitRef`.
- **GitHub forge** (`src/forge/github.ts`), implementing W4's `Forge` after the merge: `gh` with the engine's env; draft PR found by branch, `label`, checks, merged, comments and Toolkit tickets idempotent by a hidden key marker, `markReady` (report → done), `reviewComments` (conversation + inline, with `author_association`, Kitchen's own left out), `openPr` (maintain), `publishEvidence` (fetch the remote `kitchen-evidence`, commit W4's redacted bundle on top with `evidence-branch.ts`, push, never forced). My own evidence module was dropped for W4's; its pruning had the same `.git/`-prefix bug mine had (`ls-tree`/`rm --cached` from a gitdir inside the work tree matched nothing), fixed there with `--full-tree`/`:(top)`. **Engine push/fetch** (`engine/git.ts` `pushTo`, `fetchFrom`): explicit URL, `--receive-pack`/`--upload-pack`, credentials for those two only; the base is `refs/kitchen/base` (`src/engine/base.ts`). **Issue source** (`src/sources/github.ts`): the `kitchen` label is the trust boundary; replies from the author or operators only. The runner polls the source each tick.
- **Report:** built an engine placeholder template for W3b's runs; dropped at the merge for W4's report role (W4 owns `report.ts`/`review.ts`). One line added there: `forge.markReady` after the PR comment.
- **`http --expect_status`** (asked by W4): the template's browser daemon, fixture A's driver and fixture C's bench Toolkit accept `expect_status`, ok only for that status, so a proof can assert a 403/404; without it a 4xx is still ok:false (`spikes/w3b/http-status.ts` 3/3).
- **Benchmark** (`bench/`, `src/bench/`): 14 tuned tickets on A–C and 6 held-out on D, hidden oracles in the spec format run through `prove()` on the final branch, `kitchen bench smoke|full|tuned|heldout`, ledger lines and `bench/results/`, `kitchen report --bench`. The W2 Claude-generated Toolkits of B–D are kept in `bench/toolkits/`.
- Toolkit template: a `cli` argv string splits like a shell line (found by the smoke run).
- Spikes `spikes/w3b/`: `forge.ts`, `ready.ts`, `toolkit.ts fake|claude`, `oracles.ts`, `oracle-on.ts`, `github-live.ts` (written, NOT run: needs the user's approval and a throwaway repo).

**Proven** (`spikes/w3b/results.md`): the new-primitive job end to end on Claude through the GitHub forge shim (19/19, 922 s, $0.61, the smith 737 s); the same with a scripted smith 19/19; Ready's waits and returns 19/19; forge, source and evidence branch 35/35; every benchmark oracle fails on the base and planted bugs' pass with the plant out (20/20). Benchmark on Claude (run before the W4 merge, so with W3a-era review/report): smoke 5/5 after one Toolkit-template fix (2/5 before it); the full tuned + held-out set three times: **53/60 runs correct (88%)**, no `done` job failed its hidden oracle in 60 runs, 0 false FAILs on the controls, held-out 94% vs tuned 86%, traps 3/3 on two and 2/3 on two (the misses stopped at needs-human), median ~60 s and $0.15 per ticket, **$11.61** in all. `npm test` 306/306, typecheck and lint clean; w1 paths 34/34, faults 27/27.

**Owed**
- superchat-lite: the end-to-end ticket of the W3b exit and the 6-replay held-out set (its stack is over this laptop's Docker budget). Codex: everything Codex in W2/W3a/W3b (quota until 2026-12-21), and the §0.3 subset.
- `spikes/w3b/github-live.ts` against a real throwaway repo (user approval).
- `test` proofs get no app URL (W4 found it: they assumed port 3000). `proof/prove.ts`/`stamp-cmd.ts` are the W3a fixer's files; the fix is to record `up`'s url per slot and pass it as `KITCHEN_APP_URL` to cmd/test proofs.
- The benchmark numbers predate W4's review lenses and report role; re-run `kitchen bench full --runs 3` on the merged code.
- Misses worth a role look (W3a/W4 roles): intake's inline criteria on `cli` output shapes, repro/drives writing for CLI tickets, a review lens blocking a one-word rename for 3 rounds.
- Dogfooding has not started.

**W3b review fixes** (`spikes/w3b/results.md` "Review fixes", PLAN "Changes from the Wave 3b review"):
- B1: the smith's proof is judged against the base's own check (once per base sha, cached; drives that already fail on the base are tolerated as known and named in the PR; the contract probe, every drive using the new primitive and every drive passing on the base must pass); a base that can't run its drives is an engine error. `toolkit → toolkit` gives the smith its second try from its first commit with `toolkit-check-<n-1>.json`. w3a `gap` 5/5 (was 2/5), `toolkit.ts buggy` 9/9.
- M1 Ready publishes HEAD before reading CI; M2 a sync resolution that would drop a base change aborts → needs-human; M3 "merged" on the GitHub forge = in the fetched `refs/kitchen/base` only; M4 `Forge.prState`, a closed Toolkit PR → needs-human, closed job PRs never reused; M5 the ADR 0008 Docker guard (validating proxy outside the sandbox, daemon sockets denied inside, `docker` shim), whose two proxy bugs the fixture's real runs found; M6 a behavioural a-primitive oracle.
- Minors: CI grace window for "no checks yet" and one re-read of a cancelled run (`ci_grace_sec`); issues edited after their label event are not taken in; replies by thread position; bench (a-too-big never builds, per-drive tally, oracle infra retry, sha label); stale git comment; pruning ≠ deletion (ADR 0006). The README line on pruning is left to W5 (it owns the README).
- Found while proving: concurrent spikes from other agents in other `KITCHEN_HOME`s collide on slot ports (each home has its own slot registry; the port probe races Colima's forwarder). Not a product bug for one Kitchen per machine; reruns were sequential.

**Review round 2 fixes** (`spikes/w3a/results.md` "Review round 2 fixes", PLAN "Changes from the Wave 3a review (round 2)"):
- The spec must match the ticket, by structure (ADR 0003): intake writes `## Requirements` (R1..Rn, negatives and rescopes marked), every criterion `covers:` some, and spec-lint rule 7 refuses an uncovered requirement, a criterion covering nothing, or a negative requirement no covering criterion asserts an absence for. The reviewer's ticket, verbatim, on Claude: intake split it into R1–R4 (two negative), the spec's R4 criterion refuses "alice" in alice's own project list, PASS to review ($0.382); `wrong.ts owner` (owner shown to everyone, per-user list kept) FAILs exactly that criterion.
- Base check after drives: criteria that needed a new drive or test run on a base checkout plus only the new drive/test files (`phase: base`); a pass is NON-DISCRIMINATING in the verdict, the verifier's prompt and the review prompt.
- cmd/test proofs run under a `sandbox-exec` profile (`src/proof/sandbox.ts`: loopback only, `$HOME` unreadable, worktree-only writes, credentials/`$KITCHEN_HOME`/job folders denied; Linux UNSANDBOXED); evidence is redacted when written. `contain.ts` 11/11 (key read, env dump, urllib, raw socket, `.env.kitchen`, outside write, job.json; controls show each succeeds unsandboxed). Found while proving it: `allow network* (local ip …)` let outbound sockets through.
- New `check:` lines run alone from seed in the drives stage (`paths.ts nondisc`: a drive that works only after the proof's login is caught, fixed on attempt 2).
- `$o == ""` is a negative for the lint; the builder policy is a rule table.
- Spikes: contain 11/11, attacks 26/26, kill 8/8, paths 34/34, wrong owner 5/5 and leak 4/4, e2e claude admin 12/12, W1 paths 34/34. `npm test` 294/294, typecheck and lint clean. Real-agent spend $0.382 (Claude); Codex not run (quota).
- Merged main's W2 round 2 (sandbox module now `src/toolkit/sandbox.ts`; the proof profile reuses its deny list).

**Open after round 2:** the app the Toolkit starts, the primitives of a merged Toolkit, Gate's checks and the builder's `checks` tool are still unsandboxed; Linux has no proof sandbox; the base check after drives needs a `prepare` of the base checkout (one extra prepare per job with new drives); the coverage rule trusts intake's reading of the ticket (short, quoted, shown to review).

## Wave 4: review, report, feedback, maintain (done, 9/10, conditional)

**Review rounds:** 6.5 → 8.5 → 9.

**Conditions:**
- the Codex smoke, once the quota returns on 2026-12-21;
- the §0.2/§0.3 benchmark run on the final main.

**Observed flake:** in one scripted run the security lens's VIEW returned no evidence while other spikes' containers were running at the same time; two reruns were clean. A slot collision between concurrent runs that each have their own `KITCHEN_HOME` is suspected but not proven.


**Built**
- Review lenses `roles/reviewer-code.md`, `reviewer-security.md`, `reviewer-ux.md`, `reviewer-ui.md` and the shared findings format `roles/_review.md` (read tier, medium model). Routing from the risk path and surfaces (`lensesFor`), lenses in parallel up to `concurrency`, one packet for all (requirements, contract, verdict with NON-DISCRIMINATING flags, verify.md, seed-diff.md, diff); a `human: always` path labels the PR `kitchen:review-required`.
- `src/checks/findings.ts`: the engine decides what blocks. A finding blocks only when it is demonstrable (a line at HEAD, a requirement in scope, evidence in the verified manifest; every anchor it names must hold) and its confidence isn't low; the rest are notes with the reason. Same line or requirement across lenses → one finding. Per-lens counts to the ledger (`review-lens`); `rounds/<N>/review.md` + `review.json`; the builder's next round gets only what blocked. ADR 0003 updated.
- UX/UI: Verify's screenshots copied where a read-tier agent can open them; `VIEW:` lines run through `src/engine/views.ts` (stamped `reviewer-<lens>`, `view:<lens>`), then the lens runs once more. `kitchen drive <job> --view "<view>"`.
- `kitchen dismiss <job> <finding> [--reason]` (dismissed.jsonl, `finding-dismissed` ledger line with the lens).
- `roles/report.md` + `src/checks/report-render.ts`: the role writes prose sections citing `{{e<N>}}`; the renderer refuses unknown ids, ids not stamped for the final HEAD, other placeholders, and a `human: always` report without `human-check` (which it then puts first); strips scripts, handlers, frames, remote URLs (plus a CSP); inlines screenshots; adds the engine's own sections (requirement → criteria → verdict → evidence thumbnails, findings, seed patch, cost and time per stage from the ledger, evidence appendix). Two refusals → needs-human (machine, unchanged).
- Publishing: `src/forge/evidence-branch.ts` builds the `kitchen-evidence` commit with git plumbing on a private index (one folder per job, pruned after `evidence_keep_days`); `Forge.publishEvidence` (replaces `pushEvidence`), `Forge.comment` with the per-criterion table and link, `Forge.label`, `Forge.reviewComments`, `Forge.openPr`; local and fake forges implement them (the fake forge's evidence branch is real).
- done → build from PR review comments: the runner reads them for done jobs; trusted (`feedback.trusted` / `feedback.trust_associations`) → one quoted feedback file and the move (machine fact `prComment`); untrusted → logged and ignored; each once.
- `kitchen toolkit maintain` (`src/toolkit/maintain.ts`, `roles/maintainer.md`, pstack's maintain-verification-skill, MIT, credited): source wave, live pass (full check of the base), Toolkit-only fix on `kitchen/maintain-<sha>`, the engine's full check of the fix commit, one PR via `Forge.openPr`; `.kitchen/maintain.json`. `kitchen run` starts it when feature-mapped paths churned past `maintain_churn_lines` (default 300), once per base.
- The spec role now sees human feedback (`kitchen feedback --to spec`).

**Proven** (`spikes/w4/results.md`): `scripted.ts` 26/26 (demonstrable finding → build, three kinds of non-demonstrable → notes, VIEW, merge, stats, planted id refused, self-contained report, evidence branch, PR comment, dismiss, untrusted ignored, trusted → build, `drive --view`); `e2e.ts ui` 12/12 ($0.354, medium, code+ux+ui, the UI lens's two views ran); `e2e.ts auth` 12/12 ($0.398, high, code+security+ux+ui, label, "what a human must check" first); `maintain.ts` 14/14 (the stale settings selector found and fixed in one proven PR, 95 s, $0.068; the churn trigger starts it once per base). `npm test` 315/315, typecheck and lint clean. Total spend about $2.25, including three auth tickets that didn't reach done (an intake rating, a lint-blocked absence, and `test` proofs that can't reach the app).

**Merge notes:** W3b's `forge/github.ts` must implement `publishEvidence` (push the branch `commitEvidence` builds), `label`, `reviewComments` (exclude Kitchen's own comments; `author_association`), `openPr`; `pushEvidence` is gone. `report.ts` and `review.ts` are rewritten; `ready.ts` is untouched.

**Review round** (independent review, then fixed; `spikes/w4/results.md` "Review round", PLAN "Changes from the Wave 4 review", ADR 0003): an `at:` anchor must be in the change (±3 lines of the diff), a requirement alone blocks only when its criteria are all NON-DISCRIMINATING, evidence must be stamped for HEAD; one re-ask for a fixable anchor; `VERDICT: BLOCKING` with nothing readable is refused once then `needs-human` (`review-unparseable`); merges only on the same file:line ±1, keeping every member's text; `kitchen dismiss` takes effect (builder ignores, lens doesn't re-raise, a re-raise is a note); the report sanitizer is a tokenizer + allow-list (no agent images) and refusal reads the sanitized page; citation warnings; PR comments count only after done, Kitchen's own carry a marker, handled-once keys written with the move; prune keeps live jobs; views hold the (re-entrant) drive lock; PR-comment markdown escaped; proof lines read `\"` like the drive format. Proven: `scripted.ts` 35/35, `e2e.ts xss` 14/14 (a planted raw description after real intake and build: code + security block at server.js:264, round 2's real builder fixes it, review passes, the report lists what blocked; $0.296), `maintain.ts` 15/15 ($0.069). `npm test` 329/329, typecheck and lint clean.

**Merge notes (review round):** W3b's `forge/github.ts`: `publishEvidence` gets `keep` (pass to `commitEvidence`); `reviewComments` must return each comment's `at` and `author_association` (Kitchen's own may be returned: the runner drops `KITCHEN_MARKER`).

**Review round 2** (`spikes/w4/results.md` "Review round 2"): a requirement-only finding's evidence must be this lens's own view or a run of a criterion covering that requirement (else a note); every lens may write `VIEW:` (code and security too; the second pass gets every file of the view's runs); a dismissed finding is re-raised only by the same lens on the same line ±1 or the same requirement with a similar title; `doneAt` (stamped on the move to done) is the PR-comment cutoff; adapters report what ran (`ran`), so the cost table names the real adapter and model under a scripted wrapper (`reports/xss-planted.*` re-rendered from the saved job, no agent call). Proven: `scripted.ts` 38/38; `npm test` 343/343, typecheck and lint clean.

**Open:** Codex (all of W4); `test` proofs have no app URL; `http` can't assert a 4xx.

**Open:** Codex (all of W4); `test` proofs have no app URL; `http` can't assert a 4xx; the independent review round.

## Wave 5: learning, dashboard, release prep (reviewed and fixed; v0.1 not done: see the exit below)

**Built**
- **`kitchen report`** (`src/ledger/measures.ts`): every §0 measure from the ledger alone: merge-ready rate over tickets taken in, first-pass verdict rate, rounds per job, escalation reasons, Toolkit gaps and primitive PRs per job, INCONCLUSIVE and flake per drive (and per Verify verdict), time and cost per job and per risk path, findings dismissed per lens; `--json`. Verify now writes one `proof` ledger line per proof run (criterion, drives, HEAD, result, gap); the bench records INCONCLUSIVE and flaky per run.
- **Retro** (`src/retro/`, `roles/retro.md`, `kitchen retro [status | unmute | approve]`): a stage outside jobs, started by `kitchen run` every `retro.every_jobs` finished jobs. Dismissals from `kitchen dismiss` and from trusted "not useful" PR replies (read through `Forge.reviewComments`) mute a (lens, category) after `mute_after`, engine-applied in review (`mutedFinding`, one line in `review.ts`), never for security; lesson signals (same gap, unreliable proof chain, repeated escalation, a blocking category) become at most `max_tickets` drafts per cycle through the new `TicketSource.draft` (GitHub: an unlabelled issue; prompt: `.kitchen/retro/drafts/`), written by the cheap-tier role, which prefers a lint rule, then a check, a Toolkit fix, AGENTS.md last.
- **Dashboard** (`dashboard/dashboard.html`, `src/dashboard/`, `kitchen dashboard`): board by stage, job cards (title, risk, kind, round pips, verdict chips, review, cost, time, PR, Report link), the measures on top, a "needs you" strip; light/dark; served on 127.0.0.1 only, GET only, Host-checked.
- **`kitchen migrate [--dry-run]`** (`src/migrate/`): `kitchen.yaml` `version: 1` (init writes it), text-level migrations that keep comments, and the Toolkit template's generic files, each shown as a diff.
- **`test` proofs get the app URL** (W3b open item): `up`'s url per slot in `app.json`, `KITCHEN_APP_URL` for cmd/test proofs; `roles/_proofs.md` says so.
- **Release prep for 0.1.0**: package.json (files allowlist, engines ≥ 20.11, MIT, repository placeholder, prepack build), `LICENSE`, `kitchen --help`/`--version`, `kitchen init --skill` (so `/kitchen` can run setup), the template's `.gitignore` written by init (npm drops it), `kitchen bench` refuses to run from the package, `docs/RELEASE.md` (publish steps; not published).
- **README**: 5-minute quick start (install, models tip, `/kitchen` or terminal setup with what to approve per tool, merge the Toolkit, ticket, run, report, merge), concepts, learning, every config key, safety model, known limitations, credits (pstack MIT; zazencodes' factory, GPL, ideas only), license.
- Fixed on the way: concurrent `kitchen-evidence` commits raced on `update-ref` (a per-repo lock).

**Proven** (`spikes/w5/results.md`): retro scripted 18/18 (mute after 3, ≤ K drafts, re-run files nothing, unmute, approve) and one real haiku retro ($0.011) that wrote a concrete Toolkit fix; `kitchen report` on a copy of the W3b benchmark ledger (55 jobs, `spikes/w5/report-w3b.txt`); dashboard 11/11 with fixture A jobs from a scripted run, screenshots light and dark mid-run and at the end; app URL 3/3; evidence race 2/2; `npm pack` + tarball smoke 20/20; **newcomer test**: a fresh agent with only the README and the tarball took a fresh clone of fixture B to a done job in round 1 and merged it, $0.73; its 8 README issues are fixed. `npm test` 338/338, typecheck and lint clean; `spikes/w1/paths.ts` 34/34.

**Merge notes:** `review.ts` gained one import and a 4-line map after `judge` (the mute); `runner.ts` gained the retro call before `finally` (not in the PR-comment path); `TicketSource` has a new required method `draft`. **For the W4 fixer:** `prCommentsBack` should skip a comment where `dismissedIn(body)` is non-empty, or a "not useful" reply also sends a done job back to build.

**Open:** Codex (all of W5); the real GitHub run (draft issues, PR replies); publishing (the user's step); the retro's categories are a keyword list (a `category:` line in the findings format would be exact, W4's file); the INCONCLUSIVE/flake counts for the W3b benchmark are backfilled from job files, and a fresh `kitchen bench full` on the merged code would record them natively.

**Review round** (`spikes/w5/results.md` "Review round", PLAN "Changes from the Wave 5 review"):
- M1: the dashboard spike has its own scripted agent (`spikes/w5/dashboard-agent.ts`); W4's script had changed under it at the merge. Every W5 spike re-run on the fixed branch: retro 19/19, pack 21/21, app-url 3/3, evidence-race 2/2, dashboard 13/13 (screenshots regenerated on purpose: the cards changed).
- M2: a `category:` line in the findings format (security, correctness, performance, naming, style, types, tests, docs, ux, ui), keywords only as the fallback, and a security veto in every lens: a finding about auth, tokens, sessions, permissions, ownership, injection, SQL, XSS, CSRF, leaks, secrets, passwords, credentials, deleting another's data or access is never muted.
- M3: a PR reply dismisses only the ids in the sentence that says "not useful" (or starts with 👎); the rest of the comment is still feedback; a security finding needs an explicit reason, recorded.
- Minors: GitHub drafts deduped by Kitchen's own issues (`--author @me`); migrate by the parsed YAML document (`---`, `%YAML`, flow maps, CRLF); retro checked every tick and reading only PRs of jobs done in `retro.lookback_days`; agent seconds beside wall clock in `kitchen report`; dashboard CSP and X-Frame-Options as headers, cards with the full id, last move and last step; RELEASE.md's first release; `NOTICE`; `kitchen <cmd> --help`.
- `npm test` 359/359, typecheck and lint clean.

**First dogfooding** (PLAN §0.5): Kitchen on a scratch clone of its own repo, Claude sonnet, local forge, prompt tickets. Setup 277 s, $1.05, Toolkit proven (surface `cli`, a seeded target repo, the dashboard on the slot port). Six tickets from open items: **4 done** (002 `migrate --dry-run` exits 1 when files would change, 003 `dismiss <job>` lists findings, 004 `status --json`, 005 a status summary line; 004 and 005 only after a person's hint), 1 correctly refused (001: the ticket's premise was false), 1 stuck (006 `kitchen version`). $3.67 in all. My review as the human: 004 mergeable as is (cherry-picked); 002, 003 and 005 had good cores but tests outside the repo's layout (a new `tests/`/`test/` dir and a vitest include change, a helper that would ship) and were merged by hand without that. What it found: spec-lint deadlocks on "X stays unchanged" CLI requirements (5 of 6 first intakes refused); a CLI bug whose base exits non-zero can never be reproduced (`step-failed`, 006 twice); test proofs ignore the repo's test layout; low risk has no review lens; gate can't typecheck a Node repo (no `node_modules` before `prepare`); slots are per `KITCHEN_HOME` while ports are machine-wide (my first run collided with the concurrent benchmark for ~5 minutes; its runs on slots 0, 2 and 3 in that window should be checked).

**W5 exit, honestly.** W5's own build is done and proven. v0.1's §0 is not all met:
- §0.1 setup: met on Claude (A–D in W2; Kitchen itself today). Codex: open until 2026-12-21.
- §0.2 benchmark: 88% and 0 false FAILs on pre-W4 code; traps 3/3 on two and 2/3 on two (not met). Pending the orchestrator's final benchmark on merged main.
- §0.3 Codex subset: open until 2026-12-21.
- §0.4 kill and resume: met.
- §0.5 dogfooding: not met (4 own tickets done, 2 with help; needs 5 to ready PRs). The superchat-lite ticket needs a bigger machine.
- The ledger measures and the newcomer test: met.

**Open:** dogfood findings 1–2 (spec-lint on unchanged-behaviour requirements; repro of non-zero-exit CLI bugs) before the next dogfood round; one machine-wide slot registry; Codex (all of W5); the real GitHub run (draft issues, PR replies); publishing (the user's step).

## W5 follow-ups: dogfooding findings and the W3b round-2 guard items (branch `w5-followups`, built, not reviewed)

Based on the W5 review fixes, with main's W3b review fixes merged in (the Docker guard and the base check live there).

**Built**
- **One slot registry per machine** (finding 6): `~/.kitchen-slots/slots.json` whatever `KITCHEN_HOME` is (`KITCHEN_SLOTS` only for tests), same lock; a block is handed out only when every port binds on 127.0.0.1 and 0.0.0.0 and no container publishes it (`docker ps --format '{{.Ports}}'`).
- **`(unchanged)` requirements** (finding 1): intake marks a regression guard apart from a true `(negative)`; rule 7 asks an absence assertion only of a negative, a mechanical criterion (positive is fine) of a guard; a criterion covering only guards isn't counted as non-discriminating by the base check.
- **`cli` reports the exit** (finding 2): the template's `cli` (and the b-cli bench Toolkit's) is ok whenever the command ran, `{exit, stdout, stderr}`; `prove()` takes the last command step's exit, so `expect: exit 1 and contains "unknown command"` reproduces a wrong-exit bug; with no `exit` in the expect, exit 0 is required (as for `cmd`). `expect_exit` still pins a step (setup steps that must succeed).
- **`checks_prepare`** (finding 5): kitchen.yaml's `npm ci` runs in the worktree under the checks' sandbox before Gate's checks, the builder's `checks` tool and every `cmd`/`test` proof, stamped, cached by lockfiles. Chosen over the Toolkit's `prepare` (which may install into a container).
- **Test layout** (finding 3): `src/checks/test-layout.ts` reads the runner's globs; intake, spec, builder and the verifier's repro/drives prompts get them with existing tests; spec-lint rule 8 refuses a `test` proof outside them; the builder policy refuses test-runner config and a changed package.json `jest`.
- **Low risk with tests or config gets the code lens** (finding 4), like a drive diff.
- **Docker guard, existing containers** (W3b round 2): exec, archive, attach, logs, kill, stop, start, restart, rm, update, export, inspect, commit and network connect only for containers created through the guard (ids recorded per repo, names resolved through the daemon); prune and host-network builds refused. ADR 0008.
- **Base-check flakes** (W3b round 2): a drive that fails on the base runs once more after a reset; passing then, it is `flaky`, not cached as known.
- README: `checks_prepare`, the guard and machine-wide slots in the limitations, scratch dirs under `$HOME` for Docker-using spikes with Docker Desktop.

**Proven** (no agent calls, $0): `spikes/w5/slots-machine.ts` (two processes with different `KITCHEN_HOME`s, one registry, no overlapping blocks, a block with a port held by a node listener on 127.0.0.1 skipped) 4/4; `spikes/w5/checks-prepare.ts` on a clone of Kitchen's own repo (Gate FAIL without `checks_prepare`, PASS with `npm ci` in the sandbox, cached on the next Gate and for a `test` proof, again after a lockfile change) 7/7, 16 s; `src/proof/prove-cli.test.ts` (the real template primitive in a fake Toolkit: "unknown command exits 0 instead of 1" is assert-fail on the buggy base, pass once fixed; a base exiting 2 is reproduced); `src/toolkit/docker-proxy.test.ts` (the proxy process against a fake daemon socket: its own container exec'd and removed by a second proxy, `supabase_db_offstage` exec/kill/archive refused and never forwarded). `npm test` 415/415, typecheck and lint clean.

**Not run** (the orchestrator's benchmark was using Docker; `docker ps` showed `kitchen-a-web-001-…`): `spikes/w3b/docker-guard.ts` against real Docker with the ownership rule; a Toolkit `up` on the machine-wide registry; a dogfood round on the fixed engine.

**Open:** the Docker proofs above; a Toolkit's containers created before the guard recorded them can't be stopped by an unmerged `down` (one-time cleanup); `checks_prepare` trusts its marker if a builder deletes `node_modules`; the next dogfood round (§0.5).

## Benchmark regression and fix (branch `worktree-agent-a2bb49b52b5c34026`, off main dd02b29)

The full benchmark on main 5ba38c6 stopped at ~35/53 correct (66%) against 88% before W4/W3a round 2. Diagnosis per class, from the job folders, in `spikes/regression/README.md`. The repair loop the brief asked for already existed (a refused move re-runs the stage once with `intake-refused.md`/`spec-refused.md`); what failed was what it was fed: rule 7 and rule 3 deadlocked (a `(negative)` requirement needed an absence, and an absence was accepted only when an earlier step created its text, which no negative about what exists **today** can satisfy), one problem was reported per retry, and four engine gaps sat behind the rest.

**Built**
- **Rule 3, negatives backed three ways** (`negativeBacking`): (a) made by an earlier step (its text, or a 5+ letter word of what a writing step was given); (b) a value a step reads and saves (`$amt != "8910"`, `$b not contains "true"`: assert.ts already fails an unsaved, empty, missing or failed value); (c) anything else goes to the base check, run before the build (intake now runs it for low-risk inline criteria, on the job worktree; spec for its own) and the clause must be FALSE there. One that holds on the base, or whose proof doesn't run there, is refused with how to fix it. `$o == ""` without a making step is still refused at once.
- **Every lint problem at once**, one per line; the rule 7 and base messages say what backs an absence and when a requirement is `(unchanged)`. The spec may re-mark one `(negative)` requirement `(unchanged)` in its own `## Requirements` (`withSpecMarks`), read by base check, review and report.
- **A regression guard must hold on the base** (intake and spec refuse one that fails there).
- **Repro**: lint refuses `expect: ok` alone, `read --equals`, and a step pinned to the bug's own outcome; the **repro contract loop** sends the contract back once to intake (low risk) or spec when its own proof can't reproduce on try 1 or the repro role can't write the drive it names (`repro>intake`, `repro>spec`, `attempts.contract`).
- **Command output**: `json`/`rows`/`--save` read a `cli` step's stdout; `contains` reads stdout and stderr (a `cmd`/`test` proof too); `exit` the code.
- **Error page beside its own assertion**: a negative is judged when a positive clause of the same expect names and shows that error.
- **Seed users**: the Toolkit block lists describe's `seed_users` (it read `seedUsers`, so roles never saw them); rule 9 refuses `--as`/`username = '…'` for a user who isn't one and no earlier step made. A JSON-looking `argv`/`body` must parse.
- `roles/_proofs.md`, `intake.md`, `spec.md`: the negative, repro, cli, guard and user rules.

**Proven**
- Before any fix, the failing tickets once each on main dd02b29 (W5 follow-ups in): 8/10 (`bench/results/2026-11-22-subset-claude-main-dd02b29.md`); the two misses were the negative deadlock again.
- Iterations, one ticket at a time on the fix: d-chore-subject 1/1, then 8/9 (a-primitive refused a boundary negative it couldn't re-mark), then a-primitive 1/1 with the re-mark, then a-invite-case, a-primitive, b-control-long-title 3/3.
- **Full benchmark on e75efe0, 3 runs: 54/60 correct (90%)** (`bench/results/2026-11-22-full-claude-fix-e75efe0.md`). Traps 12/12. False FAILs on controls 2 of 9 runs (both were the contract's own errors: a 200-character literal miscounted, a guard reading `json .ok` on an http wrapper). Tuned 90% (38/42), held-out 89% (16/18). INCONCLUSIVE 0/128 proof runs. $12.27, 58 min wall clock. Misses: 4 contracts the builder found wrong (two now refused before the build: the guard rule and the repro pin, commit 3543505), 1 miscounted literal, 1 infrastructure (`claude not found in PATH` in a reviewer subprocess).
- After the last two rules (3543505): b-stats-overdue, d-qty-100, d-control-version 3/3 (`bench/results/2026-11-22-targeted-claude-3543505.md`).
- Strictness: `spikes/w3a/engine.ts attacks` 26/26, `paths.ts repro-retry nondisc` 15/15 (repro-retry 5/5 again on the final code), `contain.ts home` 20/20, `spikes/w1/paths.ts` 34/34 (the low-risk unreproduced bug now goes intake → repro → intake → repro → repro → needs-info), `spikes/w4/scripted.ts` 38/38, `spikes/w5/retro.ts` 19/19. `npm test` 422/422, typecheck and lint clean. `wrong.ts` not run: it replays a real `e2e.ts admin` run's folder, which this machine doesn't have; the trivially-true admin negative is covered by the unit test (it holds on the base, so it is refused).
- Spend: about $24 of real-agent runs (baseline subset $2.15, iterations $4.7, a full run stopped at 21/60 to fix what it showed ≈$4.8, the full run $12.27, targeted $0.50).

**Open:** the most common remaining miss is a contract the builder rightly calls wrong (`STATUS: BLOCKED`) → needs-human; a build → contract-author loop (once, like the repro's) would catch it, but for a bug it must redo the repro on the base, so it needs its own design. The per-drive flake tally counts any pass and fail on one tree, builder self-checks included, so its rates (cli 29%) overstate flakiness. The final full run is on e75efe0; 3543505 adds two refusals measured on the three tickets they target only.

## Final fixes (branch `worktree-agent-aa6157fde71a755c8`, off main a148abc; ON HOLD before the agent proofs)

The review of the regression merge (W3b 8/10, W5 7.5/10) found strictness holes in spec-lint and the base check, two control false FAILs, held-out contamination, §0 judged by hand and a `checks_prepare` tamper path. All fixed and proven without agents; the dogfood round and the full benchmark were stopped by a hold from the user (only the dogfood's `kitchen init` had run, $0.57).

**Built** (commits on the branch)
- `2458c3b` **Strictness.** H1: rule 3(b) backs only `!=` on a value saved after a making step; `$page not contains …` on a saved read, or a value read before any write, goes to the base check; assert.ts applies the error-page and failed-response rule to saved vars. H2: a spec re-mark keeps the requirement negative (rule 7 still asks for the absence); it only lets the absence hold on the base, as a guard that must run and pass there; refused on a security job (`remarkProblems`, `withSpecMarks(…, {security})`, `jobRequirements` reads the job's surfaces). H3: `runBaseCheck` runs on a checkout of the base (`.worktrees/<id>.base`, the helper now shared with `runBaseCheckAfterDrives`) once HEAD has moved; without a Toolkit it runs the `cmd`/`test` criteria; `baseNegativeProblems`/`guardBaseProblems` refuse when nothing could run (never `[]`); intake runs the base check without a Toolkit too. L1: (a) reads only making steps' args minus who/where (`--as`, `--user`, `--path`…). L2: a phrase holding a made word (a `cli`'s too) is backed only when a positive clause of the same expect shows that word. A feature drive's `--expect_status 4xx` in a repro is refused like a primitive's (a reviewer probe). Header comment renumbered 1–9 in order. **B:** an http step's `{status, body}`: `json`/`rows`/`--save` read the body (a key the body lacks reads the response), `--save v` keeps `$v_status`, `contains` reads the whole response (prove.ts `responseOut`); lint refuses a literal whose stated length ("a 200-character title", "exactly N", "longer than N characters") it doesn't have.
- `18dba4f` **E:** Gate (when it runs) and Verify (before its proofs) forget the `checks_prepare` marker, so `npm ci` reinstalls before anything is judged (`forgetChecksPrepared`).
- `b7530f4` **C (roles):** `_proofs.md` teaches with generic examples (no d-discount amounts, no d-api `read --target status`, no `json .body.ok`, no "the body stays the same"); documents http bodies, long literals, the new negative backing; `spec.md` says a re-mark still needs the absence and is never allowed on a security ticket.
- `67cdcea` (merged `78d1e11`) **C (held-out):** new fixture `fixtures/e-library` (lending library API, no deps, no Docker), its Toolkit `bench/toolkits/e-library`, 6 tickets with hidden oracles (e-search, e-renew features; e-returned-stuck planted bug; e-overdue-block trap; e-control-me control; e-needs-info), each oracle checked with no agent: FAIL on the base, PASS on a hand-written reference (scratch only), the trap FAILs the naive build. Written and committed before any run.
- `9cf7c49`, `22de3e4` **C/D (bench):** D marked tuned; d-status-filter's oracle reads `$bad_status`; `section02()` prints PASS/FAIL per §0.2 line (bench output, results page, `kitchen report --bench`, latest run in `kitchen report`), the control set named (tuned controls: a-control-desc, b-control-long-title, d-control-version; e-control-me counted beside); the per-drive tally reads Verify proof lines only (`measures.ts`); a run that ended needs-human on an agent adapter's infrastructure error (not in PATH, spawn, network) is rerun once and counted apart. bench/README.md says E is run once and never tuned on.
- `0d5ee59` PLAN "Changes from the final fixes"; `7e60c67` a test typecheck fix; `e701874` docker-guard spike section (h).

**Proven** (no agent, $0)
- Every reviewer probe is a must-refuse test (`src/checks/spec-lint.test.ts`: probes H1/L1/L2, H1 at run time, H2, the drive pin, the long literal; `src/engine/stages/base-check.test.ts`: H3 on a real git repo with HEAD moved; `src/proof/prove-http.test.ts`). With the old `spec-lint.ts`, `assert.ts`, `prove.ts`, `base-check.ts`, `context.ts` from a148abc swapped in, all 11 new/changed tests fail; with the fix they pass.
- `npm test` 432/432 (then +0 after the typecheck fix), `npm run typecheck` and `npx biome check .` clean (on 7e60c67).
- `spikes/regression/relint.ts` on the 5ba38c6 run and every regression iteration run: every formerly refused contract is accepted or left to the base check; nothing refused outright (two more clauses go to the base check than before: a-primitive-1's `$page not contains "Last login"`, now the re-mark-as-guard path, and b-done-many-3's `json .done != 3` after a `cli`, no making step).
- Spikes on 18dba4f–0d5ee59, one at a time: `w1/paths.ts` 34/34, `w5/retro.ts` 19/19, `w3a/engine.ts attacks` 26/26, `w3a/paths.ts repro-retry nondisc` 15/15, `w4/scripted.ts` 38/38; `w5/checks-prepare.ts` 9/9 on 7e60c67 (6a shows the hole: a tampered `tsc` made the cached Gate PASS; 6b: Gate's entry reinstalls and the tampered file is gone).
- Docker (e701874): `spikes/w3b/docker-guard.ts` 35/35 with the new (h): a kitchen-* container started outside the guard can't be exec'd, stopped, removed, read, inspected, killed or copied from inside the sandbox, stays running; prune refused; the sandbox's own container works. One real `kitchen toolkit up` of fixture A (KITCHEN_HOME in a scratch dir) took slot 0 in `~/.kitchen-slots/slots.json` (the machine-wide registry), app answered on 31000; `kitchen toolkit down --id` from a second process with another KITCHEN_HOME stopped it and freed the slot. `docker ps` identical before and after (only the supabase_* containers of another project, never touched); no kitchen-* left.

**Not run (hold):** the dogfood round (only `kitchen init` on a scratch clone at e701874: Toolkit proven, 119 s agent time, $0.57; no tickets run) and the full benchmark with the held-out set E.

**Open:** dogfood (5 tickets drafted: `kitchen version`, the `dismiss` usage line, `status --stage`, `json .[0]` paths, §0.2 in `report --json`); the full bench; `toolkit up` keeps waiting for Ctrl-C after another process's `toolkit down` (it then exits cleanly); a negative about a new feature's failure mode on a `cli` toolkit (b-done-many's "no partial update") must now be backed by a made thing plus a positive clause, or it is refused at the base check: watch for it in the bench.

## Interactive dashboard and steering (ADR 0009; branch `worktree-agent-ad29fff5f484aa98e`, off main 04f58cd; built, not reviewed)

**Built**
- **Engine verbs** (`src/engine/control.ts`), one function each for the CLI and the dashboard: `kitchen steer`, `kitchen pause`, `kitchen stop`, beside `feedback`, `reject`, `resume`. Pause and stop reuse the `paused` stage (`*>paused(by-you)`, reason `by-you` or `by-you: stopped`, no waitFor: only `resume` wakes it). Pause lets the current step finish: with no runner on the job it parks at once, otherwise the request waits in `jobs/<id>/control.json` and the runner parks the job after the step's move (`honorControl`). Stop kills the job's recorded process groups now (`reapGroups`), the runner drops the stage's result and parks it; resume runs the stage again. Resume on a job still running cancels a pause not made yet.
- **The thread** (`src/engine/messages.ts`): `jobs/<id>/messages.jsonl`, written only by engine code under a file lock. A steer is `sent`, then `read` by a role, `mid-run` or `next-role`. Answers and follow-ups (`kitchen feedback`) are recorded on it too. 4,000 characters at most.
- **Mid-run delivery** (`src/agents/claude.ts`): Claude roles run with `--input-format stream-json --output-format stream-json --verbose`. The prompt is the first user message; `runRole` hands the adapter a steer inbox and each unread steer is written to the agent's stdin as a user message, quoted as an operator note. stdin closes once a `result` arrives and every written message was answered (an assistant event after it), or 5 s after (`ClaudeStream`). Cost, turns, session, out file, rate-limit text and process-group tracking read as before. Codex, engine-only steps and paused jobs: the next agent role's prompt opens with the unread steers as `## Operator notes`.
- **Activity**: every adapter tees its events to `jobs/<id>/activity/m<moves>-<role>-<t0>.jsonl` (recorded on the agent run as `stream`). `src/dashboard/activity.ts` parses them, or the Claude session transcript for older runs, incrementally: reasoning lines, tool calls with targets and durations, Edit/Write +/− counts, Bash and bridge outcomes; Codex `exec --json` items too.
- **Dashboard** (`dashboard/dashboard.html`): the approved v4 mock-up on real data, its CSS verbatim. List (default, remembered) and Board, the docked panel (stage track; Activity, Checks, Changes), the Setup run with its questions answerable in place, one composer per job (answer, steer, note while paused, follow up; Pause, Resume, Stop, Reject beside it), New ticket, live line with the shimmer on the call in flight, timers, `J`/`K`/`R`/`Enter`/`Esc`/`⌘K`, light and dark, 400 px. Polls `/data.json`, `/jobs/<id>/detail.json`, `/setup.json`.
- **Server** (`src/dashboard/server.ts`, `actions.ts`): `POST /api/<verb>` for steer, answer, follow-up, pause, stop, resume, reject, ticket, setup-answers, each the CLI verb's function. Every POST needs the Host check, a same-origin `Origin` when one is sent, the per-launch 32-byte token in `x-kitchen-token` and `application/json`; bodies over 16 KB and texts over 4,000 characters are refused. Geist and Geist Mono are bundled (`dashboard/fonts`, OFL; NOTICE) and served by the server: `font-src 'self'`, nothing from elsewhere.
- **Data**: `snapshot` gains each job's state, phase, agent, question, live line, changed files (`liveDiffStat`, engine git, uncommitted and new files included), unread steers; `detail` builds the stage history from the ledger's moves with each entry's agent activity, verdict summary and the thread woven in by time; `setupView` reads `.kitchen/init/` and `setup-questions.json`. `answerSetup` is `kitchen init --answers <file> --detach`.
- `/kitchen` skill: steer, pause, stop, resume and the dashboard. README (Commands, Dashboard), `--help` texts, GLOSSARY (Steer).

**Proven**
- **Spike** (`spikes/w6-steer/`, two haiku calls, $0.0034): a user message written to `claude -p --input-format stream-json` while a Bash call runs is taken right after that call, in the same turn (one `result`, `num_turns` 2); the session waits on stdin and exits about 0.6 s after it closes; the result line is the `--output-format json` object. Then Kitchen's own `ClaudeAdapter` on a real claude: steer queued 1.5 s in, read at 9.4 s right after `sleep 6`, acted on (the out file has its line), cost and tokens read.
- **Tests** (+30): the verbs (steer refusals, pause now vs after the step, resume cancels a pending pause, stop kills a real process group), delivery through `runRole` with the fake adapter (operator notes next-role; inbox mid-run), the stream-json adapter against a stand-in `claude` (message taken in the turn, usage, stdin close rule, error line), transcript and Codex parsing (incremental, torn lines), the must-refuse POSTs (no or wrong token, other origin, other Host, simple-request content types, oversize body and text, unknown action), the token in the page and the CSP, Setup questions and answers, the machine row. `npm test` 465/465, typecheck and lint clean (lint needed `spikes/w3b/docker-guard.ts` reformatted: it failed on main).
- **End to end in a browser** (headless Chromium via Playwright) on a copy of the dogfood repo, a real `kitchen dashboard` and a real `kitchen run` with a stand-in `claude` (stream-json, no model, $0): a ticket filed from New ticket; its intake agent's live line, timers and shimmer; a steer sent from the composer was written to the running agent and marked `read by intake, mid-run` 0.2 s later (`messages.jsonl`), the agent's next line answered it; Stop killed the agent's process group and parked the job (`paused`, `by-you: stopped`); a note sent while stopped stayed `sent`, Resume returned it to intake and the new role read it `next-role`; Pause while running wrote `control.json` and, the step having moved the job to needs-info, was dropped as it should; Pause and Resume from a row with no runner parked and woke 006 on disk; an answer to 006 from its Reply moved it to intake with the answer on its thread. Setup: a real `kitchen init` (stand-in claude) on a scratch repo from fixture b-cli stopped with two questions; answered from the panel, `setup-answers.json` was written and init resumed detached (then failed at build, as the stand-in says BLOCKED). Light, dark and 400 px: no horizontal scroll, no request to another origin, no page errors. Screenshots compared with the mock-up at the same sizes.

**Not done / open**
- Pause after a step that moves the job to another active stage is covered by the unit test and the runner code, not by the browser run (the stand-in intake always asks a question).
- Reject has no undo in the engine: the page holds it for the toast's five seconds and sends it after (the mock-up's Undo).

**Review round 1 (7/10) and its fixes**
- Steers survive a role that fails, is stopped, times out or never starts: `runRole` puts every steer the run read (next-role or mid-run) back to `sent` (`messages.unread`) and awaits its mid-run marks before it returns. In the browser: steer → read mid-run → Stop → back to `sent` → Resume → the new role's prompt opens with both notes.
- A late steer (`spikes/w6-steer/late.mjs`, one haiku call; its first version had a bug that wrote a steer on every turn and looped about 70 one-line turns before it was killed, $0.0069 in all): a message written while the final answer is generated is not seen by that answer; Claude Code starts a new turn for it once the `result` is out (a fresh `system init`). `ClaudeStream` counts a message answered only after a turn boundary (a tool result or a new `system init`) and keeps stdin open for that turn. `total_cost_usd` is cumulative across results; `num_turns` and `usage` are per turn and are summed.
- Pause and stop are decided under the job lock (a live runner in a step keeps the job and parks it after); `control.json` is written under a file lock; a job paused by you keeps no `kitchen run` alive, and the page shows a bar with `kitchen run --detach` and a Copy button whenever work waits and nothing works the queue.
- Timers: a row shows the time in its stage (the panel's running segment shows the same), "waiting Xm" for a job that needs you, frozen while paused; the job's age only in the panel. One round (job.json's) on cards and the timeline (`kitchen status` still prints rounds used of the budget, `1/3`). Cost today and in all come from the same ledger lines, labelled. An unread message keeps its segment open. A repro's question is the Repro agent's; a move back to an earlier stage (drives → gate) reads as sent back.
- Hygiene: job ids only in data attributes, one delegated listener; `Object.hasOwn` for actions; 400 on a malformed `%`; 413 refused unread, connection closed; utf8 decoding of streams; execa no longer buffers stdout; dead fields removed; one stage-name list (`STAGE_NAMES`, `PHASES`).
