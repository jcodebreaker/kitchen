# Roles load skills: a pinned registry, a readiness check, and a bench that keeps only what helps

**Status.** Accepted, 2026-11-22. The user approved the table and left it to Claude to fold in super-board's proven lane skills where they fit. The bench decides which ones stay. The idea of a lane → skill registry with a readiness check comes from super-board v3.3.0 (`scripts/super-board-skills-ready.py`, `skills-readiness.md`), MIT © 2026 Eric Tech; no code was copied.

**Problem.** Each Kitchen role is one prompt file (`roles/*.md`) that knows nothing outside itself. Proven outside skills, such as test-first building, bug diagnosis or a security review, would make roles better at their one job. Loading them blindly could also make roles worse, slower or unreproducible.

## Decisions

### 1. A registry, `skills/registry.json`

It maps each role to required, optional and fallback skills, plus helpers picked by kind of ticket and risk. The first version:

| Role | Required | Picked by ticket kind / risk | Optional | Fallback if missing |
|---|---|---|---|---|
| builder | — | bug → `diagnosing-bugs`; feature, ui → `tdd`; chore (refactor, tech debt) → `codebase-design` | — | the role prompt alone (today's behaviour) |
| intake | — | — | `domain-modeling` (reads GLOSSARY) | role prompt |
| spec | — | — | — (`to-spec` is person-only, see below) | role prompt |
| reviewer-code | — | — | `code-review` | `roles/_review.md` checklist |
| reviewer-security | `security-review` (vendored from Anthropic, see below) when risk is high | always for the `security` surface | — | none needed: Kitchen ships it |
| reviewer-ui | — | `ui` surface → a UI critique skill (`impeccable`, if installed) | — | `reviewer-ui.md` rubric, Report says "degraded" |
| reviewer-ux | — | — | — | role prompt |
| verifier | — | — | — | none: the verifier judges only what needs eyes |
| report | — | — | `humanizer` (plain prose) | role prompt |

**Taken from super-board's lane registry** (`scripts/super-board-skills-ready.py:20-42`), each still subject to the bench:
- builder: `codebase-design` for refactor and tech-debt tickets (Kitchen's kind `chore`). `implement` was taken at first and dropped (see Changes after review).
- reviewer-code: `codebase-design` as a second lens.
- Not taken:
  - `verification-before-completion` (nothing installs it, and Kitchen's engine already verifies);
  - `ponytail` (a plugin with no pin; super-board itself falls back to a prompt);
  - vitest and playwright helpers (only conditional there; Kitchen's Toolkit drives the app).

**Never loaded in unattended roles:** interactive skills (grilling, wizard, triage, ask-matt). They ask questions nobody is there to answer.

Sources: Matt Pocock's skills (`tdd`, `diagnosing-bugs`, `codebase-design`, `domain-modeling`, `code-review`), Anthropic's `security-review` (vendored), and `impeccable` and `humanizer` when present.

`code-review` stays, but the bench must decide it: its output conflicts with the review file's `VERDICT` contract and with Kitchen's rule that style is a note, not a block.

### 2. A ticket can ask for skills
- A `Kitchen-Skills: a, b` line in the ticket adds to the builder's set as required; it never removes one. The line is parsed outside code fences. Only names the registry lists count; any other name is logged and ignored, never halted on.
- The kind (bug, feature, ui, chore) comes from intake. The surfaces and risk come from the existing rules.

### 3. The readiness check, at `kitchen init` and before every job
It looks only where each host really loads skills, and a skill counts only if a readable `SKILL.md` exists there:
- **Claude:**
  - `<repo>/.claude/skills` and `~/.claude/skills`;
  - enabled plugins listed in `~/.claude/plugins/installed_plugins.json` and enabled in settings, read as `<plugin>:<skill>`.
- **Codex:** `.agents/skills` from the current folder up to the repo root, `~/.agents/skills`, and `$CODEX_HOME/skills`.

A required skill that is missing halts the job before the role that would run next spends anything, with the exact name, host and install command. Intake always runs first (it rates the risk that decides what is required), and only roles still ahead on the job's path are checked. Answering the job after installing does not reset the round budget. An optional one is skipped and logged. It never guesses and never installs on its own.

### 4. Pinned and explained
- Each skill used is recorded in the job ledger as name, source, path, the sha256 of its `SKILL.md` bytes, and how many characters reached the prompt (`chars`, `of`, `truncated`).
- The Report has a "Skills used" line per role.
- A rerun warns when a hash or a source changed. Unlike super-board, which checks availability but not content, we pin the hash.

### 5. How skills reach a worker
Kitchen runs roles with `--setting-sources ""` and `--disable-slash-commands`, so a worker sees none of the user's own skills. Kitchen therefore copies the resolved `SKILL.md` text into the role's prompt, quoted as guidance under a "Skills" heading before the job's context, each naming its source, and capped in size. The engine's own line restating the output file and its contract ends every prompt, so third-party text never has the last word. The role can't load anything else. That keeps the worker sealed off and makes what it saw exactly what the ledger records.

### 6. Skills only guide
A skill never decides a verdict, never touches the evidence and never widens tools or permissions. Plain code decides, as now.

### 7. Bench before keeping
- Run the bench subset twice on the same tickets, with and without the registry.
- Keep a skill only if it raises the correct rate or lowers cost or rounds, within the bench's noise.
- The results go to `bench/results/`. A skill that doesn't earn its place is removed from the registry.
- This costs paid runs, roughly $10–25 per side on the subset, so it waits for the user's approval.

## Not taken from super-board
- Installing helpers with `npx skills@latest` (unpinned).
- Required skills that nothing installs.
- A readiness check that ignores content.
- Treating Claude-only installs as Codex support.

## Changes after review (2026-11-22)

An independent review of the first build found holes; these decisions replace the parts above they contradict.

- **Repo skills come only from the base commit.** The first build read `.agents/skills` from the job worktree up and followed repo symlinks, so a prompt-injected builder could plant a "skill" the reviewers would read as operator-installed, and a committed `SKILL.md` symlink could quote `~/.aws/credentials` into a prompt. Now a repo's `.claude/skills` and `.agents/skills` are read with git at the job's base commit from the main checkout, never from a working tree; a `SKILL.md` committed as a symlink is refused. The source (`repo at <sha>`) is pinned and named in the prompt. Symlinks stay fine in the user's own folders and in plugins.
- **`security-review` is vendored.** No `SKILL.md` for it exists in any install (Anthropic ships it as a slash command and a GitHub Action), so the first build halted every high-risk job. Kitchen now ships `skills/vendor/security-review/SKILL.md`, adapted from `anthropics/claude-code-security-review` at `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` (MIT, credited in `NOTICE`): no `!` command lines, no sub-task steps, output in Kitchen's review file, the false-positive exclusions kept. It is the pinned default; a user copy is used only when `kitchen.yaml` says `skills.use_installed: [security-review]`. The shipped registry never halts now; a ticket's `Kitchen-Skills:` can still require a skill that isn't there.
- **Skills resolve by their registry source.** A skill whose source is a plugin is taken from that plugin by name (`mattpocock-skills:tdd`), never by sort order; a skill two enabled plugins provide is reported ambiguous and not used.
- **An allowlist and a stricter key for tickets.** `Kitchen-Skills:` (not `Skills:`, which issue templates use for "Skills: TypeScript"), registry names only.
- **Person-only skills are never loaded.** A skill whose frontmatter says `disable-model-invocation: true` is refused automatically. That drops `implement` (and `to-spec`, which is marked the same way) from the registry; `codebase-design` now comes to the builder for chores only.
