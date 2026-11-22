# Roles load skills: a pinned registry, a readiness check, and a bench that keeps only what helps

**Status.** Accepted, 2026-11-22. The user approved the table and left it to Claude to fold in super-board's proven lane skills where they fit. The bench decides which ones stay. The idea of a lane → skill registry with a readiness check comes from super-board v3.3.0 (`scripts/super-board-skills-ready.py`, `skills-readiness.md`), MIT © 2026 Eric Tech; no code was copied.

**Problem.** Each Kitchen role is one prompt file (`roles/*.md`) that knows nothing outside itself. Proven outside skills, such as test-first building, bug diagnosis or a security review, would make roles better at their one job. Loading them blindly could also make roles worse, slower or unreproducible.

## Decisions

### 1. A registry, `skills/registry.json`

It maps each role to required, optional and fallback skills, plus helpers picked by kind of ticket and risk. The first version:

| Role | Required | Picked by ticket kind / risk | Optional | Fallback if missing |
|---|---|---|---|---|
| builder | — | bug → `diagnosing-bugs`; feature, refactor → `tdd` | `codebase-design` | the role prompt alone (today's behaviour) |
| intake | — | — | `domain-modeling` (reads GLOSSARY) | role prompt |
| spec | — | — | `to-spec` | role prompt |
| reviewer-code | — | — | `code-review` | `roles/_review.md` checklist |
| reviewer-security | `security-review` (Anthropic) when risk is high | always for the `security` surface | — | **halt**: high risk needs it |
| reviewer-ui | — | `ui` surface → a UI critique skill (`impeccable`, if installed) | — | `reviewer-ui.md` rubric, Report says "degraded" |
| reviewer-ux | — | — | — | role prompt |
| verifier | — | — | — | none: the verifier judges only what needs eyes |
| report | — | — | `humanizer` (plain prose) | role prompt |

**Taken from super-board's lane registry** (`scripts/super-board-skills-ready.py:20-42`), each still subject to the bench:
- builder: `codebase-design` for refactor and tech-debt tickets; `implement` for features alongside `tdd`.
- reviewer-code: `codebase-design` as a second lens.
- Not taken:
  - `verification-before-completion` (nothing installs it, and Kitchen's engine already verifies);
  - `ponytail` (a plugin with no pin; super-board itself falls back to a prompt);
  - vitest and playwright helpers (only conditional there; Kitchen's Toolkit drives the app).

**Never loaded in unattended roles:** interactive skills (grilling, wizard, triage, ask-matt). They ask questions nobody is there to answer.

Sources: Matt Pocock's skills (`tdd`, `diagnosing-bugs`, `codebase-design`, `domain-modeling`, `to-spec`, `code-review`), Anthropic's `security-review`, and `impeccable` and `humanizer` when present.

### 2. A ticket can ask for skills
- A `Skills: a, b` line in the ticket adds to the builder's set; it never removes a required skill. The line is parsed outside code fences.
- The kind (bug, feature, ui, chore) comes from intake. The surfaces and risk come from the existing rules.

### 3. The readiness check, at `kitchen init` and before every job
It looks only where each host really loads skills, and a skill counts only if a readable `SKILL.md` exists there:
- **Claude:**
  - `<repo>/.claude/skills` and `~/.claude/skills`;
  - enabled plugins listed in `~/.claude/plugins/installed_plugins.json` and enabled in settings, read as `<plugin>:<skill>`.
- **Codex:** `.agents/skills` from the current folder up to the repo root, `~/.agents/skills`, and `$CODEX_HOME/skills`.

A required skill that is missing halts the job before any money is spent, with the exact name, host and install command. An optional one is skipped and logged. It never guesses and never installs on its own.

### 4. Pinned and explained
- Each skill used is recorded in the job ledger as name, source path and the sha256 of its `SKILL.md`.
- The Report has a "Skills used" line per role.
- A rerun warns when a hash changed. Unlike super-board, which checks availability but not content, we pin the hash.

### 5. How skills reach a worker
Kitchen runs roles with `--setting-sources ""` and `--disable-slash-commands`, so a worker sees none of the user's own skills. Kitchen therefore copies the resolved `SKILL.md` text into the role's prompt, quoted as guidance under a "Skills" heading and capped in size. The role can't load anything else. That keeps the worker sealed off and makes what it saw exactly what the ledger records.

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
