# W0 spike B: Toolkit contract and drive format on fixture A

Date: 2026-11-22. Machine: macOS laptop, Docker Desktop 29.5 (4 CPU, 6 GB), Node 26.9.
Reproduce: `node spikes/w0/run-toolkit-spike.mjs <scratch dir> [--cold]` (copies
`fixtures/a-web` to `<scratch>/src` as a stand-in worktree, runs everything below,
always tears down in `finally`, writes `results.json` + `spike.log`).

## What was built

| Path | What |
|---|---|
| `fixtures/a-web/` | Node `http` app + Postgres: sign-in (alice, bob-admin; fake passwords via pgcrypto), /settings Appearance with a persisted Dark mode switch, two-step "New project" form with step-2 slug validation and a 1.5 s "Provisioning… → Ready", admin invites + public /join. `data-testid`/aria labels throughout |
| `fixtures/a-web/.kitchen/toolkit/bin/dev` | The contract: `prepare`, `up`, `doctor`, `reset`, `down`, `describe` + primitives `login`, `press`, `type`, `read`, `screenshot`, `http` |
| `fixtures/a-web/.kitchen/toolkit/lib/driver.mjs` | Per-id headless Chromium daemon (Playwright 1.65.0, headless shell only) that keeps the session between primitive calls |
| `fixtures/a-web/.kitchen/toolkit/SKILL.md`, `features/*.md` | pstack-shaped skill; three feature drives + index |
| `src/proof/drive-format.ts` | Parser for the fenced `drive` block (restricted YAML subset, zod-checked), `$var` lint + substitution |
| `src/proof/drive.ts` | Engine-side interpreter: describe check → one primitive per step, `wait` (polls `read`), `retry`, `save`/`$var`; evidence file + stamped manifest line per call |
| `src/proof/manifest.ts` | Append with sha256 of `manifest.jsonl` recorded after each write; `verifyManifest` refuses a mismatch (and `appendEntry` refuses to extend a tampered file) |
| `src/toolkit/slots.ts` | 20-port blocks in 31000–32767 by probing, registry in `$KITCHEN_HOME/slots.json` with owner pid, stale reclaim runs `down` first |
| `src/proof/cli.ts` | Spike CLI: `drive <feature.md> --id --src --evidence [--arg k=v]…`, `verify --evidence`, `slot acquire/release/list` |
| `*.test.ts` (3 files, 17 tests) | Pure code only: format parsing, manifest hash, slot picking. All pass (`node --test <file>`, one at a time) |

Design choices:
- **Snapshot restore.** `prepare` bakes migrations + seed into a committed image (`PGDATA=/pgdata` so it isn't a volume) and creates an `app_seed` template DB. `up` = `docker run` that image (Postgres ready in ~0.4 s); `reset` = `DROP DATABASE app WITH (FORCE); CREATE DATABASE app TEMPLATE app_seed` + fresh browser context.
- **Browser session per id.** A small daemon per id owns one Chromium context; primitives are thin HTTP clients to it. It runs on the slot's 3rd port and dies with `down` (process group kill by recorded pid, never by name).
- **Waits live in the engine**, not the Toolkit: `wait: { until: { text, target?, attr? }, timeout }` polls the generic `read` primitive every 250 ms. So `wait-text` is not a primitive.
- **No YAML dependency.** Kitchen deps stay zod + execa; the drive block is parsed by a ~200-line restricted parser (one step per line as a flow mapping; only `save:` may follow a step). Anchors, multi-line values, extra keys are refused.

## Exits (this half of W0)

| Exit | Result | Key evidence line |
|---|---|---|
| `prepare` works | PASS | `{"status":"ok","secs":4.3,"snapshot":"kitchen-a-web-seed:3c167981add8","snapshotCached":false}` (cold snapshot); warm `secs":0.9` |
| `up` from empty to usable, seconds | PASS | `{"status":"ready","url":"http://127.0.0.1:31000","secs":1.2,"timings":{"postgres":0.363,"app":0.146,"browser":0.622}}` |
| `doctor` | PASS | 5/5 checks ok: container running, seed users present, app pid alive, healthz on our port, browser driver alive |
| a drive, `reset`, the drive again | PASS | all 3 drives green in round 1, `reset` `{"status":"ok","secs":0.5}`, all 3 green again in round 2 (same slug `launch-plan` reusable, dark mode starts `before:"false"` again) |
| `down`; evidence survives | PASS | `{"status":"ok","stopped":["browser","app","postgres"]}` then `verify` `{"ok":true,"entries":86}` and 6 PNGs (`e12/settings-dark.png` … `e86/invite-accepted.png`) still present |
| two slots at once | PASS | `kitchen-a-web-p1 127.0.0.1:31001->5432`, `kitchen-a-web-p2 127.0.0.1:31021->5432`; both `up` in parallel (1.06 s each), both doctors ok, drives run concurrently on both, both `down` |
| three flows green through `src/proof/drive.ts`, stamped | PASS | e.g. `{"ok":true,"drive":"invites.generate-and-join","vars":{"admin":"bob-admin","invite":"INV-90CA7A13"}…}`; every line has `{id, sha, round, criterion, cmd, exit, at}` |
| flows need no new primitive | PASS | only `login press type read screenshot http` + built-in `wait retry save $var` |
| hand-edited manifest refused | PASS | edited line 6 `ok:false → ok:true`: `{"ok":false,"refused":"manifest.jsonl hash 6696c9b24262 ≠ recorded 146ca8af1805: refused"}` (unedited copy verified ok first) |
| clean up everything | PASS | `containers left: none`; no `server.js`/`driver.mjs`/headless-shell processes; nothing listening on 31000–31100 |

Extra checks run in the same script:

| Check | Result | Evidence |
|---|---|---|
| Missing primitive → TOOLKIT-GAP before any step runs | PASS | `negative.needs-sql`: `{"ok":false,"gap":"sql","steps":0}` |
| Unmeetable wait + retry fails, doesn't hang or pass | PASS | `negative.wrong-text`: fails at line 10 after 4 polls + 4 polls on retry 1, each stamped |
| Stale slot reclaimed after `down` | PASS | slot `orphan` owned by a dead pid with its app up → next `acquire` logs `reclaiming stale slot 0 (orphan, pid 14744 gone): down first`, `"reclaimed":["orphan"]`, orphan container gone, block 0 reused |
| Typecheck of `src/proof`, `src/toolkit` | PASS | `tsc --strict --erasableSyntaxOnly --noEmit` clean (typescript run from a scratch dir, not a repo dep) |

## The three flows

| Drive | Exercises | Steps | Key values |
|---|---|---|---|
| `settings.toggle-dark` (`features/settings.md`) | sign in, change a setting, full reload, read back + `http GET /api/me` | 11 calls | `before:"false"`, `theme:"Dark"`, `me:{…"theme":"dark"}` |
| `projects.create` (`features/projects.md`) | 2-step form, invalid slug → error, fix, `wait` ~1.5 s for "Ready" | 15 calls | `created:"launch-plan"` |
| `invites.generate-and-join` (`features/invites.md`) | read a random value, `save`, reuse as `$invite` after signing out | 11 calls | `invite:"INV-…"` re-used in `type` and in the final `wait` text |

## Timings (warm run; seconds, wall clock incl. Node start)

| Command | s |
|---|---|
| prepare, cold snapshot build (npm + Chromium caches warm) | 4.34 |
| prepare, warm | 0.89–1.11 |
| describe | 0.05 |
| slot acquire / release | 0.12–0.16 |
| up (single) | 1.24 |
| up (two in parallel) | 1.06 / 1.07 |
| doctor | 0.14–0.18 |
| reset | 0.59 |
| down | 0.42–0.50 |
| drive settings.toggle-dark | 1.50–1.71 |
| drive projects.create (includes the 1.5 s provisioning wait) | 3.22–3.36 |
| drive invites.generate-and-join | 1.23–1.65 |
| one primitive call (bin/dev → driver) | ~0.1 |
| verify manifest | 0.12 |
| slot acquire that reclaims a stale slot (runs its `down`) | 0.58 |

Not measured: a truly cold machine (empty npm cache, no Chromium download). Playwright
is pinned to 1.65.0 because its headless shell (revision 1254) was already cached here.

## Proposed contract / format changes (not applied to PLAN.md)

1. **`--out <dir>` on every primitive call.** The contract says a drive returns `files`, but not where they go. The engine now passes a per-call folder `evidence/files/e<N>/`; without it, a second `screenshot` of the same name overwrote round 1's file (found and fixed in this spike).
2. **`read` (with `target` and optional `attr`) is a required primitive**, because the engine builds `wait` on it. Document `wait: { until: { text, target?, attr? }, timeout }`; the PLAN example only shows `text`.
3. **`describe [--src <worktree>]`** so the feature list comes from the job worktree (features resolve from `--src`), and **`describe` declares `ports.needs`** (here 3: app, postgres, driver) so `up` can refuse too few ports up front.
4. **`wait` is the in-drive assertion; mechanical `expect` stays in the spec.** `kitchen drive` returns the drive's saved `vars`, so a spec `expect:` can test `$theme`. Suggest `assert.ts` accepts `$var` references.
5. **`open {path}` / `reload` as generic primitives.** The flows didn't need them (fixture A is server-rendered, so pressing a nav link is a real reload), but the PLAN spec example already uses `toolkit reload`, and an SPA would need one. Name them in the generic list now so they aren't per-project.
6. **Stamp a TOOLKIT-GAP too.** Today a gap is decided before any step runs and writes no manifest line; a Verdict citing it has nothing to cite.
7. **Restricted YAML subset as the official format** (one step per line, flow mappings, `save:` as the only continuation), so Kitchen needs no YAML dependency and drives can't grow structure.
8. **Every wait poll and retry attempt is stamped.** Honest, but long (86 entries for 6 drives). If Reports get noisy, collapse polls into one entry with a poll count; don't drop them.
9. **`save` of an object** stores its JSON text (`http` returns `{status, body}`). If drives need a field, add a path form (`save: { theme: body.theme }`) rather than a primitive. Not needed by these flows.

## What I could not do / caveats

- The manifest hash lives in `manifest.sha256` beside the manifest (stand-in for `job.json` `manifestHash`). It only protects against an agent if that file sits outside the agent's writable root, which is the other half of W0's integrity tests.
- The slot owner pid in the spike is the runner script's pid (`--pid`); the real runner passes its own.
- Codex smoke for these parts belongs to the other spike half / wave end; not run here.
