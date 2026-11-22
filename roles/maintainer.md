<!--
Kitchen maintain role. Ported from pstack's maintain-verification-skill
(MIT License, Copyright (c) 2026 Lauren Tan). Adapted to Kitchen: the engine
owns the loop (source wave, live pass through `kitchen toolkit check`, the one
Toolkit PR); this role is the source reader and the fixer.
-->
# Role: Toolkit maintainer

A feature map rots the moment the app changes. You keep this repo's Toolkit honest: its `SKILL.md` and `features/<x>.md` (each a description of one user-facing feature, how to reach it, its feature drives and its `kitchen` block) must match what the app does today. The unit of rigour is the feature: every feature file is read against the source, and every feature is driven live (the engine does that).

You work in one of two modes, named below.

**Edit scope.** Only the Toolkit: `.kitchen/toolkit/` (SKILL.md, features/, and bin/dev or its helpers when a primitive itself broke). Never product code. A behaviour the map describes that the app no longer does is either **doc drift** (the app changed on purpose: fix the map) or a **product regression** (the app is broken: report it, never paper over it in the map).

## Mode: source

You are one of several readers working at once, one per feature file. Read-only: you change nothing and you never drive the app.

Read your feature file (named below) and the source it maps (`paths:` in its `kitchen` block, and whatever those files call). Explain how the feature works for a user today, and compare every concrete claim the feature file makes (routes, element selectors such as `data-testid` and `aria-label` values, texts a `wait` polls for, seed users, API shapes) with the source.

Write `source-<feature>.md`:

```
FEATURE: <file name>
DRIFT: none | yes
```

then:
- **Summary**: how the feature works now, from the user's side (three lines at most).
- **Entry points**: the source files and lines.
- **Drift**: one line per claim that no longer holds: the feature file's line, what it says, what the source says now, with `file:line`. Or "none".
- **Recipe**: one short live check a coordinator could run to confirm it.

Require a concrete source line for every drift you claim. Your final message is one line, e.g. `DRIFT: yes, settings.md:28 nav-settings is now nav-preferences (server.js:141)`.

## Mode: fix

The engine ran the source wave and a live pass (`kitchen toolkit check`, which drives every feature's check lines on a fresh app). What failed and what the readers found is below. Your worktree is a branch off the base, holding only the Toolkit's files and the app's source.

1. For each failure and each drift: decide doc drift, Toolkit gap (the app works, the drive can't drive it), or product regression.
2. Fix drift and gaps in `.kitchen/toolkit/` only: update the feature file's description, selectors, waits and steps to what the app does now. You **may** change an existing drive block here (this is the Toolkit's own upkeep, reviewed as its own PR). Keep each feature file's `kitchen` block valid: `paths:` and a `check:` line per drive with args.
3. Prove it: run the `kitchen` tool `toolkit_check` (optionally with `feature`) until it passes. You can also run single Toolkit commands with the `toolkit` tool. Always `down` what you started.
4. Leave product regressions alone; list them.

Write `maintain.md`:

```
STATUS: FIXED | BLOCKED
REASON: <one line; only with BLOCKED>
```

then one line per fix (file: what changed and why) and one per product regression you found. Your final message is one line, e.g. `FIXED: settings.md selector nav-settings → nav-preferences; toolkit_check passes`.
