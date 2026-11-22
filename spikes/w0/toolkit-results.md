# W0 spike B: Toolkit contract, drive format, manifest, slots, engine git, untrusted env

Last run: 2026-11-22, after the second W0 review. macOS laptop, Docker 29.5 (colima), Node 26.9, git 2.39.

```sh
node spikes/w0/run-toolkit-spike.mjs <scratch dir> [--cold]
```

It copies `fixtures/a-web` to `<scratch>/src` as its own git repo (a stand-in job worktree), runs everything below through `src/proof/cli.ts`, asserts every outcome (negative ones included), tears everything down in `finally`, and exits 1 on any miss. At most two Postgres containers run at once. It writes `results.json` and `spike.log` into the scratch dir.

**Result: 52/52 expectations met, exit 0, no kitchen containers left.**

## What it exercises

| Path | What |
|---|---|
| `fixtures/a-web/` | Node `http` app + Postgres: sign-in (alice, bob-admin; fake passwords via pgcrypto), /settings with a persisted Dark mode switch, a two-step "New project" form with slug validation and a 1.5 s "Provisioning… → Ready", admin invites + public /join |
| `fixtures/a-web/.kitchen/toolkit/bin/dev` | The contract: `prepare`, `up`, `doctor`, `reset`, `down`, `describe`, and the primitives `login`, `press`, `type`, `read`, `screenshot`, `http`, `open`, `reload`. Every primitive takes `--id`, `--src`, `--out`; a flag given twice is refused |
| `fixtures/a-web/.kitchen/toolkit/lib/driver.mjs` | One headless Chromium daemon per id (Playwright 1.65.0) that keeps the session between primitive calls and refuses URLs that leave the app's origin |
| `fixtures/a-web/.kitchen/toolkit/features/*.md` | Three feature drives (`settings.toggle-dark`, `projects.create`, `invites.generate-and-join`) |
| `src/proof/drive-format.ts` | The fenced `drive` block: restricted YAML subset, zod-checked; reserved args (`id`, `src`, `out`, `ports`) refused at parse |
| `src/proof/drive.ts` | Engine-side interpreter: `describe` check → one primitive per step; `wait` polls `read`; `retry`; `save`/`$var`. One manifest entry per call, under the job's drive lock |
| `src/proof/manifest.ts` | `manifest.jsonl` hash chain (`prev`), per-file sha256, engine-signed head in `job.json`, rollback counter (`Seal.floor`) |
| `src/proof/job.ts` | `job.json` (gitDir, uid, manifestHead), `storeHead` (job.json, then `$KITCHEN_HOME/heads/<uid>`), the per-job drive lock |
| `src/proof/source-stamp.ts` + `src/engine/git.ts` | HEAD, dirty flag and tree hash of the worktree, through the engine git helper (explicit gitdir, neutral config, scrubbed env) |
| `src/toolkit/run.ts`, `src/toolkit/slots.ts` | `bin/dev` with `toolkitEnv`; 20-port blocks in 31000–32767, registry in `$KITCHEN_HOME/slots.json` with owner pid + start time |
| `src/proof/cli.ts` | Spike CLI: `job create`, `drive`, `verify`, `slot acquire/release/list`, `toolkit` |
| `spikes/w0/negative/*.md` | Drives that must fail: a missing primitive, unmeetable wait text, empty wait text, a missing attribute, a reserved flag, foreign origins |

Unit tests (pure code only, `npm test`, vitest): 7 files, 36 tests.

## Expectations and key output

| Area | Expectation (all PASS) | Key output |
|---|---|---|
| contract | `prepare` (snapshot image cached), `describe` lists feature files only, `ports.needs: 3`, has `open`/`reload` | `["features/invites.md","features/projects.md","features/settings.md"]` |
| slots | a slot records `toolkitBin`, `src`, `pidStart`; `up` ready; `doctor` 5/5 | `{"status":"ready","secs":1.2,"timings":{"postgres":0.366,"app":0.151,"browser":0.622}}` |
| drives | three feature drives green, `reset`, all three green again | `settings.toggle-dark:true projects.create:true invites.generate-and-join:true` |
| stamp | every entry stamps the tested worktree's HEAD (not the kitchen repo), `dirty:false`, a 40-hex tree | `srcHead b2521dee… ≠ kitchenHead 3df9e4c7…` |
| manifest | ids `e1…eN`, chained; each wait one entry with its poll count; screenshots in their own `e<N>/`, hashed | `37 entries`; `e6:2 e24:6`; `e11/call.json,e11/settings-dark.png` |
| gaps and waits | a missing primitive is a stamped TOOLKIT-GAP, nothing run; an unmeetable wait + retry fails; an empty wait fails; `read` of a missing attribute is `ok:false` | `gap: sql`; `why: "empty wait text"`; `body has no attribute data-nope` |
| engine flags | `id:` in a drive step or a primitive call refused, nothing stamped; `out:` refused, nothing written; `bin/dev … --id=s1 … --id=p2` refused | `login: "id" is set by the engine and can't be passed by a step`; `flag --id given twice` |
| origin | `http @evil.example/x` stays on the app; `http http://evil.example/x` and `open //evil.example/x` refused | `{"status":404}`; `leaves the app (http://evil.example): refused` |
| concurrency | three concurrent drives on one job get distinct contiguous ids and own folders; the manifest verifies | `e89 e90 e91`, `{"ok":true,"entries":91}` |
| stamp | a dirty worktree is stamped `dirty:true` with its own tree | `{"dirty":true,"tree":"2a9bb112…"}` |
| engine git | a folder without git can't become a job (so no proof, never sha "unknown"); a linked worktree without `--repo` is refused (its `.git` file is never read); with `--repo`/`--worktree-id` the gitdir is `<main>/.git/worktrees/<id>`; after the worktree's `.git` is redirected, the drive still stamps the real HEAD | `nogit is not a git checkout (no .git)`; `src-linked/.git is a file (a linked worktree): give its main repo and worktree id`; `{"sha":"b2521dee…","dirty":false}` |
| evidence | `down`, then the evidence still verifies | `92 entries, 8 PNGs` |
| tampering | edited line, deleted manifest, dropped last line, replaced PNG, edited head, removed head, and a rollback to round 1 (older `job.json` + its manifest, both validly signed) are all refused | `does not chain` / `missing or empty but the engine recorded 92` / `has 91 entries` / `content changed` / `signature does not match` / `no expected manifest head` / `head has 37 entries but the engine already recorded 92: rolled back, refused` |
| two slots | two slots up in parallel, one Postgres container each, drives on both at once | `[0.9, 0.9]` s, `[true, true]` |
| stale slots | a dead owner's slot is reclaimed through its own Toolkit's `down`; a reused pid (other start time) is stale | `reclaimed: ["orphan"]`, `orphanLeft: ""`; `["fresh"]` |
| untrusted env | control with the engine env: local push works and `gh` sees `GH_TOKEN`; through `up`: `ps eww <appPid>` shows no `GH_TOKEN`/fake token/agent keys/Docker/control vars; app startup `git push` fails with no branch; `gh auth status` not logged in | `push exit 0`; `hasKitchenUntrusted: true`; `exit 128 'remote-kitchen-push-blocked' is not a git command`; `exit 1, notLoggedIn: true` |
| cleanup | no kitchen containers left | `none` |

The planted-gitdir attack itself (fsmonitor, hooks, filter drivers, nested repos) is proven by `node spikes/w0/git-redirect.ts` (no Docker, no agent; ADR 0006 "Engine git").

## Design choices

- **Snapshot restore.** `prepare` bakes migrations + seed into a committed image (`PGDATA=/pgdata`, so not a volume) and an `app_seed` template DB. `up` = `docker run` that image (Postgres ready in ~0.35 s); `reset` = `DROP DATABASE app WITH (FORCE); CREATE DATABASE app TEMPLATE app_seed` + a fresh browser context.
- **Browser session per id.** A small daemon per id owns one Chromium context; primitives are thin HTTP clients to it. It runs on the slot's 3rd port and dies with `down` (process-group kill by recorded pid, never by name).
- **Waits live in the engine**, not the Toolkit: `wait: { until: { text, target?, attr? }, timeout }` polls `read` every 250 ms and is one manifest entry with its poll count; every poll is in its `call.json`.
- **Evidence per call.** Each primitive call gets `--out=evidence/e<N>/`; a file the Toolkit reports outside it fails the step and is never copied.
- **No YAML dependency.** The drive block is a restricted subset (one step per line as a flow mapping; only `save:` may follow a step), so drives can't grow structure.
- **`save` of an object** stores its JSON text (`http` returns `{status, body}`).

## Timings (this run; seconds, wall clock incl. Node start)

| Command | s |
|---|---|
| prepare, snapshot cached | 1.29–1.35 |
| describe | 0.16 |
| job create | 0.11–0.12 |
| slot acquire / release | 0.11–0.19 |
| up (single) | 1.24–1.36 |
| up (two in parallel) | 1.11 / 1.12 |
| doctor | 0.29 |
| reset | 0.90 |
| down | 0.55–0.61 |
| drive settings.toggle-dark | 1.74–1.83 |
| drive projects.create (includes the 1.5 s provisioning wait) | 3.32–3.38 |
| drive invites.generate-and-join | 1.29–1.30 |
| one primitive drive (source stamp + describe + call) | 0.30–0.34 |
| verify manifest | 0.11–0.13 |
| slot acquire that reclaims a stale slot (runs its `down`) | 0.57 |

Not measured: a truly cold machine (empty npm cache, no Chromium download). Playwright is pinned to 1.65.0 because its headless shell was already cached here.

## Caveats

- The slot owner pid in the spike is the runner script's pid (`--pid`); the real runner passes its own.
- The manifest's integrity against hostile *app* code (unsandboxed, running as the user, able to read `$KITCHEN_HOME`) is a residual risk; see ADR 0006, "Manifest integrity".
