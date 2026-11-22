# W3a spikes: proof and the core path, proven by running it

Asserting scripts that drive the real `kitchen` CLI (`node src/cli.ts … --repo <dir>`) as child processes against a **copy of fixture A** (`fixtures/a-web`), with its real Toolkit, Docker and Postgres. Each prints `PASS`/`FAIL` lines and exits 1 on any miss. Results: `results.md`.

Every script makes its repos under the scratch dir you give it (default `spikes/w3a/.work/`, ignored): a git repo holding the fixture's files, a `kitchen.yaml`, and a `KITCHEN_HOME` beside it. Nothing touches your repos or `~/.kitchen`. One Docker stack per job at a time; every stack is down when a script ends (`docker ps --filter label=kitchen.toolkit=a-web` is empty, which the scripts check).

```sh
node spikes/w3a/engine.ts attacks <scratch>   # scripted agent, no model (~6 min): repro, layer rules, code in a drive, forged/stale/self-check citations
node spikes/w3a/engine.ts kill <scratch>      # scripted agent, no model (~3 min): kill -9 mid-Verify, resume, no proof re-run
node spikes/w3a/paths.ts [scenario…] <scratch> # scripted agent, no model (~25 min): the W1 paths that needed real stages: repro-retry gap bad-gap inconclusive backoff
node spikes/w3a/e2e.ts claude feature <scratch>   # REAL agents: one feature ticket end to end (sonnet strong, haiku medium)
node spikes/w3a/e2e.ts claude bug <scratch>       # REAL agents: the planted bug end to end
node spikes/w3a/e2e.ts codex feature <scratch>    # REAL agents via npx @openai/codex@0.171.0, the config's tier map
node spikes/w3a/e2e.ts codex bug <scratch>
node spikes/w3a/e2e.ts claude|codex admin <scratch>  # REAL agents: the review ticket (admins see all projects; regular users only their own)
node spikes/w3a/wrong.ts claude|codex <scratch>      # no model: replays that run's spec against a builder that leaks every project; Verify must FAIL
```

`W3A_VERBOSE=1` prints every CLI line. Claude runs `/opt/homebrew/bin/claude` unless `KITCHEN_CLAUDE_BIN` is set. The real runs cost money: see `results.md` for what one run of each took.

## The tickets

- **feature**: "Show the signed-in user's display name in the header, and let them change it on /settings. Someone who never set a display name sees their username there instead." Fixture A has no display name, so this needs a migration, server changes and new feature drives.
- **admin** (review round 1): "Admins see every user's projects with owner; regular users still see only their own." The spec needs a negative criterion that first makes another user's project (spec-lint refuses one that doesn't); `wrong.ts` proves that criterion discriminates by replaying the spec, drives and tests against the real build mutated to show every project to everyone.
- **bug**: "Dark mode doesn't persist. I switch it on in Settings and it says Saved, but when I reload the page the app is light again." Before the ticket, the copy gets a real bug (`lib.ts` `BUG`): the theme update's `WHERE` names the wrong column, so it answers 200, updates no row, and the page is light after a reload.

## How the scripted agent works (`fake-agent.ts`)

`kitchen.yaml` says `agent: { tool: fake, script: spikes/w3a/fake-agent.ts }`. The ticket names a scenario (`scenario: honest | attacks | repro-retry | gap | bad-gap | inconclusive | backoff | replay`). Each role does what a real one would do on the planted bug, so what is under test is the engine: intake rates it a medium bug, spec writes three criteria (C1 the repro, mechanical; C2 mechanical; C3 judged, on a new drive), the repro writes a feature drive, the builder fixes the `WHERE`, the drives role writes the screenshot drive, the verifier cites the C3 evidence the engine lists. In `attacks` it also misbehaves:

| role | what it tries | what must happen |
|---|---|---|
| repro | fixes the bug while "reproducing" it | the fix is kept off the repro commit; the proof fails on the base as expected |
| builder (round 1) | edits `bin/dev`, adds `lib/extra.mjs`, edits the repro drive and `kitchen.yaml`; stamps a self-check for C3 through the bridge | every edit is kept off the branch and logged; the self-check is stamped `role: builder` |
| drives (attempt 1) | writes the drive with a ```js block and an `eval` step, and edits `server.js` | the file is refused before any commit; the attempt fails; attempt 2 writes a clean drive |
| verifier | cites a forged id (round 1), round 1's ids in round 2 (stale), the builder's self-check (round 3) | each is refused and the verdict is FAIL (a round each); round 4 cites right and passes |
| builder (after review) | a self-check through the bridge stamped for this very HEAD (clean), round and C3 | refused by the role rule alone |

`paths.ts` scenarios (each W1 `paths.ts` scenario that relied on W1 stubs, now on the real stages, up to review; ready and report are W3b/W4):

| scenario | what the scripted roles do | path |
|---|---|---|
| repro-retry | the first repro drive waits for a heading that never shows; the second is right | intake → spec → repro → repro → build → … → review |
| gap | spec names `hover`, drives names `drag`; the smith adds each to describe | spec → toolkit → spec …, drives → toolkit → drives → verify → review |
| bad-gap | drives writes free text in `GAP:` | drives → drives (a failed write, never toolkit) |
| inconclusive | the verifier says INCONCLUSIVE four times, then judges | verify → verify → paused(toolkit-ticket) → verify → verify → needs-human → feedback → verify → review |
| backoff | the builder is rate limited once | build → paused(backoff) → build → … → review |

## Files

- `lib.ts`: fixture repo builder (with the planted bug), CLI runner, ledger/manifest readers, PASS/FAIL tally.
- `fake-agent.ts`: the scripted roles (with a tiny MCP client for the builder's bridge self-check).
- `engine.ts`: `attacks` and `kill`.
- `paths.ts`: the ported W1 paths.
- `wrong.ts`: the admin spec against a leaking builder.
- `e2e.ts`: the real-agent runs; writes `<scratch>/e2e-<tool>-<kind>.json` (per-stage models, time, cost), `.log`, and copies of intake.md and spec.md.
