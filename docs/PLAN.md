# Kitchen build plan (v4)

Kitchen is an open-source software factory: it takes a ticket and hands back a pull request proven by driving the real app. This plan says what gets built, in which order, with which interfaces, and how each step is proven. Design decisions live in `GLOSSARY.md`, `docs/adr/` and `docs/architecture.html`. The **Changes from v1** section at the end lists what review round 1 changed.

## 0. Goal and success measures

**Goal.** A developer runs `npx devkitchen init` in their repo from Claude Code or Codex and gets a proven Toolkit for their app. From then on, `kitchen run` turns tickets into ready pull requests. Each one carries a Report and evidence that the person who merges can see on GitHub.

**v0.1 is done when:**

1. **Setup.** `init` reaches a passing `toolkit check` on fixtures A–D (§8) in under 20 minutes of agent time each. This covers both the adopt path and the build path, on **both Claude Code and Codex**.
2. **Benchmark** (§8): 14 tickets, 3 runs each, on Claude Code.
   - At least 85% of runs end in the correct outcome.
   - Every planted trap is caught in all 3 runs.
   - At most 1 false FAIL across the 2 planted-correct controls × 3 runs.
   - On the held-out set, results don't drop more than 15 points below the tuned set.
3. **Codex.** A 6-ticket subset passes on Codex at the same threshold.
4. **Kill and resume.** A run killed with `kill -9` mid-Build and mid-Verify resumes with `kitchen run`. No job is lost, and no wrong outcome comes from a step running twice.
5. **Dogfooding.** Kitchen has taken at least 5 of its own tickets to ready PRs, and one superchat-lite ticket end to end.

**What the ledger tracks from the first run:**
- merge-ready rate over tickets taken in
- first-pass Verdict rate
- rounds per Job
- escalation reasons
- Toolkit gaps per Job
- INCONCLUSIVE and flake rate per drive
- time and cost per Job and per risk path
- findings dismissed per review lens
- primitive PRs per Job. A rising number means the drive format is too thin

## 1. Shape of the code

```
kitchen/                       npm: devkitchen, bin: kitchen
├── src/
│   ├── cli/                   argv → commands; one-line output per action
│   ├── engine/
│   │   ├── machine.ts         stage table, transition guards (pure)
│   │   ├── store.ts           job files, atomic writes, per-job lock
│   │   ├── runner.ts          run loop, slots, dispatch, --detach
│   │   ├── lock.ts            run lock + heartbeat
│   │   ├── git.ts             the one way the engine runs git: explicit gitdir, neutral config; worktrees, commits, push
│   │   └── stages/            one handler per stage
│   ├── agents/                adapter.ts, claude.ts, codex.ts, fake.ts, env.ts (agentEnv, untrustedEnv)
│   ├── bridge/                mcp.ts: `kitchen mcp`, the job-scoped MCP server agents drive the app through
│   ├── proof/
│   │   ├── drive.ts           `kitchen drive`: the only path that runs a proof and writes evidence
│   │   ├── drive-format.ts    the restricted YAML drive format, reserved args, $var
│   │   ├── manifest.ts        stamped evidence entries: hash chain, file hashes, engine-signed head
│   │   ├── source-stamp.ts    HEAD, dirty flag and tree hash of the tested worktree
│   │   └── assert.ts          expect: matchers (text, json path, exit code, row count)
│   ├── checks/                gate.ts, spec-lint.ts, risk-floor.ts, verdict.ts, report-render.ts, redact.ts
│   ├── toolkit/               run.ts (bin/dev with the untrusted env), contract.ts, check.ts, slots.ts (ports + ids), describe.ts
│   ├── home.ts                $KITCHEN_HOME and the engine key
│   ├── lock.ts                owner-checked lock files (pid + start time)
│   ├── sources/               prompt.ts, github.ts   (TicketSource)
│   ├── forge/                 github.ts (draft PR, comment, checks status, evidence branch)
│   ├── ledger/                append.ts, report.ts
│   └── config.ts              kitchen.yaml schema (zod), defaults
├── roles/                     setup intake spec builder verifier reviewer-* smith report retro
├── toolkit-template/          SKILL.md, bin/dev skeleton (prepare/up/doctor/down/reset/describe), features/
├── skills/kitchen/            Claude Code + Codex skill
├── dashboard/                 dashboard.html
├── fixtures/                  apps A–D + benchmark tickets + held-out set
└── docs/
```

**Rules:**
- **Every pass/fail decision lives in `engine/`, `proof/` or `checks/`.** Agents write one file and return one line. They never write `job.json`, never write evidence directly, and never push.
- **Stage handlers are idempotent.** Every side effect carries a key and is checked before it runs again: PR lookup, ticket filing, comments.
- **Runtime:** Node 20+, TypeScript, zod and execa. There is no server. Playwright belongs to the Toolkits, never to Kitchen itself.

## 2. Contracts between parts

### Files in the user's repo

```
kitchen.yaml                              committed
.kitchen/toolkit/                         committed
  SKILL.md                                how agents use it (pstack shape)
  bin/dev                                 any language
  features/<feature>.md                   per-feature drives + how to reach it
.kitchen/roles/<role>.md                  optional per-project overrides of shipped roles
.kitchen/jobs/<NNN-slug>/                 ignored
  job.json  ticket.md  intake.md  spec.md
  rounds/<N>/build.md gate.md verify.md review-<lens>.md
  evidence/manifest.jsonl + e<N>/         written only by `kitchen drive`; one folder per entry
  report.src.html  report.html
.kitchen/ledger.jsonl  .kitchen/run.lock  .kitchen/toolkit.proven   ignored
.worktrees/<NNN-slug>/                    ignored
```

### job.json

```ts
type Job = {
  id: string; title: string; ticket: TicketRef;
  stage: Stage; pausedReason?: string; round: number; roundLimit: number;
  risk: Risk | null; riskFloor: Risk | null;       // ticket rating, diff floor (only raises)
  surfaces: ('ui'|'security')[]; kind: 'feature'|'bug'|'chore' | null;
  branch: string; worktree: string; pr: number | null;
  slot: { n: number; ports: number[] } | null;      // from the slot pool
  toolkitRef: string;                               // sha of the Toolkit the job's proofs run with
  returnTo: Stage | null;                           // where the toolkit stage hands back (drives or spec)
  attempts: { drives: number; render: number; toolkitTicket: number };
  smith: { attempts: number; toolkitPr: number | null };
  filed: string[];                                  // idempotency keys of side effects done
  agentRuns: AgentRunRef[]; startedAt: string; updatedAt: string;
}
type Stage = 'intake'|'needs-info'|'spec'|'repro'|'build'|'gate'|'drives'|'verify'|'toolkit'
           |'review'|'ready'|'report'|'done'|'needs-human'|'paused'|'rejected';
// paused carries: pausedFrom: Stage; waitFor: 'backoff'|'toolkit-pr'|'ci'|'toolkit-ticket'; until?: string
// uid: string            // random per job; scopes the manifest head's HMAC
// gitDir: string         // the worktree's gitdir, resolved by the engine at job creation (<main>/.git/worktrees/<id>);
//                        // every engine git call passes it explicitly and never reads the worktree's .git
// manifestHead: { n: number; hash: string; mac: string }
//                        // entry count, sha256 of the last entry line, HMAC(engine key) over both.
//                        // Written after every engine append; required by every verify (see Proofs).
//                        // $KITCHEN_HOME/heads/<uid> keeps the highest n ever written: a lower head is a rollback
```

A paused job **releases its slot**. The runner checks `waitFor` on every tick and moves the job back to `pausedFrom` when the condition clears:

| waitFor | clears when |
|---|---|
| `backoff` | the backoff time has passed |
| `toolkit-pr` | the forge shows the Toolkit PR merged, or closed without merging (Ready then sends the job to needs-human) |
| `ci` | `gh pr checks` has finished; inside Ready's window (`until`: no checks yet after a push, or a cancelled run) only a pass or fail ends it early |
| `toolkit-ticket` | that ticket is closed |

### Transition table (machine.ts)

| from | to | guard (read from files and git, never from what an agent says) |
|---|---|---|
| intake | spec | `ACCEPT`, kind≠bug, risk medium or high |
| intake | build | `ACCEPT`, kind≠bug, risk low, and the inline criteria pass spec-lint |
| intake | repro | `ACCEPT`, kind=bug, risk low, and the inline criteria pass spec-lint (bugs at medium or high risk go through spec, then repro) |
| intake | needs-info / rejected | matching DECISION |
| needs-info | intake | author or operator replied (source says so) |
| needs-info | rejected | `kitchen reject` |
| spec | repro | kind=bug and spec-lint passes |
| spec | build | kind≠bug and spec-lint passes |
| spec | toolkit | spec-lint finds a missing **primitive** drive, smith.attempts < 2 |
| repro | build | the repro proof ran through `kitchen drive` on the base sha and **failed as expected**. The repro is committed as a regression test, or as a feature drive the builder may not edit |
| repro | toolkit | the reproduction needs a primitive that doesn't exist (`returnTo = repro`). `repro` writes its own feature drive if it needs one |
| repro | needs-info | no reproduction after 2 tries. The ticket gets an author question with the evidence |
| build | gate | build.md `STATUS: READY`, the engine committed and pushed, and the draft PR exists (the engine opens it) |
| build | needs-human | `STATUS: BLOCKED` |
| gate | drives / build | gate.md for this HEAD: PASS / FAIL. Then risk-floor recomputes from the diff (raise only) |
| drives | verify | Gate stays valid only if the commits since `gate.md` touch nothing but `features/*.md`, which the engine checks; otherwise Gate runs again. Then: every drive named in the spec resolves on HEAD, and `toolkit check --feature <x>` passes for each new or changed feature drive. The verifier role writes missing feature drives here, as declarative sequences of primitives, committed by the engine **before** any proof runs, so no evidence goes stale |
| drives | toolkit | a feature drive needs a primitive that doesn't exist (`returnTo = drives`) |
| drives | build | the verifier reports the feature **unreachable** (for example the button isn't there), with the failed drive's stamped output as evidence. This costs a round, like a Verify FAIL |
| drives | needs-human | two attempts at writing a drive fail on a feature that is reachable |
| verify | review | **Step 1:** the engine runs every mechanical proof alone. **Step 2:** the verifier agent judges only the `judged` criteria. Everything passes, and every cited id is stamped with this HEAD, this round and that criterion, and the manifest hash matches `job.json` |
| verify | build | any FAIL |
| verify | verify | INCONCLUSIVE: one free retry on a fresh instance (`down`, `reset`, `up`). Does not cost a round |
| verify | paused (toolkit-ticket) | INCONCLUSIVE twice. A Toolkit ticket is filed and the job waits (doesn't cost a round). If the ticket is closed and the job still comes back INCONCLUSIVE twice more, it goes to needs-human |
| verify | toolkit | TOOLKIT-GAP with `doctor=ok` and the missing primitive named, smith.attempts < 2 |
| toolkit | drives / spec | the smith's Toolkit PR passes `toolkit check` on main plus that PR (the contract probe, every drive using the new primitive, and every drive that passes on the base; a drive that already fails on the base, from the base's own check cached per base sha, is tolerated as known). `toolkitRef` is set to that sha, and the job goes back to `returnTo`: a job that came from `spec` returns to `spec`, one from `repro` returns to `repro`, and one from `drives` or `verify` returns to `drives`, because the drive may need rewriting |
| toolkit | toolkit | the engine's check of the smith's commit fails (or the smith gives up), smith.attempts < 2: the second try starts from the first try's commit and reads `toolkit-check-<n>.json`. After that, needs-human (smith limit) |
| review | ready / build | all lenses PASS / a blocking finding the reviewer can show |
| ready | report | synced with base, HEAD pushed (Ready publishes it: the drives stage commits after build's push), CI green on it (`gh pr checks`; no checks is green only when the repo has no workflow files or `ci_grace_sec` passed since the push; a cancelled run is read once more), Toolkit PR (if any) merged, gate PASS. Re-verify on the synced HEAD only if base moved since verify |
| ready | needs-human | the Toolkit PR was closed without merging (the reason names it) |
| ready | paused (ci / toolkit-pr) | CI still running, or the Toolkit PR not merged yet |
| ready | build | sync conflict, red CI, or a re-check that fails. In build, a resolution the layer rules would cut a base change from aborts the merge → needs-human |
| ready | gate | gate is no longer PASS on this HEAD (commits since it touch more than `features/*.md`): Gate runs again |
| paused | `pausedFrom` | the `waitFor` condition clears |
| report | done | report.html rendered with every id resolved. Evidence branch pushed, PR comment posted |
| report | needs-human | rendering refused twice |
| done | build | `kitchen feedback <id>` or a review comment on the PR from a trusted person. Round count resets as for needs-human |
| * | paused (backoff) | adapter rate limit or auth failure. Retried with backoff, never → needs-human |
| * | needs-human | round limit, smith limit, an adapter or engine error that repeats and isn't a rate limit, or a stage result refused twice. The stage it left is kept as `escalatedFrom` |
| needs-human | `escalatedFrom` (or `--to <stage>`) / rejected | `kitchen feedback [--to <stage>]` / `kitchen reject` (ADR 0007). A human command the table refuses changes nothing |

"Merged" is read from the forge; Kitchen never drives it.

### Toolkit: two layers

The Toolkit grows with the app in two different ways, because the app has two kinds of change:

| Layer | What | Who changes it | Where it lands |
|---|---|---|---|
| **Primitives** | `bin/dev` commands: prepare, up, down, reset, doctor, describe, login, open, reload, press, type, read, screenshot, http, sql… | **Toolkit smith** only | Its own Toolkit PR, proven on main. Human-merged. The job uses that sha until it's merged |
| **Feature drives** | `features/<x>.md`: how to reach and exercise one feature, written as a **declarative list of primitive calls**, which the engine interprets (`proof/drive.ts`). Feature drives can't contain code, so a drive can't simply print its own expected answer | The **verifier role**, in the `drives` stage. It's the independent party, and this saves a strong-model run. The engine rejects any Toolkit edit in a builder commit. The code lens always reviews drive diffs | Job PR. `toolkit check --feature` runs on the job HEAD |

A new feature's drive can only run against the job branch, since the feature only exists there. Primitives are what every job depends on, so they must be proven on main. Any drive that needs real code is a primitive, and goes through the smith.

**Which `bin/dev` runs.** The engine keeps its own clean checkout of the base at `toolkitRef`: `.worktrees/_toolkit@<sha>`. It never uses the user's main checkout, which may be dirty or on another branch.
- **Primitives** resolve from that checkout.
- **Feature drives** resolve from `--src <worktree>`.
- A job pinned to an unmerged Toolkit PR gets a checkout of that PR's sha.

**Lifecycle of `toolkitRef`:**
- **When it moves.** On every sync with the base at Ready, and when a pinned Toolkit PR is merged (possibly squashed or changed in review), `toolkitRef` is set to the new base sha, and the job re-runs `drives` (a check only) and Verify on the synced HEAD.
- **Preparing it.** `prepare` prepares the Toolkit checkout too (Playwright, browser binaries and so on), cached per sha.
- **Cleaning up.** A `_toolkit@<sha>` checkout that no live job and no `toolkit.proven` points at is removed when `kitchen run` starts.

**Who interprets feature drives: the engine, not the Toolkit.** `proof/drive.ts` reads a feature drive and calls primitives one at a time. Each step is stamped as evidence. So every Toolkit stays a set of plain commands, and the drive format is the same for every project. Format, in `features/<x>.md`, inside a fenced `drive` block:

```yaml
drive: settings.toggle-dark
args: [user]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=settings]" }
  - wait:  { until: { text: "Appearance" }, timeout: 10s }
  - press: { target: "[aria-label='Dark mode']" }
  - wait:  { until: { text: "theme-dark", target: body, attr: class }, timeout: 5s }
  - read:  { target: "[data-testid=theme-state]" }
    save: theme                     # capture a value for later steps or for expect
  - retry: { times: 2, on: fail }   # applies to the step before
```

The format is an official **restricted YAML subset**, parsed by Kitchen itself (`proof/drive-format.ts`, no YAML dependency): top-level `drive`, `args`, `steps`; one step per line as a flow mapping; `save:` is the only line that may follow a step. Anchors, multi-line values and unknown keys are refused, so drives can't grow structure.
- The step names are primitive names from `describe`. The only built-in control is `wait`, `retry`, `save` and `$var`. There are no loops, branches or code. Anything that needs more is a primitive.
- `wait: { until: { text, target?, attr? }, timeout }` polls the `read` primitive (target default `body`) until its output contains `text`. A wait whose text is empty, literally or after `$var` substitution, fails.
- **Reserved args.** `id`, `src`, `out` and `ports` are set by the engine on every call; a step may not pass them, nor any arg whose name isn't `[a-z][a-z0-9_]*`. The engine calls `bin/dev <primitive> --id=<slot id> --src=<worktree> --out=<entry folder> --<arg>=<value>…` (one `--k=v` argv item per arg), and `bin/dev` refuses a flag given twice, so nothing appended can override an engine flag.
- `save` of an object (e.g. `http`'s `{status, body}`) stores its JSON text. A drive returns its saved `vars`, so a spec `expect:` may refer to them as `$name`.
- **One drive at a time per job.** `kitchen drive` holds a per-job lock (in-process queue plus a lock file naming its owner pid and start time) around the whole drive, so the next evidence id is read from the head under the lock.

### Toolkit contract

Every command prints exactly one JSON line on stdout and logs to stderr. Kitchen runs the `bin/dev` of the **engine-owned Toolkit checkout at `toolkitRef`** (see below), always with `--src <worktree>`, so it is always clear which Toolkit code runs and which app code it starts. Flags are accepted as `--k=v` or `--k v`; a flag given twice is refused.

**Environment.** The engine runs `bin/dev` with the **untrusted env** (§3: the allowlist and git/gh scrub, no agent auth, plus the worktree's `.env.kitchen`), and adds only what the control plane needs (`DOCKER_HOST`, `DOCKER_CONTEXT`), named in `KITCHEN_CONTROL_ENV`. `bin/dev` must strip those names before it starts app processes or anything else that runs worktree code.

| command | must |
|---|---|
| `prepare --src <dir>` | Make a fresh worktree runnable: install dependencies with a shared cache, copy `.env.kitchen` (fake or sandbox values only, made at setup, **never the developer's real `.env`**), build. Prints `{"status":"ok","secs":n}` |
| `up --id <id> --src <dir> --ports <p1,p2,…>` | Start from an empty data folder through migrations and seed data to a usable app on the given ports. Prints `{"status":"ready","url":…}` or `{"status":"fail","why":…}`. It must fit in the ports it's given (`describe`'s `ports.needs`; `up` refuses fewer). Snapshot-restored seed data is encouraged, so `up` takes seconds |
| `doctor --id <id>` | Read-only. Prints `{"status":"ok"\|"fail","checks":[…]}` |
| `reset --id <id>` | Put the data and drive sessions back to seed state without a full restart |
| `down --id <id>` | Stop only what that id started. Keeps the evidence |
| `describe [--src <worktree>]` | Prints the capability list: primitives, feature **files** (from `--src`, so a job branch's new drives show; the engine parses the drives in them), seed users, externals, `ports: {needs, order}`, whether jobs can run in parallel. **Generated, never hand-kept** |
| primitives | `<primitive> --id <id> --src <dir> --out <dir> [--arg=value…]`. Session state (browser, terminal, cookies) lasts until `reset` or `down`. Prints one JSON line `{"ok":bool,"out":…,"files":[…]}`. Every file goes into `--out` (the engine's entry folder `evidence/e<N>/`); a file reported anywhere else fails the step and is never copied |

**Required generic primitives** (every Toolkit with a UI has them, so drives stay portable): `read {target, attr?}` (inner text or attribute; a missing element or attribute is `ok:false`, never an empty string), `open {path}`, `reload`, `press`, `type`, `screenshot`, `login {as}`, `http {method, path, body?}`. `open` and `http` resolve `path` against the app's URL and refuse any other origin (`//host`, `http://other`, userinfo tricks).

**Externals.** `describe` lists `externals: [{name, mode: "mock"|"sandbox"}]`, for example Stripe sandbox, mail catcher or OAuth mock. Seed users are local fake credentials, never real ones. Mobile is out of scope for v0.1.

**Slots and ports.** The engine keeps a pool of `concurrency` slots for each machine, in `~/.kitchen-slots/slots.json`, shared across repos and across `KITCHEN_HOME`s (ports are machine-wide; only `KITCHEN_SLOTS` moves it, for tests). A block is handed out only when no container publishes any of its ports and each binds on 127.0.0.1 and 0.0.0.0.
- **Ports:** each slot reserves a block of 20 free ports, checked with a probe in the range 31000–32767 (below the Linux ephemeral range).
- **What a slot records:** its id, ports, owner pid **and that process's start time**, and the `bin/dev` and `--src` it was started with (the registry is shared across repos, so reclaiming must run the right Toolkit).
- **Stale slots:** a slot whose owner process is gone (dead pid, or a live pid with another start time: the pid was reused) is reclaimed. Its own Toolkit's `down` runs first, with the untrusted env.
- **Locking:** `slots.json` is changed under a lock file that names its owner (pid + start time). It is taken over only when that owner is gone, never by age, so a long `down` during reclaim keeps it.
- **Recording:** the slot is recorded in `job.json` and given to `up`.

**`kitchen toolkit check [--feature x] [--src dir]`** runs:
1. `prepare` (timed)
2. `up`, then `doctor`
3. one drive per feature
4. `reset`, then the drive again
5. the **contract probe**: every primitive in `describe` once, then the refusals the contract requires (`read` of a missing target is `ok:false`, `open`/`http` of another origin refused, a flag given twice refused)
6. `down`
7. it confirms the evidence survived, and that 2 slots can be up at once, unless `describe` says `parallel:false`, in which case the runner takes one job at a time for that project (whatever `kitchen.yaml` says)

Every call is held to exactly one JSON line on stdout; `up` gives an http(s) url (a CLI: any absolute URL); `doctor` runs at least one check; every feature maps to `paths` that match tracked files.

On a pass it writes `.kitchen/toolkit.proven` with the base sha. **When the base changes,** `kitchen run` checks the Toolkit again before taking new work:
- If the Toolkit or feature-mapped paths changed, it runs the full check.
- Otherwise it runs `doctor` plus one smoke drive.
- If either fails, the queue pauses and a Toolkit ticket is filed.

### Spec format (the verification contract)

```markdown
## Criteria
- [C1] Signed-in user sees a "Dark mode" toggle on /settings
  proof: toolkit settings.open --as alice
  expect: text "Dark mode" visible
  covers: R1              # the requirements of intake.md's `## Requirements` this criterion proves
- [C2] Toggle persists across reload
  proof: toolkit settings.toggle-dark --as alice ; toolkit reload ; toolkit read body.class
  expect: contains "dark"
- [C3] Theme reducer unit-tested
  proof: test src/theme.test.ts
- [C5] The saved theme is "Dark"
  proof: toolkit settings.toggle-dark --as alice
  expect: $theme == "Dark"   # a drive's saved vars may be used in a mechanical expect
- [C4] Header looks right in dark mode at phone width
  proof: toolkit settings.open --as alice --width 390 ; toolkit screenshot header
  expect: judged          # only an agent can decide; must cite the screenshot
## Out of scope
## Assumptions
```

**spec-lint checks:**
1. Every criterion has a `proof:` whose kind is `toolkit`, `cmd` or `test`.
2. Every primitive and feature drive it names is in `describe`, or is a **new feature drive** for this job's feature, which is allowed: the verifier writes it in the `drives` stage. A missing *primitive* sends the job to `toolkit`.
3. No `expect: judged` unless the criterion is visual or about wording.
4. Nothing touches a protected path.
5. A bug has a criterion marked `repro: true` with a mechanical `expect`.
6. IDs are unique.
7. The criteria cover the ticket (W3a review round 2, ADR 0003): intake.md lists the ticket's requirements (`## Requirements`, `- R1: …`, `- R3 (negative): …`, `- R5 (out of scope): … — why`); every criterion has a `covers:` line naming the Rs it proves, every R in scope is covered, and a negative R is covered by at least one criterion whose mechanical expect asserts an absence (`not visible`, `not contains`, `!=`, `== ""`). An `ACCEPT` without requirements is refused at intake.

### Proofs: `kitchen drive` and Verdicts

`kitchen drive <job> <criterion> [--repro]` is the **only** way a proof runs:
1. Reads the proof lines.
2. Runs them through the Toolkit, or as a command or test, in the job's slot. Every process that runs worktree code (Toolkit primitives, the app, tests, cmd proofs) gets the untrusted env (§3). `cmd` and `test` proofs also run under the proof sandbox (macOS `sandbox-exec`: no network but loopback, `$HOME` unreadable but the worktree and toolchains, writes only in the worktree and temp; ADR 0006); spec-lint's cmd denylist is only a first line. Text evidence is redacted before it is written.
3. Writes each call's files into its own entry folder `evidence/e<N>/`, plus `e<N>/call.json` (argv, exit, result, stdout/stderr tails).
4. Adds one manifest entry per call, stamped `{id, prev, sha, dirty, tree, round, criterion, role, cmd, exit, files: [{path, sha256}], at}`:
   - `sha` is HEAD of the **tested worktree** (never "unknown": no git, no proof), `dirty` whether the working tree differs from it, `tree` the git tree hash of what was on disk.
   - The stamp records the worktree's tree **at drive time**, not what the running app was started from. The app in the slot may have been started from an earlier tree (the builder keeps editing while its app runs). For Verify that gap is closed by the engine's fresh `up` right before Verify (see "Isolation" below): the app is started from the worktree as it is then, so the stamps of the Verify drives record the tree the running app was started from. If anything changed the worktree after that `up`, the Verify entries carry a different `tree`, which the engine can see.
   - The stamp's git calls go through `engine/git.ts` (explicit gitdir from `job.json`, nothing in the worktree runs; ADR 0006 "Engine git").
   - `role` says who asked (engine, builder, verifier…), so a builder's self-check is never taken for Verify evidence.
   - A `wait` is one entry with its poll count (`wait: {text, polls, hit}`); every poll is in its `call.json`.
   - A TOOLKIT-GAP is an entry too (`gap: <primitive>`), so a Verdict citing it has something to cite.
5. Applies `expect:` (which may use the drive's saved `$vars`).

**Verdicts by expect type:**

| `expect:` | Decided by | Verdict |
|---|---|---|
| mechanical (text, json path, exit code, row count) | the engine | PASS or FAIL, no agent involved |
| `judged` | the verifier agent | must cite evidence stamped for this sha, round and criterion |
| cmd or test proof | exit code | PASS or FAIL, no agent involved |

**What the verifier agent does:**
- writes concrete drive arguments when the spec only gives intent, through `kitchen drive --args`
- judges the `judged` criteria
- writes up a TOOLKIT-GAP, naming the primitive that's missing

The verifier has a shell, so the manifest's integrity is enforced by mechanism, not by rule:
- The manifest is a hash chain: each entry carries `prev` (sha256 of the line before) and the sha256 of every file it cites.
- After each append the engine writes `manifestHead {n, hash, mac}` to `job.json`; `mac` is an HMAC over the head with the engine key in `$KITCHEN_HOME/engine.key` (mode 600), scoped by the job's `uid`.
- `verifyManifest` **requires** that head (there is no default): an edited, dropped, reordered or appended line, a changed evidence file, a deleted manifest while the head says `n > 0`, or a head not signed by the engine key is refused. Ids come from the head, so they never restart.
- The engine also keeps a per-job counter, `$KITCHEN_HOME/heads/<uid>`, written with every head. A head older than it (an earlier `job.json` and manifest put back together, both validly signed) is refused as a rollback.
- What this protects and what it doesn't is in ADR 0006 ("Manifest integrity"): agents can't write job state or read the key; unsandboxed app code still could.
- Every mechanical proof runs before any verifier agent starts.
- Changes made through `--args` are logged against the spec and listed in the Report.

**Isolation.** The builder self-checks in its slot. Before Verify, the engine runs `down` and then a fresh `up` (snapshot restore) from the worktree as it is then, so the builder's leftover state never reaches the proof and the running app matches the tree the Verify stamps record.

`verdict.ts` accepts a judged PASS only when every cited id has matching sha, round and criterion. A stale or wrong-criterion citation counts as FAIL.

### Report (role, as decided in Q16)

The `report` agent gets `spec.md`, `verify.md`, the manifest, `review-*.md` and the git log. It writes `report.src.html` and cites proof only as `{{e12}}`. `report-render.ts`:
- **checks** that every id exists and is stamped for the final sha
- **inlines** everything into one `report.html`
- **refuses** an unknown or stale id

**Publishing:** the engine pushes `report.html` and `evidence/` into a folder per job on a single orphan branch, `kitchen-evidence`. Folders older than `evidence_keep_days` (default 30) are pruned. The engine then posts a PR comment with a table of each criterion, its Verdict and a thumbnail link, so the reviewer sees the evidence on GitHub.

**Redaction:** `redact.ts` masks secret-looking strings in text evidence. **Screenshots can't be scanned,** so Toolkits seed only fake data. The README says so.

### Ledger line

```json
{"t":"…","job":"012-dark-mode","stage":"verify","round":1,"event":"verdict","key":"012/verify/1/verdict",
 "result":"FAIL","role":"verifier","agent":"claude","model":"…","secs":212,"usd":0.41,"detail":{"failed":["C2"]}}
```

The ledger is append-only. Readers de-duplicate on `key`.

## 3. Agent adapters

```ts
interface AgentAdapter {
  name: 'claude' | 'codex' | 'fake';
  run(req: { role: string; prompt: string; cwd: string; model: string;
             tier: 'read' | 'write'; resumeSession?: string;
             timeoutSec: number; maxTurns: number;
             bridge?: BridgeServer; denyRead?: string[] }): Promise<{
    ok: boolean; line: string; sessionId?: string; rateLimited?: boolean;
    usage?: { usd?: number; inTok?: number; outTok?: number }; transcriptPath?: string }>;
}
```

**Permission tiers:**

| Tier | Roles | What it allows |
|---|---|---|
| read | intake, reviewers, report, retro | Read the repo |
| write | spec, builder, verifier, smith, setup | File edits in the worktree plus a shell |

**No agent gets git push or a GitHub token,** and that is enforced:
- Agents are spawned with a scrubbed environment: no `GH_TOKEN` or `GITHUB_TOKEN`, an empty `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL` pointing at a file with `credential.helper=` empty, and `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` (macOS's system git config turns on the keychain helper), `SSH_AUTH_SOCK` unset, `GIT_SSH_COMMAND=false`, and a command-scope `url.kitchen-push-blocked:///.pushInsteadOf=` that rewrites every push URL to an unknown transport, so no remote (SSH, HTTPS or a plain local path) can be pushed to.
- **Worktree code gets the same scrub (`untrustedEnv`).** Every process that runs code from a worktree (the app, tests, cmd proofs, Toolkit primitives) is started with the same allowlist and git/gh scrub, **without** the agent tool's own auth, plus the worktree's `.env.kitchen`. The Toolkit's control plane additionally gets `DOCKER_HOST`/`DOCKER_CONTEXT`, which `bin/dev` strips before starting the app. This hands app code no credentials; it does not confine it (it runs as the user, unsandboxed). An OS sandbox for app processes is a later hardening item (ADR 0006).
- **Agents can't write job state, or read the engine key.** An agent's writable root is its worktree only. It writes its one file at `.kitchen-out/<file>` inside the worktree (read-tier roles that run before a worktree exists, such as intake, get a scratch folder the engine creates for that run), and the engine copies it into `.kitchen/jobs/<id>/`, then deletes it. `.kitchen/jobs/` (with `job.json` and the manifest) is outside every agent's writable root. `$KITCHEN_HOME` is denied for reading too (Claude: `sandbox.filesystem.denyRead` + `Read(...)` deny rules; Codex: a permission profile with the folder set to `deny`). The signed manifest head is a second check behind that.
- **Project config in the worktree is ignored.** A worktree may carry `.mcp.json`, `.claude/settings.json` or `.codex/config.toml` (from the user's repo, or written by an earlier agent). Claude runs with `--setting-sources ""` and `--strict-mcp-config`; Codex with `--ignore-user-config`, which also drops project trust, so the project layer stays disabled. Proven with canaries that would run if loaded (ADR 0006, "Bridge").
- **The worktree's `.git` is never trusted.** In a linked worktree `.git` is a file the worktree controls; pointed at a hostile gitdir, a plain `git -C <worktree>` would run its `core.fsmonitor`, hooks or filters as the engine. So every engine git call goes through `engine/git.ts`: the gitdir is resolved once, engine side, at job creation (`<main>/.git/worktrees/<id>`, checked against git's own back-pointer) and passed with `--git-dir`/`--work-tree`, with command-scope config that turns off every program the engine's git commands could run (fsmonitor, hooks, filter drivers, ssh/askpass/credential helpers, `ext::`, editors, signing, submodule recursion). Read-only git (the source stamp) runs with the scrubbed env minus `.env.kitchen`; credentials are accepted only for `push`. Agents can't write `.git` either (Claude `denyWrite` + `Edit()` deny rules; Codex built in). ADR 0006, "Engine git".
- The engine commits what the builder leaves, pushes, and opens or updates the PR, using its own credentials, through the same `engine/git.ts`.
- A wall-clock limit and a turn limit per role are structure, not a cost cap.

**The engine bridge.** Neither tool's sandbox can reach Docker or the network (ADR 0006), so agents drive the app through `kitchen mcp --job <id> --role <role>`, an MCP server the agent tool starts (`AgentRequest.bridge`; built by `bridgeServer()` with an explicit env: Docker vars and `KITCHEN_HOME`). It runs as the engine, outside the Bash sandbox, and exposes only job-scoped tools:
- `drive`: one feature drive (by name, from the job's worktree) or one primitive, in the job's slot, stamped with the caller's role. Reserved args, unknown fields, other jobs and foreign origins are refused.
- `toolkit_status`: `doctor` for the job's slot.
- (W1) `checks` for the builder: `kitchen.yaml` checks in the worktree.

Wiring: Claude `--mcp-config '{"mcpServers":{"kitchen":…}}' --allowedTools 'mcp__kitchen__*'` (with `--strict-mcp-config`, only this server). Codex `-c mcp_servers.kitchen.{command,args,env}=…` plus `-c mcp_servers.kitchen.default_tools_approval_mode="approve"`: without it Codex refuses every MCP call ("requires approval, but approval policy is never"). The builder self-checks and the verifier and UX lenses ask for views this way; file requests (`VIEW:`, `--args`) stay as a fallback.

**UX and UI lenses** don't drive the app themselves:
- They get Verify's stamped screenshots.
- They may ask for more views (for example a page at 390 px) through the bridge, or by adding a line to their review file, `VIEW: <feature drive or page> --width 390`. Either way the engine runs it, it lands as stamped evidence, and the lens is re-run once with the new evidence.

The exact flags per tool, the writable roots and what W0 proved are in ADR 0006.

## 4. Commands

| command | does |
|---|---|
| `kitchen init` | Writes `kitchen.yaml`, installs the skill(s), runs `setup` (§5), runs `toolkit check`, prints next steps |
| `kitchen ticket "<text>" [--grill]` | Creates a prompt ticket; `--grill` interviews in the terminal or through the skill |
| `kitchen run [--detach] [--once] [<job>]` | Takes the lock and drains the queue across `concurrency` slots, resuming everything. `--detach` runs it in the background with a log file |
| `kitchen status` | One row per job: id, title, stage (and paused reason), round, last moved, PR, report link |
| `kitchen resume <id\|n>` · `feedback <id>` · `reject <id>` | Pick one job; human answers |
| `kitchen drive <job> <C>` | Run one proof (agents and humans use the same path) |
| `kitchen toolkit check\|up\|down\|maintain` | `maintain` = pstack's maintain pass: source wave plus live pass, one PR of proven fixes |
| `kitchen report` · `kitchen doctor` | Ledger summary; checks Kitchen itself (tools, versions, auth, Docker, gh) |
| `kitchen migrate` | Upgrades `kitchen.yaml` and the Toolkit contract version |

**The skill** maps what you type onto these commands. For a queue drain it runs `kitchen run --detach` and then reports `kitchen status`, so a tool call is never held for hours.

## 5. Setup (adopt or build)

1. **Headless survey.** The `setup` agent reads the repo: package scripts, compose files, Makefile, README, CI, env examples.
2. **At most 3 questions to the developer,** only what the repo can't answer. For example: "Is `docker compose up` your dev environment?", "Which external services need a mock or sandbox?", "Which fake env values belong in `.env.kitchen`?"
   - **Without a TTY** (inside Claude Code or Codex), `init` writes `.kitchen/setup-questions.json` and exits with code 3. The `/kitchen` skill asks the user, then reruns `kitchen init --answers <file>`.
   - **In a terminal,** it asks directly.
3. **Adopt or build.** Adopt wraps the existing commands into `bin/dev`. Build adds the missing pieces (compose file, seed script, snapshot) as a reviewable commit on a branch.
4. **Generate.** Produces `bin/dev`, `SKILL.md` and `features/` for the top 3–5 features (pstack shape).
5. **Prove.** Runs `toolkit check`. Setup is resumable, and each step writes its result.

## 6. Risk paths (kitchen.yaml defaults)

```yaml
concurrency: 2
round_limit: 3
models: { intake: strong, spec: strong, builder: strong, smith: strong,
          verifier: medium, reviewer: medium, report: medium, retro: cheap }
paths:
  low:    { spec: inline, verify: short, review: [code-if-diff>150] }   # a drive diff, a test file or test/build config forces the code lens
  medium: { spec: full,   verify: full,  review: [code] }
  high:   { spec: full,   verify: related-features, review: [code, security], human: always }
          # human: always → this PR can never be auto-merged (even if automerge is on), the PR gets
          #   label kitchen:review-required, and the Report opens with "what a human must check"
surfaces: { ui: [ux, ui], security: [security] }
high_paths: ["**/migrations/**", "**/auth/**", "**/*payment*", "infra/**", ".github/**"]
risk_floor: { diff_lines_medium: 300, diff_lines_high: 1000 }
automerge: off
protected: [kitchen.yaml]          # Toolkit edits are policed by layer rules, not this list
retro: { every_jobs: 5 }
```

**Risk floor.** After Gate, `risk-floor.ts` recomputes risk from the diff: `high_paths` touched, plus diff size. If the floor is higher than intake's rating, the job switches to the stricter path from Verify onwards. It only ever raises risk.

## 7. Waves

Each wave is built by subagents in worktrees and reviewed by an independent reviewer. The result must be shown working on fixtures before merge. **Every wave ends with a Codex smoke on fixture A** for the parts that wave added.

### W0: spikes, 2 days

**Builds:**
1. Headless roles on both tools: flags, session id, usage, tiers, turn limit, resume.
2. Codex skill location.
3. Codex sandbox and Docker.
4. A hand-written Toolkit for fixture A, covering `prepare`, `up` with snapshot restore, `reset` and drive sessions.

**Output:** an ADR on the adapters, including which flag enforces the writable root on each tool (the Codex workspace sandbox, Claude Code's sandbox setting).

**Exit:**
- A role runs on both tools.
- Fixture A's Toolkit honours the contract, including two slots running at once.
- **Integrity tests:**
  - From inside an agent run on both tools, `git push` fails and `gh auth status` shows no login.
  - A hand-edited manifest is refused.
  - An agent's write into `.kitchen/jobs/` fails.
  - An SSH push fails.
- **Drive format:** three real flows on fixture A (sign in and change a setting, a multi-step form with a wait, read a value and reuse it) written in the drive format, needing **no new primitive**.
- `kitchen run --detach` survives the end of the tool call that started it, on both tools.

### W1: skeleton

**Builds:**
- `config`
- `machine` (unit tests over the whole table)
- `store`, `lock`, `git` and `runner`, with slots and `--detach`
- the ledger
- the prompt ticket source
- `ticket`, `run`, `status` and `resume`
- the fake adapter

**Exit:** with the fake adapter, a scripted job walks through every stage, including paused, a free retry, done→build, and a kill and resume. Every refused move gives a reason.

### W2: Toolkit and setup

**Builds:**
- `toolkit-template`
- contract, `check`, `slots` and `describe`
- `prepare` handling
- the base-change re-proof
- the `setup` role (port of pstack create-verification-skill, MIT, credited) and its survey and questions
- `init`
- the skills

**Exit:** `init` passes on fixtures A–D, on both tools. superchat-lite: run `init` and record the time and what broke. That is a measurement, not a gate.

### W3a: proof and the core path

**Builds:**
- `proof/` (drive, manifest with hash, assert)
- `spec-lint`, `gate`, `risk-floor` and `verdict`
- the roles intake, spec, builder and verifier, including the drives mode
- stages intake through verify, including repro and drives, on fixture A with prompt tickets
- engine-owned commits, with a local branch only

**Exit:**
- One feature ticket and one bug ticket are proven end to end on fixture A, on both tools.
- Planted forged or stale citations are refused, as is a feature drive that tries to contain code.
- A kill and resume works mid-Verify.

### W3b: Toolkit stage, forge, benchmark

**Builds:**
- the smith role and the toolkit stage, with the engine-owned Toolkit checkout and PR pinning
- the layer rules
- `paused` with all its wait conditions
- ready
- `forge/github` (draft PR, checks, evidence branch) and the GitHub ticket source

**Exit:**
- The full benchmark (§8) meets §0.2 for the features, bugs, traps and controls.
- **One superchat-lite ticket goes end to end.**
- Dogfooding starts.

### W4: review, report, feedback

**Builds:**
- reviewer roles
- lens routing
- de-duplication and confidence filtering
- `report` role and `report-render`, with the PR comment
- `done→build` from PR comments
- `feedback` and `reject`
- `toolkit maintain`, triggered when the feature-mapped paths change by more than N lines since the last maintain

**Exit:** the full benchmark meets §0.2 and §0.3. The Codex subset passes.

### W5: learning, dashboard, release

**Builds:**
- `retro` every 5 jobs
- dismissal signal: a 👎 reaction or a "not useful" reply on a review comment, read through the forge, plus `kitchen dismiss <finding>`
- `kitchen report` and the dashboard
- README with a 5-minute quick start
- `migrate`
- npm 0.1.0

**Exit:** all §0 measures met. A newcomer, following only the README, gets from a fresh clone of fixture B to a ready PR.

## 8. Fixtures and benchmark

**Fixture apps:**
- **A:** Node web app, Postgres, local login (build path).
- **B:** Python CLI tool with a SQLite store (terminal drives).
- **C:** A, with an existing compose setup and README (adopt path).
- **D:** an API-only service that depends on an external payment API (Stripe sandbox, or a mock) and on email (a mail catcher). Covers externals.
- **superchat-lite:** adopt path, read-only. Benchmark tickets run on a scratch branch.

**Tuned set: 14 tickets.**
- 4 features
- 3 bugs (one hard to reproduce)
- 1 chore
- 1 too big
- 1 needing info
- 1 to reject
- 1 needing a new primitive
- 2 planted-correct controls: tickets whose naive build is right, to measure false FAILs

3 of the tickets hide traps. Every ticket runs **3 times**.

**Held-out set: 6 tickets** (until superchat-lite replays are affordable: fixture E, see "Changes from the final fixes"), replayed from real merged superchat-lite PRs, with their parent commit as the base. Role prompts are never tuned on it. A replay passes when:
- the tests the original PR added or changed pass on Kitchen's branch, and
- Kitchen's own Verdicts are PASS, and
- a human spot-check finds the change does the same job as the original.

**Two tiers, so it stays affordable:**

| Tier | What runs | When |
|---|---|---|
| **Smoke** | 5 tickets (1 feature, 1 bug, 1 trap, 1 control, 1 low-risk), single run | After every role prompt change |
| **Full** | 14 tickets × 3 runs, the held-out set × 3, and the Codex subset × 3, about 78 jobs | At wave exits only |

Expected time and cost for each tier are recorded in the ledger after the first run and printed by `kitchen report --bench`. All real-agent runs are started by hand, never in CI by default.

## 9. Testing strategy

| Level | Covers | When it runs |
|---|---|---|
| Unit tests | Pure code only: machine, spec-lint, assert, verdict, risk-floor, report-render, config, contract parsing, slots | CI |
| Fake-adapter runs | The engine, including kill and resume | CI |
| The benchmark | Validates the factory | Started by hand |

No pile of unit tests added per fix.

## 10. Risks

| Risk | Handling |
|---|---|
| Tool flags drift | W0 ADR. `kitchen doctor` checks versions. The adapter refuses unknown versions with a clear message |
| A flaky Toolkit | `doctor` before drives. A free INCONCLUSIVE retry, then paused plus a Toolkit ticket. Flake rate per drive is in `kitchen report` |
| Fresh worktrees won't start | `prepare` with a shared cache, timed in `toolkit check` |
| Main moves under the Toolkit | `.kitchen/toolkit.proven` sha; re-proof before new work; queue pauses on failure |
| Prompt injection | Ticket text is quoted data. The label gate. Read-only roles read it first. **Agents hold no push or GitHub token** |
| Agent writes a bad repro | The repro must fail on base through `kitchen drive` with a mechanical expect |
| Too heavy for small tickets | Risk paths. The ledger shows time per path |
| Rate limits | `paused` with backoff; never needs-human |
| Codex sandbox blocks Docker | Toolkit runs outside the sandbox, started by the engine, decided in W0 |

## 11. Out of scope for v0.1

- competing builds per ticket
- cloud or container runners (an optional container runner is the first thing after 0.1)
- GitLab and Linear
- Windows
- mobile apps
- a hosted dashboard
- auto-merge beyond the opt-in low path
- Kitchen editing its own prompts

## Changes from v1 (review round 1, score 6/10)

| Finding | Change |
|---|---|
| B1 smith vs feature drives | Toolkit split into two layers: primitives go through the smith on its own PR, proven on main, and the job pins that sha. Feature drives are added by the smith inside the job PR. The engine rejects Toolkit edits from the builder |
| B2 forgeable evidence | `kitchen drive` is the only proof runner. Evidence is stamped with sha, round and criterion. Mechanical `expect:` is decided by the engine. The agent judges only `judged` criteria, with stamped citations |
| B3 report unreachable | Orphan evidence branch, plus a PR comment with Verdicts and thumbnails |
| B4 worktrees won't start | `prepare --src`; Kitchen always runs main's `bin/dev` with `--src` |
| M1 ports | A slot pool per machine, ports probed in 31000–32767 |
| M2 shared instance | `down` and a fresh `up` (snapshot) before Verify |
| M3 drive sessions | Sessions last until `reset` or `down`; one JSON line per drive |
| M4 push rights | The engine commits, pushes and opens the PR; agents get no token |
| M5 risk rated by the beneficiary | Diff-based risk floor after Gate, raise only |
| M6 INCONCLUSIVE burns a round | Free retry, then paused plus a Toolkit ticket |
| M7 bug path | `repro` stage; the repro must fail on base and is committed; exit to needs-info |
| M8 done terminal, CI unread | `done→build` on feedback; Ready needs green `gh pr checks` |
| M9 main moves | `toolkit.proven` sha and re-proof before new work |
| M10 maintain | `kitchen toolkit maintain` with a churn trigger; capabilities generated by `describe` |
| M11 interview vs headless | Headless survey, at most 3 terminal questions |
| M12 long drains | `run --detach`; the skill reports `status`; Codex sandbox tested in W0 |
| M13 rate limits | `paused` state with backoff |
| M14 benchmark n=1 | 14 tickets × 3 runs, controls, a held-out set from real superchat-lite PRs |
| M15 generality | Fixture D with externals, an `externals` field, mobile out of scope |
| Minors | Re-verify only if base moved; retro every 5 jobs plus a dismissal signal; idempotency keys (`filed`); per-project role overrides; `migrate`; low-risk criteria go through spec-lint; wall-clock and turn limits |
| Buildability | Smith moved to W3 and maintain to W4; Codex smoke every wave; superchat-lite is a W2 measurement and a W3 exit |
| Kept despite the review | The Report is still written by an agent (the user decided this in Q16). The script only checks and inlines what it cites |

## Changes from v2 (review round 2, score 7.5/10)

| Finding | Change |
|---|---|
| N1 no trigger for feature drives | New `drives` stage between Gate and Verify. The verifier role writes them, and the engine commits them before any proof runs |
| N2 rules without mechanism | `manifestHash` in `job.json`; mechanical proofs run engine-only, first; agents get a scrubbed environment; W0 integrity tests |
| N3 forgeable feature drives | Feature drives are declarative lists of primitives with no code. Code goes through the smith. The code lens reviews drive diffs |
| N4 paused without exits | `pausedFrom` and `waitFor` (backoff, toolkit-pr, ci, toolkit-ticket); a paused job releases its slot |
| N5 "main's bin/dev" | An engine-owned base checkout at `toolkitRef`; primitives come from it, feature drives from `--src` |
| N6 no TTY in the tools | `setup-questions.json`, exit code 3, `init --answers` through the skill |
| N7 UX/UI lenses blind | They get stamped screenshots and can ask for more views through `kitchen drive --view` |
| N8 benchmark cost | Smoke and full tiers; 2 controls everywhere; replay scoring defined; cost recorded |
| N9 W3 overloaded | Split into W3a and W3b |
| Minors | `.env.kitchen`, never the real `.env`; every bug goes to repro; light re-proof when Toolkit paths didn't change; one evidence branch with retention; `human: always` defined; `--args` changes logged; slots of 20 ports with stale reclaim; W0 tests that `--detach` survives; "all 3 runs"; ADR 0005 written and ADR 0002 updated |

## Changes from v3 (review round 3, score 8.5/10)

| Finding | Change |
|---|---|
| M1 missing exits | `drives → build` when the feature is unreachable (costs a round); `drives → needs-human` after 2 drive attempts fail; `returnTo` in `job.json`; `toolkit → drives` always after a new primitive |
| M2 every Toolkit needs an interpreter | The engine (`proof/drive.ts`) interprets feature drives. The format is defined, with `wait`, `retry`, `save` and `$var`. W0 proves 3 real flows need no new primitive. Primitive PRs per job are tracked |
| M3 `toolkitRef` lifecycle | It moves on sync or Toolkit-PR merge, then drives and Verify re-run; `prepare` covers the Toolkit checkout, cached per sha; unused checkouts are removed |
| Minors | Gate stays valid only when the commits after it touch nothing but `features/*.md`; agents write to `.kitchen-out/` and the engine copies (jobs folder outside every agent's writable root); fuller push scrub (`GIT_CONFIG_NOSYSTEM`, SSH); a drive diff forces the code lens; stale text fixed; intake row split into three; `needs-info → rejected`; report → needs-human after 2 refused renders; toolkit-ticket wait capped; how `VIEW:` requests work |

## Checkpoints only running can score (from review round 4, score 9/10)

| When | Checkpoint | Stop rule |
|---|---|---|
| W0 | All four integrity tests pass on Claude Code and Codex, and Docker works under the Codex sandbox | If not, write the fallback ADR before W1 |
| W0 → W3b | The drive format covers real flows: primitive PRs per job in the ledger | More than about 1 job in 5 waiting on a Toolkit PR means the format gets more power before W4 |
| W2 | `init` on superchat-lite: time and failure list | Over 60 minutes, or hand fixes needed, means rework setup before W3a |
| W3b | Verify precision: false FAILs on controls, INCONCLUSIVE and flake rate per drive | The §0.2 thresholds, and a flake rate under 5% per drive |
| W3b onward | Median time and cost per risk path from the first full benchmark | Set a target for low-risk tickets then; the low path must be clearly shorter |

Round 4 minors are applied: the `toolkit` return rule depends on where the job came from, there's now `repro → toolkit`, the stale interpreter wording is fixed, roles without a worktree get a scratch folder, and the adapter ADR records the sandbox flags.

## Changes from Wave 0 findings (ADR 0006, spikes/w0/toolkit-results.md)

History: all of these are now part of §2 and §3, which are the current contract. The bridge was built and proven on both tools in the W0 review round (next table).

| Finding | Change |
|---|---|
| Neither tool's sandbox can reach Docker; agents have no network | **Engine bridge:** `kitchen mcp --job <id> --role <role>` is an MCP server that the agent tool starts. It runs outside the Bash sandbox, as the engine, and exposes only job-scoped tools: `drive` (a feature drive or one primitive, in the job's slot, stamped), `toolkit_status` (doctor), and for the builder `checks` (runs `kitchen.yaml` checks in the worktree). It refuses anything outside the job. This is how the builder self-checks and how the verifier and UX lenses ask for views. File requests (`VIEW:`, `--args`) stay as a fallback. W1 must prove the bridge works on both tools |
| Primitive calls overwrote each other's files | `--out <dir>` on every primitive call; the engine passes `files/e<N>/` |
| `wait` is built on `read` | `read {target, attr?}` is a required primitive. `wait: { until: { text, target?, attr? } }` |
| The list of features must come from the job branch | `describe [--src]`; `describe` also declares `ports.needs` |
| Drive results can't be asserted | A drive returns its saved `vars`; `expect:` in the spec may use `$var` |
| Single-page apps need navigation | `open {path}` and `reload` become generic primitives |
| A TOOLKIT-GAP left nothing to cite | Gaps are stamped in the manifest |
| Drive format | The restricted YAML subset (one step per line, `save:` as the only continuation) is the official format. Wait polls are collapsed into one entry with a count |
| Mixed import styles | `.ts` relative imports everywhere (`rewriteRelativeImportExtensions`), so the code runs directly on Node and builds with tsc |
| Skills | The same `SKILL.md` goes to `.claude/skills/kitchen/` and `.agents/skills/kitchen/` |
| `--detach` from inside a sandbox keeps the sandbox | The `/kitchen` skill starts `kitchen run --detach` outside the sandbox (a one-time approval on Codex) |

## Changes from the Wave 0 review

| Finding | Change (in §2/§3, proven by `spikes/w0/`) |
|---|---|
| Worktree code ran with the engine's full env (a fake `GH_TOKEN` showed in `ps eww <appPid>`) | One `untrustedEnv()` for every process that runs worktree code; `bin/dev` strips the Docker vars before starting the app; push blocked by a command-scope `pushInsteadOf`. An OS sandbox for app processes is a later hardening item |
| A drive step could override engine flags (`id`, `out`) | Reserved args refused by the parser; `--k=v` argv; `bin/dev` refuses a flag given twice |
| Codex refused MCP calls under `approval_policy="never"` | `mcp_servers.kitchen.default_tools_approval_mode="approve"` |
| Manifest hash in a sibling file, default-trusted | Hash chain + per-file hashes + engine-signed head in `job.json`, required by every verify; ids never restart |
| `${BASE}${p}` could leave the app; e<N> prediction raced; project config in the worktree; bridge without Docker env | `new URL` + same-origin; per-job drive lock; project config proven ignored (canaries); `bridgeServer()` passes Docker vars explicitly |
| Empty waits passed; missing attributes read as "" | Empty wait text fails; `read` of a missing attribute is `ok:false` |
| Slots didn't record their Toolkit; pid reuse; lock stolen by age | Slots store `toolkitBin`, `src`, `pidStart`; reclaim runs that `down`; owner-based lock |
| Stamped sha could be "unknown" or the kitchen repo's | HEAD of the tested worktree + `dirty` + `tree`; no git, no proof |
| Codex agents could read `$KITCHEN_HOME` (the engine key) | Codex runs under a permission profile with `$KITCHEN_HOME` denied; Claude gets `sandbox.filesystem.denyRead` + `Read()` deny rules |
| Engine git trusted the worktree: a redirected `.git` file + `core.fsmonitor` leaked `GH_TOKEN` through the source stamp | `engine/git.ts`: gitdir resolved engine side at job creation, explicit `--git-dir`/`--work-tree`, neutral config (fsmonitor, hooks, filters, helpers…), scrubbed env without `.env.kitchen`, credentials for `push` only; agents can't write `.git` (Claude `denyWrite`). `spikes/w0/git-redirect.ts` |
| An older `job.json` + manifest pair (both signed) could be restored | Per-job counter `$KITCHEN_HOME/heads/<uid>`; a lower head is refused as a rollback |
| Network denial was only seen through push failures | The integrity probe checks `curl` and a direct `nc` to an IP on both tools |
| A stamp's tree vs the running app | A stamp records the worktree tree at drive time; the fresh `up` before Verify makes the running app match it |

## Changes from Wave 2 (spikes/w2/results.md)

| Finding | Change |
|---|---|
| `toolkit check` needs concrete args for every drive, and the re-proof needs to know which source paths a feature lives in | Each `features/<x>.md` carries one fenced `kitchen` block: `paths: [globs]` and one `check: { drive, args }` line per drive. Parsed by the engine (`src/toolkit/contract.ts`), like the drives |
| `describe` had no version and no surface | `describe` prints `contract: 1` (required by `toolkit check`), `surface: web\|cli\|api` (a `web` Toolkit must list the generic primitives), `seed_users` (snake case, plain strings) |
| The setup agent has no network and no Docker, so it can't run the Toolkit it writes | The setup role gets its own engine bridge, `kitchen setup-mcp` (`toolkit` = one bin/dev command in its own slot; `toolkit_check` = the real check on its worktree). Like every Toolkit run it uses the untrusted env; it runs code the agent wrote outside the agent's sandbox, which is what `toolkit check` does anyway (same residual risk as app code, ADR 0006) |
| Writing a Toolkit from nothing is slow and error-prone | `toolkit-template/`: a generic `bin/dev` (flags, ids, state, JSON lines, generated `describe`, cleanup of everything it started) plus optional browser and terminal modules; the setup role fills in `app.mjs`, `SKILL.md` and `features/` only |
| Setup is two agent passes | `survey` (headless, ≤3 questions in a json block) and `build`, which resumes the survey's session; up to 2 `fix` rounds fed with the engine check's failed steps |
| Where init's output lands | `kitchen.yaml`, `.gitignore` entries and the skill go into the working tree (the user commits them); the Toolkit (and any dev-environment files the build path adds, as a separate commit) goes on the branch `kitchen/setup`. `toolkit.proven` names that commit (`branch: kitchen/setup`); a fast-forward merge needs no re-proof |
| A queue pause needs somewhere to live | `.kitchen/queue.json` (`kitchen status` prints it). It stays paused until the base moves again or the Toolkit ticket is closed; then the re-proof runs again. A base without a Toolkit yet (init's branch not merged) is not re-checked |
| Machines that can't run a project's stack | `kitchen init --generate-only`: the setup agent writes the Toolkit but may only run `describe`; the engine checks describe and the feature files statically and writes no `toolkit.proven` |
| `toolkit up\|down\|maintain` | `toolkit up` (foreground, one slot, Ctrl-C brings it down) and `toolkit down --id` were built in the W2 review round; `maintain` stays W4 |
| Jobs still run the repo's own `.kitchen/toolkit/bin/dev` (W1) | The engine-owned checkout (`src/toolkit/checkout.ts`) is built and used by `toolkit check`, the re-proof and init; switching jobs' `toolkitBin` to it lands with the smith and PR pinning (W3b) |

## Changes from Wave 3a (spikes/w3a/results.md)

| Finding | Change |
|---|---|
| A repro whose `wait` for the expected state times out is the bug showing, but the strict rule called it "not reproduced" | Failed as expected = every step ran and the mechanical expect is false, **or** a `wait` timed out after every earlier step ran |
| A repro agent rewrote a shared feature drive to make its proof pass | No job (repro or drives) may change an existing drive block; it may add new ones. The repro's drive files are the builder's no-go list |
| Builders can't self-check new server code against an app started earlier | Bridge tool `restart_app` (builder only): down + up from the worktree, prepare when needed |
| Builders want to know whether a criterion holds | Bridge `drive` with only `criterion` runs that criterion's proof and its expect (the same path as `kitchen drive <job> <C>`) |
| Claude's Read tool can't open the job folder's screenshots | Verify copies the judged criteria's evidence into the worktree outbox; citations are still checked against the signed manifest |
| `GAP: none` read as a gap | Header values like none, n/a, - name nothing |
| Slot ids from job ids were too long for `--id` and collided across repos | `slotId` = `<n>-<10 hex of the job uid>` |
| `test <file>` proofs need a command | `kitchen.yaml` `test_cmd` (default `npm test -- {file}`) |
| The verifier agent cost a run even when nothing is judged | Verify starts the agent only when there are `judged` criteria and every mechanical proof passed; drives starts it only when a drive is missing or failed the check |

## Changes from the Wave 2 review

| Finding | Change (proven by `spikes/w2/`) |
|---|---|
| A `bin/dev` timeout never fired when a child held stdout (a 2 s timeout returned after 146 s) | `runToolkit` spawns `bin/dev` in its own process group and, on timeout, kills the group and stops waiting on the pipes; the result says `timed out after Ns`. After a normal exit the pipes get 1 s to drain. `prepare` also fails when it prints nothing for 5 minutes (stall). `timeout.ts` |
| A broken Toolkit passed `toolkit check` | One JSON line per call, http(s) `url`, `doctor` with ≥1 check, `surface` an enum, and the contract probe (every primitive once + the required refusals). `probe.ts`: the reviewer's fake and each of its faults fail, named; the 7 generated Toolkits of A–D and fixture A's hand-made one pass |
| Feature `paths` could be empty or a typo, which weakened the re-proof | `paths` required; every glob must match a tracked file at the base |
| `parallel:false` wasn't enforced (init edited `kitchen.yaml` with a regex) | The runner uses `min(concurrency, proven.parallel ? n : 1)`; init no longer edits `kitchen.yaml` |
| An init re-run after a failed check said "done" | Only a passing full check is done; a failed or static check is run again on a re-run; otherwise init exits 1 with the real state |
| Setup from inside the tools held one long Bash call | `kitchen init --detach` + `.kitchen/init/status.json` + `kitchen init --status [--wait ≤110]`; one init per repo at a time. The skill starts it outside the sandbox and polls with `--wait` (Claude Code refuses a foreground `sleep 60`) |
| Real values could be committed in `.env.kitchen` | A secret scan of everything the setup commit stages: live-key shapes and any value equal to one in the developer's untracked `.env*`; the commit is refused, naming file, line and key |
| Checkout GC could remove a checkout in use | Per-checkout leases (owner pid + start time) and live slots' `toolkitBin` keep GC off it; creation and removal share one lock. `gc.ts` |
| The setup bridge ran agent-written code unconfined | ADR 0008: on macOS every `bin/dev` the bridge runs goes through `sandbox-exec` denying credentials, agent auth and `$KITCHEN_HOME`. `sandbox.ts`. Linux: unhandled |
| `.env.kitchen` could set `PATH`, `NODE_OPTIONS`, `DYLD_*`, `LD_*`… | Those names are dropped before the env is built |
| `prepare` cache per sha only | Also per lockfile hash for the same source tree; a `setup` model key in `kitchen.yaml`; `kitchen toolkit up|down` |

## Changes from the Wave 3a review (round 1, 6.5/10)

| Finding | Change |
|---|---|
| `GAP: the \`read\` primitive fails…` named the primitive "the" | A gap is one primitive-shaped name (optionally followed by a separator and a note) that describe doesn't list; free text is a failed drives write (counts toward the drives cap) and an INCONCLUSIVE in Verify, never a Toolkit gap |
| The drives check ran each new drive alone from seed, so a drive that needs an earlier segment's state failed | The drives check runs each affected criterion's **whole proof** twice (reset between), asserting every step runs (not the expect). A feature file a job writes must pass W2's feature rules (`parseFeature`, a `check:` line per drive, listed by describe) or it is kept off the branch |
| Trivially true criteria passed (`not visible` of something that never existed, an error page, an empty read) | spec-lint: a negative expect needs an earlier step of the same proof that creates what must not show (its text is an arg). A negative clause fails on an error/not-found page, a failed response or an empty read. The engine runs every mechanical criterion once on the **base** before build (`base-check.json`, `phase: base`); a feature criterion that already passes there sends the spec back once, then is flagged NON-DISCRIMINATING in the verdict |
| The builder controlled files proofs run through | The builder may not change: the test files `test` proofs run (the drives stage, or the repro, writes them), the scripts and config Gate's checks and `test_cmd` run through, package.json `scripts`. A diff touching `seed_paths` (default: migrations, seeds, `db/**`, `*.sql`…) raises risk to high and is listed for review (`seed-diff.md`, review prompt) |
| `cmd` proofs were unrestricted | spec-lint refuses paths outside the worktree, `~`/`$HOME`, `env`/`printenv`, network tools and redirections outside; cmd/test proofs keep the untrusted env (W2's sandbox-exec profile when it lands); every bridge result passes through `proof/redact.ts` |
| A cmd/test expect could pass on a crash | It holds only with exit 0 unless the expect is about `exit` |
| A repro's timed-out wait counted however unrelated | Only when the waited text is what the criterion's own expect asks for |
| `judged` was allowed for "message", "label", "reads", "width" | Only layout, appearance, visual style, tone or copy quality, and the proof must take a screenshot. `repro: true` only on a bug |
| A refused manifest could still give PASS | INCONCLUSIVE |
| No job could fix a drive it had added itself on a retry | "Existing" drives are the base's (and, for the drives stage, the repro's) |

## Changes from Wave 3b (spikes/w3b/results.md, bench/results/)

| Finding | Change |
|---|---|
| Jobs ran the repo's own `bin/dev`; `toolkitRef` was a hash of `describe` | A job's `toolkitRef` is a real git sha from creation (the base, when it has a Toolkit); every stage runs `bin/dev` from the engine-owned checkout `_toolkit@<sha>` (`src/engine/job-toolkit.ts`), sandboxed while the sha isn't merged (ADR 0008); `prepare` is redone when the checkout changes |
| The smith edited the job worktree and the engine stripped its work | The smith works in its own engine worktree on `kitchen/toolkit/<job>-<n>` from the job's Toolkit, with the setup bridge on that worktree (`toolkit`, `toolkit_check`). The engine commits only `.kitchen/toolkit/` outside `features/`, runs the full `toolkit check` of that commit (sandboxed), requires describe to list the gap, opens the Toolkit PR through the forge, and pins `toolkitRef` to the commit. A failed check is written for the smith's second try (`toolkit-check-<n>.json`) |
| A spec could not name a primitive that doesn't exist, so the toolkit stage was unreachable from spec | `roles/_proofs.md`: a behaviour only a missing primitive can observe names it as a plain segment (generic, read-only), never a workaround; spec-lint sends the job to the smith (the W3b real run named `sql`) |
| Ready assumed "synced, base unmoved" | Ready: an open Toolkit PR pauses first; then the engine merges the base tip into the job branch (`mergeRev`; a merge driver in the config is refused). Conflict → build: the merge is restarted with markers for the builder and concluded by the engine's commit (a file only the base changed passes the builder's layer rules when it is exactly the base's version). Clean merge → `base` and `toolkitRef` move to the tip, the branch is pushed, and Gate, drives, Verify (and review) run again. Red CI → build with `ci.md` for the builder. Review runs again after a sync too (verify → review is the only exit); cheap on the medium model, left as is |
| The base for a GitHub repo is the remote's, not the main checkout's | `refs/kitchen/base`, fetched from `forge.url` by engine git; a Toolkit sha is merged when it is in that ref (GitHub forge; never the local HEAD, W3b review) or in HEAD (local forge) |
| GitHub forge | `src/forge/github.ts`: `gh` with the engine's env; draft PR found by branch; labels (`kitchen:review-required` on high risk, `kitchen-toolkit`); `gh pr checks` folded to none/pending/pass/fail (exit 8 = pending); comments and Toolkit tickets idempotent by a hidden key marker; ready-for-review at report. Pushes and fetches only through engine git to the explicit URL (ADR 0006 W3b section) |
| Evidence branch on GitHub | W4's `evidence-branch.ts` builds the commit; the GitHub forge fetches the remote branch first, commits on top, pushes to the explicit URL, never forced. Engine git on the main repo runs with `cwd` = its gitdir, inside the work tree, so path-limited commands need `--full-tree`/`:(top)` (pruning matched nothing before) |
| Issues as tickets | `src/sources/github.ts`: open issues with `source.label` (the trust boundary); needs-info question as an idempotent comment; replies count only from the issue's author or `source.operators`, never Kitchen's own |
| Report | W4's report role; W3b adds `markReady` (the draft PR is ready for review once the report is up). W3b's benchmark ran on a placeholder report template, before the merge |
| `http` couldn't assert a 4xx (W4) | `http --expect_status <n>`: ok only for that status; without it a 4xx stays ok:false |
| `test` proofs get no app URL (W4) | **Open**: record `up`'s url per slot and pass `KITCHEN_APP_URL` to cmd/test proofs (proof/ is the W3a fixer's) |
| Proof lines pass only strings, so a CLI Toolkit's list arg (`cli --argv`) took "done 1 2" as one word (smoke run 1: 3 of 3 fixture B tickets missed) | The template's `cli` splits a string argv like a shell line (`toolkit-template/lib/terminal.mjs`, and fixture B's bench Toolkit) |
| Benchmark | `bench/set.yaml` (14 tuned on A, B, C; 6 held-out on D), hidden oracles in the spec format run through `prove()` on the final branch, `kitchen bench smoke|full|tuned|heldout`, `kitchen report --bench`. Every oracle is checked to FAIL on the base, and planted bugs' oracles to PASS once the plant is taken out (`spikes/w3b/oracles.ts`) |
| Held-out set: 6 replays of real superchat-lite PRs | superchat-lite's stack is over this laptop's Docker budget (W2), so the held-out set is 6 tickets on fixture D, which no role prompt was tuned on. **Owed:** the superchat-lite replay set and the superchat-lite end-to-end ticket of the W3b exit, on a machine that can run its stack |
| §0.2 on Claude (3 runs per ticket, the held-out set on D) | **Measured** (pre-W4 review/report): 53/60 correct = 88% (≥85% ✓); 0 false FAILs on controls ✓; held-out 94% vs tuned 86% ✓; traps all 3 runs ✗ (b-done-many and c-unused-invites 2/3, the misses ended needs-human; no `done` ever failed its oracle). **Not measurable here:** §0.3 (Codex quota until 2026-12-21), the superchat-lite replay held-out set, and the INCONCLUSIVE/flake rate per drive, which the bench now tallies (`src/bench/tally.ts`, a Drives table in each results file) but has not measured yet: the next bench run gives the first numbers |
| Not done | The real GitHub run (`spikes/w3b/github-live.ts`, needs the user's approval and a throwaway repo); dogfooding. (The Docker bind-mount rule of ADR 0008 was built in the W3b review round, below) |

## Changes from the Wave 3b review (spikes/w3b/results.md "Review fixes")

| Finding | Change |
|---|---|
| The smith's proof ran the full check against the base app: a bug in the base that an existing drive exercises failed it (w3a `gap` 2/5) | The toolkit stage runs the base's own check once per base sha (drives only, failures listed, `.kitchen/toolkit-base-checks/<sha>.json`). The smith's check must pass the contract probe, every drive that uses the new primitive and every drive that passes on the base; drives that already fail on the base are tolerated as known (`toolkit check` `tolerate`), named in the Toolkit PR. A base that can't run its drives is an engine error. `toolkit → toolkit` while smith.attempts < 2: the second try starts from the first commit and reads `toolkit-check-<n-1>.json` |
| Ready read CI for an older pushed head (the drives stage commits after build's push) | Ready publishes HEAD (`publish/<head>`) before reading checks; `ready → report` needs `pushed`; `job.pr` follows the PR HEAD was published to |
| A sync resolution the layer rules refuse dropped the base's change silently | Any refused base-changed file aborts the sync merge → needs-human naming the files |
| `mergedIntoBase` trusted the local HEAD on the GitHub forge | GitHub forge: only the fetched `refs/kitchen/base` (`mergeBaseRef`) |
| A closed unmerged Toolkit PR paused the job forever; a closed job PR could be reused | `Forge.prState` (open/merged/closed); closed → needs-human with the reason (`ready > needs-human`); `prFor` finds open PRs only |
| Sandboxed Toolkit code could `docker run -v $HOME:/h` (ADR 0008 residual) | A validating Engine-API proxy outside the sandbox (binds outside the repo, its worktrees and temp, privileged, host pid/network/ipc/userns, dangerous caps, privileged exec refused), the daemon's sockets denied inside the sandbox, a `docker` shim for readable errors. TCP endpoints, existing containers and merged Toolkits stay outside it (ADR 0008) |
| a-primitive's oracle was a grep | It signs in through the app and reads `users.last_login_at` in the oracle app's Postgres (a `cmd` proof over loopback, `{port:<i>}` filled from the slot); a refused sign-in must leave it NULL |
| CI with no checks yet / cancelled | No checks after a push is green only without workflow files, else after `ci_grace_sec` (default 120); a cancelled run is read once more, twice is red |
| GitHub issues could be edited after the label (the trust boundary); `since: job.updatedAt` skipped early replies | An issue edited after its latest label event is not taken in (one comment asks for the label again); replies count by position after Kitchen's question |
| Bench | a-too-big: needs-info / rejected only and no build stage (`expect.never`); INCONCLUSIVE/flake per drive tallied; oracle infrastructure errors retried once; results labelled with the Kitchen sha |
| Evidence pruning read as deletion | ADR 0006: pruning removes a folder from the branch tip only; history keeps it; redaction is the protection |

## Changes from the Wave 3a review (round 2)

| Finding | Change (proven by `spikes/w3a/`) |
|---|---|
| The spec can drop part of the ticket ("with no owner shown") and still pass every check | Structural, no extra agent (ADR 0003): intake writes `## Requirements` (R1..Rn, negative ones marked, rescoped ones `(out of scope)`); each criterion has `covers:`; spec-lint rule 7 refuses an uncovered R, a criterion covering none, or a negative R no covering criterion asserts the absence of. `e2e.ts claude admin` on the verbatim ticket; `wrong.ts claude owner` |
| The base check skipped every criterion that needed a new drive | After the drives stage, those criteria run on a checkout of the base plus only the new drive and test files (`.worktrees/<id>.base`, same slot, fresh app, `phase: base`); one that passes is NON-DISCRIMINATING (`base-check.json` `afterDrives`), shown in the verdict row and footer, the verifier's prompt and the review prompt (`facts.review.nonDiscriminating` for W4). Features only: a bug's repro covers it. `paths.ts nondisc` |
| cmd/test proofs ran unconfined; only bridge replies were redacted | cmd and test proofs run under a `sandbox-exec` profile (`src/proof/sandbox.ts`: loopback only, `$HOME` unreadable but the worktree and toolchains, writes in the worktree and temp, W2's credential list + `$KITCHEN_HOME` + `.kitchen/jobs` + git config denied); Linux logs UNSANDBOXED. Evidence files are redacted when written (stamp-cmd, drive). The cmd denylist stays as a first line; `_proofs.md` and ADR 0006 say the sandbox is the boundary. `contain.ts` |
| A new drive could work only in-chain, then fail W2's base re-proof after merge | The drives stage runs every new `check:` line alone from seed (reset, then that drive with its check args); a failure goes back to the drives role, told to make the check line self-sufficient. `paths.ts nondisc` |
| `$o == ""` held whenever the element was missing | The lint treats equality to empty as a negative: it needs an earlier step that makes something (a feature drive or a writing `http`) |
| The builder policy was a ternary chain | A rule table (rule → reason) in `contract.ts` |

## Changes from Wave 4 (spikes/w4/results.md)

| Finding | Change |
|---|---|
| "A finding blocks only if the reviewer can show it" was a rule in a prompt | The engine decides (`src/checks/findings.ts`, ADR 0003): a lens writes `### F<n>` blocks with `kind`, `confidence`, and anchors (`at: file:line`, `requirement: R<n>`, `evidence: e<N>`). A finding blocks only when it names an anchor and every anchor holds (the line exists at HEAD, the requirement is in scope, the ids are in the verified manifest) and its confidence isn't low; else it is a note with the reason. Same line (or same requirement) across lenses → one finding (superseded by the review round below: same file and line only). The lens's `VERDICT:` is informational |
| Precision needs counts | Per-lens `review-lens` ledger lines (findings, claimed blocking, blocked, low confidence, not demonstrable, merged); `kitchen dismiss <job> <finding> [--reason]` writes `dismissed.jsonl` and a `finding-dismissed` ledger line with the lens (W5's retro reads them); since the review round a dismissal also takes effect (below) |
| The builder chased notes | Its "earlier rounds" block carries only the findings that blocked |
| Lenses ran one after another | In parallel, up to `concurrency`; every lens reads one packet (requirements, contract, verdict with NON-DISCRIMINATING flags, verify.md, seed-diff.md, diff) |
| UX/UI lenses and `VIEW:` | Verify's screenshots for this HEAD (a criterion's own first) are copied where a read-tier agent can open them. `VIEW:` (a page `/path [--as user]`, a feature drive, or toolkit segments; at most 3 per lens) runs through `src/engine/views.ts` (prove.ts, stamped `role: reviewer-<lens>`, `criterion: view:<lens>`), then the lens runs once more. `kitchen drive <job> --view "<view>"` runs one by hand |
| `human: always` | The review stage labels the PR `kitchen:review-required` (Forge.label, once); the renderer refuses a report without `<section id="human-check">` on that path and puts it first |
| Report: what the agent writes vs what the engine states | The report role (read tier, medium) writes only prose sections (`human-check`, `summary`, `changes`, `notes`) citing `{{e<N>}}`. `report-render.ts` refuses unknown ids, ids not stamped for the final HEAD and any other `{{…}}`; strips scripts, handlers, frames and remote URLs (plus a CSP meta); inlines screenshots as data: URIs; and adds the engine's own sections from job files: requirement → criteria → decided by → verdict → evidence thumbnails (NON-DISCRIMINATING flagged), review findings (blocking, notes, why kept as a note, dismissed), seed/migration patch, cost and time per stage (ledger), an evidence appendix |
| Publishing | `Forge.publishEvidence` replaces `pushEvidence`: the engine builds the `kitchen-evidence` commit itself (`src/forge/evidence-branch.ts`: git plumbing on a private index, one folder per job with `report.html`, `evidence/`, `published.json`, folders older than `evidence_keep_days` pruned); local and fake forges keep the branch in the repo, GitHub (W3b) pushes it. The bundle is redacted again before it is committed. Then `Forge.comment` posts the per-criterion table (screenshot links into the folder) and the report link, once per HEAD |
| done → build from PR comments | `Forge.reviewComments(pr)`; the runner reads them for done jobs; only a trusted person counts (`feedback.trusted` logins or `feedback.trust_associations`, default OWNER/MEMBER/COLLABORATOR); trusted comments become one quoted feedback file for the builder and the move `done → build` (machine fact `prComment`); untrusted ones are logged (`pr-comment-ignored`) and ignored; each comment is handled once (`filed`) |
| `kitchen toolkit maintain` | `src/toolkit/maintain.ts` + `roles/maintainer.md` (pstack's maintain-verification-skill, MIT, credited): source wave (one read-only reader per feature file, parallel, on the engine-owned checkout), live pass (the full `toolkit check` of the base), fix on `kitchen/maintain-<sha>` (Toolkit files only, the engine commits), the engine's full check of the fix commit (sandboxed: unmerged), one PR via `Forge.openPr`; outcome clean / changed / blocked in `.kitchen/maintain.json` and the ledger. `kitchen run` starts it when the feature-mapped paths changed by more than `maintain_churn_lines` (default 300) since the last maintain, once per base |
| Forge interface (merge note for W3b's `forge/github.ts`) | New: `label`, `publishEvidence`, `reviewComments` (must exclude Kitchen's own comments and give `author_association`), `openPr`. Removed: `pushEvidence`. `comment` keeps its signature (the fake forge now stores the body) |

## Changes from the Wave 4 review (spikes/w4/results.md, "Review round")

| Finding | Change |
|---|---|
| "Demonstrable" was too easy: any line at HEAD, any in-scope requirement, any manifest id | An `at:` must lie in this change: within 3 lines (`DIFF_SLACK`) of a line the job's diff vs base adds or removes (`changedLines`). A requirement-only finding blocks only with evidence, or when every criterion covering that requirement is NON-DISCRIMINATING (unproven). Evidence must be this job's (the sealed manifest) and stamped for HEAD, not a base-phase run. A blocking finding whose `at:` isn't file:line, names no tracked file or a line past the end gets one re-ask of that lens (`review-<lens>-fix.md`, with the lines the change touched) before it is kept as a note; an anchor outside the change isn't re-asked (`fixableAnchors`) |
| `VERDICT: BLOCKING` with no parsed blocking finding passed silently | The lens's file is refused once (re-run with the parse error, `review-refused` in the ledger); still unreadable → `needs-human` with escalation `review-unparseable` (machine `*>needs-human`). Never a silent PASS |
| Merging by requirement dropped distinct findings | Findings merge only on the same file and line (±1). Findings without a line are never merged: two on one requirement are two findings. A merged one keeps every member's id, lens, title and why (`members` in review.json), shown in review.md (what the builder reads) and the report |
| `kitchen dismiss` changed nothing | A dismissal records who (git `user.name`, else the OS user), why, the finding's lens and anchor. The builder's next round gets "ignore: <id> … dismissed by <who>: <reason>"; the next review's lens of that finding gets "do not re-raise: …"; a finding raised again by the same lens on the same anchor (line within 3, or the same requirement) is kept as a note, "dismissed by …" (`redismissed` in the per-lens counts) |
| The report sanitizer stripped by regex (`<a/href=…>`, `<img/src=…>`, `<div/style=…>` got through) | `sanitize` is a small tokenizer (attributes split on whitespace and `/` as a browser does, quoted or bare values, character references decoded before checking) and an allow-list: `h1`–`h4`, `p`, `br`, lists, tables, `strong`/`em`/`b`/`i`/`code`/`pre`/`blockquote`, `a` with `href="#…"` only, `section` (with `id`)/`div`/`span` with `class` only, table cells with `colspan`/`rowspan`. Every other tag goes; `script`, `style`, `svg`, `video`, `audio`, `iframe`, `object`, `template`… go with their content. Agent images are never kept: they come only through `{{e<N>}}`. Unclosed tags are closed, stray close tags dropped. `renderRefusal` judges the sanitized source, so a `human-check` hidden in a comment doesn't count |
| The report could cite any id stamped for HEAD | Ids cited outside the citable set (the verdict's rows and the views) render with a `CITATION` warning at the top of the page and a `report-citation-warning` ledger line. The review section also lists what blocked earlier rounds |
| PR comments: a comment from an earlier round, or Kitchen's own, could send a done job back; a crash between the move and the mark could replay one | Only comments written after the job entered `done` and after its HEAD commit count (older ones are logged `pr-comment-ignored`, "before done"). Every comment Kitchen posts starts with `KITCHEN_MARKER` (`<!-- kitchen:report -->`) and the runner drops those whatever the forge returns. The handled-once keys are written in the same job.json write as the move (`moveJob(…, filed)`), and the feedback file has a fixed name per comment |
| The PR comment table rendered agent text as markdown | Criterion text and the title are escaped (`mdText`: no images, links, autolinks, HTML or table breaks) |
| Evidence prune could drop a live job's folder | `publishEvidence({ …, keep })`: folders of jobs that aren't done (or rejected) are never pruned |
| `kitchen drive --view` didn't take the drive lock | A view (app reset, segments, screenshot) runs under the job's drive lock, from the review stage or by hand; the lock is re-entrant within its holder (`withJobLock`, AsyncLocalStorage) |
| `\"` in a proof value reached the Toolkit with its backslash | proof-line reads quotes as a shell does, consistent with the drive format: in `"…"` a backslash escapes `"` and `\` (`--target "a[href=\"/x\"]"`); outside quotes it escapes any character; in `'…'` it is literal, and `\"` there is refused with how to quote (`roles/_proofs.md`) |
| The maintain spike's "below threshold" check never had churn | 20 mapped lines: `maintainDue` counts them and says not due, `kitchen run` doesn't start maintain; 20 more (40 > 30): due, and it starts |
| Forge interface (merge note for W3b's `forge/github.ts`) | `publishEvidence` takes `keep` (pass it to `commitEvidence`); `reviewComments` must give each comment's creation time (`at`) and `author_association`; Kitchen's own comments may be returned (the runner drops `KITCHEN_MARKER`) but should be excluded |

## Changes from Wave 5 (spikes/w5/results.md)

| Finding | Change |
|---|---|
| A "review category" had no definition; lenses write free-text titles | `src/retro/categories.ts`: a fixed list (naming, style, tests, docs, error-handling, performance, copy, layout, a11y, types) matched on the title, then the why; `other` is never muted. Computed the same way at retro time and at review time |
| Mutes must be engine-applied | The retro writes `.kitchen/retro/state.json`; review demotes a blocking finding of a muted (lens, category) to a note with the reason (`mutedFinding`, one line in `review.ts`). `retro.mute_after` (3), `retro.never_mute` (security). `kitchen retro unmute <lens>/<category>`; re-muting needs `mute_after` new dismissals |
| Dismissal through the forge | No new Forge method: the retro reads `Forge.reviewComments` and counts a trusted person's reply that says "not useful" (or starts with 👎) and names finding ids; it becomes the same `finding-dismissed` ledger line `kitchen dismiss` writes (same key). A 👎 *reaction* can't name a finding, because Kitchen posts one comment per job, not per finding. **Seam for the runner:** `prCommentsBack` should skip such comments (`dismissedIn`), or a done job goes back to build |
| Lesson tickets as drafts | `TicketSource.draft`: GitHub, an issue **without** the source label (the label is the trust boundary), found by its key marker; prompt source, `.kitchen/retro/drafts/<n>-<slug>.md`, approved with `kitchen retro approve <n>`. At most `retro.max_tickets` (3) per retro cycle; a cycle is the jobs finished since the last retro, so the same ledger never yields tickets twice; each signal is proposed once, ever |
| What a lesson is about | Engine signals (≥ 2 jobs): the same Toolkit gap primitive, an unreliable proof chain (flaky in > 5% of its groups or ≥ 2 INCONCLUSIVE), the same escalation reason, a blocking category that wasn't dismissed. The `retro` role (read tier, cheap) writes the ticket text per signal, preferring a lint rule, then a check, then a Toolkit fix, an AGENTS.md note last; it may leave a signal out when it can't be concrete; the engine refuses a signal it didn't give and never lets it touch Kitchen's prompts |
| INCONCLUSIVE and flake per drive weren't counted | Verify writes one `proof` ledger line per proof run (criterion, drives, HEAD, result, gap). A group is (job, HEAD, criterion); it is flaky when it has a PASS and a non-PASS. Verdict-level INCONCLUSIVE (a judged one with every proof passing) is counted from verify → verify / paused moves. The bench records both per run |
| `kitchen report` | `src/ledger/measures.ts`: every §0 measure from the ledger alone (also `--json`), then the raw counts. Risk path from intake's `ACCEPT <kind> <risk>` line |
| Dashboard | `dashboard/dashboard.html` (self-contained, light/dark, polls) + `kitchen dashboard` (`src/dashboard/`): 127.0.0.1 only, GET only, Host header checked, only `/`, `/data.json` and existing jobs' `report.html` (served with a `default-src 'none'` CSP) |
| `kitchen migrate` | `kitchen.yaml` gets `version: 1` (absent = 0; a newer one is refused); migrations edit the text so comments stay; the Toolkit's template-owned files (`bin/dev`, `lib/*.mjs`) are replaced by the package's when they differ, never project files or deleted modules; diff first, `--dry-run` stops there. On a W2-generated Toolkit it brings W3b's template fixes |
| `test` proofs get no app URL (W3b open) | `up`'s url is kept per slot in the job folder (`app.json`, removed by `down`); cmd/test proofs get `KITCHEN_APP_URL` |
| Two jobs reporting at once raced on the evidence branch | `commitEvidence` under a per-repo file lock |
| npm 0.1.0 | `files` allowlist (dist/*.js, roles, skills, toolkit-template, dashboard.html, README, LICENSE); npm drops `.gitignore` files, so init writes the template's; `kitchen --help`/`--version`; `kitchen init --skill` so `/kitchen` setup can start inside Claude Code or Codex; `kitchen bench` refuses to run from the package. Publishing is by hand: `docs/RELEASE.md` |

## Changes from the Wave 5 review (spikes/w5/results.md "Review round")

| Finding | Change |
|---|---|
| M1: the dashboard spike rotted at the merge (it reused W4's scripted agent, whose round 3 became "VERDICT: BLOCKING" with no finding, so its jobs ended `review-unparseable`) | `spikes/w5/dashboard-agent.ts`: its own scripted agent (W4's script frozen at 828a05d). Every W5 spike re-run on main; screenshots go to the scratch folder unless `--update-screens` |
| M2: keyword muting silenced security-relevant code findings | A `category:` line in the findings format (`roles/_review.md`, each lens role): security, correctness, performance, naming, style, types, tests, docs, ux, ui; parsed into the finding, keywords only as the fallback (security terms first). A **security veto** for every lens (`securityVeto`, `src/retro/categories.ts`): a finding that is `security` or mentions auth, token, session, permission, ownership, inject, sql, xss, csrf, leak, secret, password, credential, "delete another" or access is never muted and its dismissals never count toward a mute. `never_mute` names lenses or categories |
| M3: `dismissedIn` took every id in the comment | `dismissalsIn`: only ids in the same sentence (of a line) as a trigger ("not useful", a sentence starting with 👎) are dismissed; the rest of the comment is returned. The runner drops a comment only when it is purely a dismissal (a thank-you aside); otherwise the rest goes to the builder as feedback. A security finding (security lens, or `category: security`) is dismissed only with an explicit reason (after "because"/"since"/"reason:" or a colon after "not useful"; `kitchen dismiss --reason`), recorded with it |
| GitHub lesson drafts deduped by a marker anyone could paste | `gh issue list --author @me`: only issues Kitchen's gh user opened |
| `migrate` inserted the version line by text, before `---`/`%YAML`, outside flow maps, and lost CRLF | The migration is placed by the parsed YAML document (value replaced in place, or the first key of the top-level map, block or flow); CRLF kept; a top level that isn't a map is refused |
| Retro only after the drain loop (a paused job keeps a runner alive for days) | Checked every tick too, one at a time beside the jobs |
| The retro read every PR's comments forever | Only done jobs of the last `retro.lookback_days` (30) |
| Measures: wall clock only; "needs-info needs-info"; quadratic list building | Agent seconds (sum of agent runs) beside wall clock, per job and path; the reason code is printed only when it differs from the stage; lists built in place |
| Dashboard: CSP in a meta tag, no X-Frame-Options; cards showed `#001` | CSP (with `frame-ancestors 'none'`) and `X-Frame-Options: DENY` as HTTP headers on every response; cards show the full job id, "last moved N ago" (server clock) and the last step (a proof with its result and drives, an agent, a move) |
| RELEASE.md: `npm version 0.1.0` on 0.1.0 fails; `git commit -am` with nothing to commit fails | First release: publish and tag only; later releases: `npm version patch`, commit, publish, tag |
| No NOTICE | `NOTICE`: pstack's MIT notice for the ported Toolkit shape and roles; zazencodes credited for ideas only (GPL, no code); in the package |
| `kitchen <cmd> --help` ran the command | It prints that command's usage and runs nothing |

## Changes from the W5 dogfooding and the W3b round-2 review (W5 follow-ups, spikes/w5/results.md "W5 follow-ups")

| Finding | Change |
|---|---|
| Slots per `KITCHEN_HOME`, ports machine-wide: a dogfood run and the benchmark handed out the same blocks | One registry per machine, `~/.kitchen-slots/slots.json` (`slotsHome()`), whatever `KITCHEN_HOME` is; only `KITCHEN_SLOTS` moves it (tests). Same lock. A block is handed out only when every port binds on 127.0.0.1 and 0.0.0.0 and no container publishes it (`docker ps --format '{{.Ports}}'`, ranges and IPv6 parsed). The bridges pass `KITCHEN_SLOTS` on |
| spec-lint deadlocked on "X stays unchanged" (5 of 6 first intakes) | intake marks a regression guard `(unchanged)`, a true negative `(negative)`; rule 7: a negative needs an absence assertion, an unchanged one a mechanical criterion (positive is fine: same output, same exit). A criterion that covers only `(unchanged)` requirements holds on the base by design: the base check runs it but doesn't count it as non-discriminating |
| A CLI bug whose base exits non-zero couldn't be reproduced (`step-failed`) | The template's `cli` primitive (and the b-cli bench Toolkit's) is ok whenever the command ran: `{exit, stdout, stderr}`; it fails only when it can't run, or when a drive pins `expect_exit`. `prove()` takes the last command step's exit as the proof's (`exit 1` in the expect), and, as for a `cmd` proof, an expect that says nothing about `exit` also requires exit 0. `kitchen migrate` carries the new `lib/terminal.mjs` to existing Toolkits |
| Gate couldn't typecheck or test a Node repo (no `node_modules` before the Toolkit's `prepare`) | `checks_prepare` in kitchen.yaml (`npm ci`): run in the worktree under the checks' sandbox (network with `checks_network`) before Gate's checks, the builder's `checks` tool and every `cmd`/`test` proof (repro, base check, Verify, `kitchen drive`), stamped like a check; cached per worktree by the command and the root lockfiles (`jobs/<id>/checks-prepared.json`). Chosen over running the Toolkit's `prepare` before Gate: a Toolkit's prepare may install into a container, not the worktree |
| Test proofs ignored the repo's test layout; the builder widened vitest's include | `src/checks/test-layout.ts` reads the runner's globs (vitest/jest config, package.json `jest`, pytest ini sections, mocharc, else the runner in `scripts.test` or `test_cmd` with its defaults). intake, spec, builder and the verifier's repro/drives prompts get "The repo's test layout" (globs and existing tests); spec-lint rule 8 refuses a `test` proof outside it (nothing when no runner is recognised); the builder policy refuses test-runner config (vitest/jest/playwright/cypress/ava config, pytest.ini, mocharc, karma, nyc) and a changed package.json `jest`; the repro may not add one either |
| Low risk with tests or config changes got no review | `code-if-diff>N` also adds the code lens when the diff adds or changes a test file or test/build config (package.json, lockfiles, tsconfig, bundler and lint config, pyproject…), like a drive diff |
| W3b round 2: the Docker guard only checked creation | Requests on existing containers (exec, archive, attach, logs, kill, stop, start, restart, rm, update, export, inspect, commit) and network connect/disconnect only for containers created through the guard: the proxy records each create's id per repo in `$KITCHEN_HOME/sandbox/docker-owned-<hash>.jsonl` and resolves the request's name through the daemon. Chosen over the `kitchen.id` label (compose containers lack it; the Toolkit writes it). Container prune and a `networkmode=host` (or insecure entitlement) build are refused. ADR 0008 |
| W3b round 2: a flake on the base was cached as a known failure for that sha | The base's own check runs a failing drive once more after a reset (`retryFailed`); passing then, it is recorded as `flaky` and not tolerated |

## Changes from the benchmark regression (spikes/regression/README.md)

| Finding | Change |
|---|---|
| intake/spec deadlocked between rule 7 (a `(negative)` needs an absence) and rule 3 (an absence needs an earlier step that creates its text): a negative about what exists today (the old heading, the old subject, the wrong total) could never be backed; 13 of ~18 misses on 5ba38c6 | Rule 3 backs a negative by (a) an earlier step that makes it (its text, or a 5+ letter word of what a writing step was given), (b) a value a step of the proof reads and saves (`--save amt` then `$amt != "8910"`; assert.ts fails an unsaved, empty, missing or failed one), or (c) the base: anything else runs on the base before the build (intake now runs the base check for low-risk inline criteria) and must be FALSE there; one that holds there, or whose proof doesn't run there, is refused with how to fix it. W3a's trivially-true negatives stay refused (they hold on the base). Lint reports every problem at once (one retry fixes them all); the rule 7 message says what backs an absence and when a requirement is `(unchanged)`. The spec, which can't edit intake.md, may re-mark one `(negative)` requirement `(unchanged)` in its own `## Requirements` (`withSpecMarks`; review and the report read the re-marked list) |
| `cli` output `{exit, stdout, stderr}` reached `json`/`rows` as the wrapper; a `cmd` proof's `contains` missed stderr | A command step's output is its stdout for `json`, `rows`, `--save`; `contains` reads stdout and stderr (a `cmd`/`test` proof too); `exit` the code |
| A repro whose contract couldn't show the bug (a step failing on the buggy base; `expect: ok`; a drive the repro role can't write) ended needs-info after a pointless second try | Lint rule 5 refuses a repro `expect: ok` alone, `read --equals`, and a step pinned to the bug's own outcome (`--expect_status 4xx`, `--expect_exit` ≠ 0); when the contract's own proof fails to reproduce on try 1, or the repro role can't write the drive it names, the contract goes back once to intake (low risk) or spec with the evidence and the role's note (`repro>intake`, `repro>spec`, `attempts.contract`) |
| A regression guard misread the current code (`json .ok` on an http step's `{status, body}`; a drive whose last output is JSON) and failed a correct build | A guard (covers only `(unchanged)` requirements) must hold on the base: intake (low risk) and spec run the base check and refuse one that fails there, with the evidence |
| A negative beside the very error the expect asserts was failed as "an error page" (three identical FAIL rounds) | An error page whose error a positive clause of the same expect names and shows is the expected outcome |
| `--argv ["add","x"]` lost its quotes; the seed users never reached the roles (`seedUsers` vs describe's `seed_users`) | Lint refuses an `argv`/`body` that looks like JSON and doesn't parse; the Toolkit block lists `seed_users`; rule 9 refuses `--as`/`username = '…'` naming a user who isn't a seed user and no earlier step made |

## Changes from the final fixes (review of the regression merge: W3b 8/10, W5 7.5/10)

| Finding | Change |
|---|---|
| H1: rule 3(b) accepted any saved value (`read --save page` then `$page not contains "Bob plan"`, `$t != "Bob plan"`), even an error page | (b) backs only `!=` on a value saved after a making step (a drive, a writing `http`); everything else goes to the base check. assert.ts applies the error-page and failed-response rule to saved vars too |
| H2: the spec could re-mark any negative `(unchanged)` and prove it with a positive check | A re-mark keeps the requirement negative (rule 7 still asks for an absence); it only lets that absence hold on the base, as a guard that must run and pass there. No re-mark on a job with a security surface (refused) |
| H3: the base check returned null once HEAD had moved (after a build, `feedback --to spec`), and the negatives and guards it was to back passed | It runs on a checkout of the base (`.worktrees/<id>.base`, as after drives); without a Toolkit it runs the `cmd`/`test` criteria; a base check that could not run refuses what it was to back |
| L1/L2: (a) matched any earlier arg (`--as bob` ⊃ "bob"); a phrase holding a made word counted, every `cli` a writer | (a) reads only making steps' args, minus who/where; a phrase holding a made word (a `cli`'s too) counts only with a positive clause of the same expect showing it |
| Control false FAILs: `json .ok` on an http wrapper; a "200-character" literal typed 230 long | An http step's `json`/`rows`/`--save` read the body (a key the body lacks reads the response), `--save v` keeps `$v_status`; lint refuses a literal whose stated length ("N-character", "exactly N", "longer than N characters") it doesn't have |
| Held-out contamination: the regression iterated on D, `_proofs.md` taught with d-discount | D is tuned; roles use generic examples; a new held-out set on a new fixture E (`e-library`), written and committed before any run, run once, never tuned on (bench/README.md) |
| §0 was judged by hand; two flake definitions | `section02()` prints PASS/FAIL per §0.2 line (bench output, results page, `kitchen report [--bench]`), the control set named; the bench's drive tally reads Verify proof lines only, as `measures.ts`; an agent adapter's infrastructure error reruns the ticket once, counted apart |
| `checks_prepare` cached: the builder could edit the installed node_modules | Gate and Verify forget the cache on entry, so `npm ci` reinstalls before anything is judged |
| A feature drive's `--expect_status 4xx` escaped the repro pin rule | Refused like a primitive's |

