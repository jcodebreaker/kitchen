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
│   │   ├── git.ts             worktrees, commits, push (engine-only)
│   │   └── stages/            one handler per stage
│   ├── agents/                adapter.ts, claude.ts, codex.ts, fake.ts
│   ├── proof/
│   │   ├── drive.ts           `kitchen drive`: the only path that runs a proof and writes evidence
│   │   ├── manifest.ts        stamped evidence entries (sha, round, criterion)
│   │   └── assert.ts          expect: matchers (text, json path, exit code, row count)
│   ├── checks/                gate.ts, spec-lint.ts, risk-floor.ts, verdict.ts, report-render.ts, redact.ts
│   ├── toolkit/               contract.ts, check.ts, slots.ts (ports + ids), describe.ts
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
  evidence/manifest.jsonl + files         written only by `kitchen drive`
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
// manifestHash: string   // sha256 of evidence/manifest.jsonl after the last engine write
```

A paused job **releases its slot**. The runner checks `waitFor` on every tick and moves the job back to `pausedFrom` when the condition clears:

| waitFor | clears when |
|---|---|
| `backoff` | the backoff time has passed |
| `toolkit-pr` | the forge shows the Toolkit PR merged |
| `ci` | `gh pr checks` has finished |
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
| toolkit | drives / spec | the smith's Toolkit PR passes `toolkit check` on main plus that PR. `toolkitRef` is set to that sha, and the job goes back to `returnTo`: a job that came from `spec` returns to `spec`, one from `repro` returns to `repro`, and one from `drives` or `verify` returns to `drives`, because the drive may need rewriting |
| review | ready / build | all lenses PASS / a blocking finding the reviewer can show |
| ready | report | synced with base, CI green (`gh pr checks`), Toolkit PR (if any) merged, gate PASS. Re-verify on the synced HEAD only if base moved since verify |
| ready | paused (ci / toolkit-pr) | CI still running, or the Toolkit PR not merged yet |
| ready | build | sync conflict, red CI, or a re-check that fails |
| paused | `pausedFrom` | the `waitFor` condition clears |
| report | done | report.html rendered with every id resolved. Evidence branch pushed, PR comment posted |
| report | needs-human | rendering refused twice |
| done | build | `kitchen feedback <id>` or a review comment on the PR from a trusted person. Round count resets as for needs-human |
| * | paused (backoff) | adapter rate limit or auth failure. Retried with backoff, never → needs-human |
| * | needs-human | round limit, smith limit, or an adapter error that repeats and isn't a rate limit |
| needs-human | build / rejected | `kitchen feedback` / `kitchen reject` |

"Merged" is read from the forge; Kitchen never drives it.

### Toolkit: two layers

The Toolkit grows with the app in two different ways, because the app has two kinds of change:

| Layer | What | Who changes it | Where it lands |
|---|---|---|---|
| **Primitives** | `bin/dev` commands: prepare, up, down, reset, doctor, describe, login, press, type, read, screenshot, http, sql… | **Toolkit smith** only | Its own Toolkit PR, proven on main. Human-merged. The job uses that sha until it's merged |
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
  - read:  { target: body, attr: class }
    save: theme                     # capture a value for later steps or for expect
  - retry: { times: 2, on: fail }   # applies to the step before
```

The step names are primitive names from `describe`. The only built-in control is `wait`, `retry`, `save` and `$var`. There are no loops, branches or code. Anything that needs more is a primitive.

### Toolkit contract

Every command prints exactly one JSON line on stdout and logs to stderr. Kitchen runs the `bin/dev` of the **engine-owned Toolkit checkout at `toolkitRef`** (see below), always with `--src <worktree>`, so it is always clear which Toolkit code runs and which app code it starts.

| command | must |
|---|---|
| `prepare --src <dir>` | Make a fresh worktree runnable: install dependencies with a shared cache, copy `.env.kitchen` (fake or sandbox values only, made at setup, **never the developer's real `.env`**), build. Prints `{"status":"ok","secs":n}` |
| `up --id <id> --src <dir> --ports <p1,p2,…>` | Start from an empty data folder through migrations and seed data to a usable app on the given ports. Prints `{"status":"ready","url":…}` or `{"status":"fail","why":…}`. It must fit in the ports it's given. Snapshot-restored seed data is encouraged, so `up` takes seconds |
| `doctor --id <id>` | Read-only. Prints `{"status":"ok"\|"fail","checks":[…]}` |
| `reset --id <id>` | Put the data and drive sessions back to seed state without a full restart |
| `down --id <id>` | Stop only what that id started. Keeps the evidence |
| `describe` | Prints the capability list: primitives, features, seed users, externals, whether jobs can run in parallel. **Generated, never hand-kept** |
| drives | `<drive> --id <id> [args]`. Session state (browser, terminal, cookies) lasts until `reset` or `down`. Prints one JSON line `{"ok":bool,"out":…,"files":[…]}` |

**Externals.** `describe` lists `externals: [{name, mode: "mock"|"sandbox"}]`, for example Stripe sandbox, mail catcher or OAuth mock. Seed users are local fake credentials, never real ones. Mobile is out of scope for v0.1.

**Slots and ports.** The engine keeps a pool of `concurrency` slots for each machine, in `~/.kitchen/slots.json`, shared across repos.
- **Ports:** each slot reserves a block of 20 free ports, checked with a probe in the range 31000–32767 (below the Linux ephemeral range).
- **Stale slots:** a slot whose owner pid has died, or whose run lock is stale, is reclaimed. Its `down` runs first.
- **Recording:** the slot is recorded in `job.json` and given to `up`.

**`kitchen toolkit check [--feature x] [--src dir]`** runs:
1. `prepare` (timed)
2. `up`, then `doctor`
3. one drive per feature
4. `reset`, then the drive again
5. `down`
6. it confirms the evidence survived, and that 2 slots can be up at once, unless `describe` says `parallel:false`, in which case concurrency for that project drops to 1

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
- [C2] Toggle persists across reload
  proof: toolkit settings.toggle-dark --as alice ; toolkit reload ; toolkit read body.class
  expect: contains "dark"
- [C3] Theme reducer unit-tested
  proof: test src/theme.test.ts
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

### Proofs: `kitchen drive` and Verdicts

`kitchen drive <job> <criterion> [--repro]` is the **only** way a proof runs:
1. Reads the proof lines.
2. Runs them through the Toolkit, or as a command or test, in the job's slot.
3. Writes the files to `evidence/`.
4. Adds manifest entries stamped `{id, sha, round, criterion, cmd, exit, at}`.
5. Applies `expect:`.

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
- After each `kitchen drive` write, the engine records `manifestHash` in `job.json`. `verdict.ts` refuses a manifest whose hash doesn't match.
- Every mechanical proof runs before any verifier agent starts.
- Changes made through `--args` are logged against the spec and listed in the Report.

**Isolation.** The builder self-checks in its slot. Before Verify, the engine runs `down` and then a fresh `up` (snapshot restore), so the builder's leftover state never reaches the proof.

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
             timeoutSec: number; maxTurns: number }): Promise<{
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
- Agents are spawned with a scrubbed environment: no `GH_TOKEN` or `GITHUB_TOKEN`, an empty `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL` pointing at a file with `credential.helper=` empty, and `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` (macOS's system git config turns on the keychain helper), `SSH_AUTH_SOCK` unset, and `GIT_SSH_COMMAND=false`, so SSH remotes can't push either.
- **Agents can't write job state.** An agent's writable root is its worktree only. It writes its one file at `.kitchen-out/<file>` inside the worktree (read-tier roles that run before a worktree exists, such as intake, get a scratch folder the engine creates for that run), and the engine copies it into `.kitchen/jobs/<id>/`, then deletes it. `.kitchen/jobs/` (with `job.json` and the manifest) is outside every agent's writable root. The manifest hash is a second check behind that.
- The engine commits what the builder leaves, pushes, and opens or updates the PR, using its own credentials.
- A wall-clock limit and a turn limit per role are structure, not a cost cap.

**UX and UI lenses** don't drive the app themselves:
- They get Verify's stamped screenshots.
- They may ask for more views (for example a page at 390 px) by adding a line to their review file, `VIEW: <feature drive or page> --width 390`. The engine runs those through `kitchen drive --view`, they land as stamped evidence, and the lens is re-run once with the new evidence.

**W0 confirms the exact flags:**
- for claude: `-p`, json output, model, allowed tools or permission mode, max turns, resume
- for codex: `exec`, json, model, sandbox
- that Docker and the CLI work from inside a Codex sandbox session

**Fallback** if Codex can't reach Docker inside its sandbox: the Toolkit runs outside it, started by the engine (which is not sandboxed). The Codex agent only calls `kitchen drive`, which goes through the engine. The result is recorded in an ADR.

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
  low:    { spec: inline, verify: short, review: [code-if-diff>150] }   # any drive diff forces the code lens
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

**Held-out set: 6 tickets,** replayed from real merged superchat-lite PRs, with their parent commit as the base. Role prompts are never tuned on it. A replay passes when:
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
