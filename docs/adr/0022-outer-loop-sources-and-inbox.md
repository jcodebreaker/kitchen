# The outer loop: sources you set up by talking, an inbox you choose from

**Status.** Accepted, 2026-11-24, by the user ("looks good to me"), after a clickable mock-up and two rounds of changes. Builds on ADR 0016 (the queue), 0017 (the verify map), 0019 (one dashboard), 0020 (refine). The framing comes from Lauren Tan (poteto) in her interview with Matt Pocock: the inner loop is agents turning a snapshot of intent into code; the outer loop is everything outside the code (Slack, issues, bug reports, findings) that decides what to point the factory at, and without a bridge the person is the "meat proxy" carrying that context in. Her triage reads reports together, reproduces them with the verification skills, and checks they still exist on main. super-board keeps the human gate: nothing a machine finds is built until a person chooses it.

## Why

Today the outer loop is you: you read Slack and issues and type `kitchen ticket`. What Kitchen itself notices (QA notes outside a job's criteria, review notes that didn't block, sweep and maintain failures) stays in job folders and never becomes work. And there is no place to collect reports, see which are the same problem, and choose what runs.

## Decision

### 1. Two loops; your own tickets skip the outer one
- **Inner loop:** the queue Kitchen works today (intake → build → QA → review → merge check → staging).
- **Outer loop:** what might be built: items from sources, triaged into proposed tickets you choose from.
- `kitchen ticket` and the dashboard's New ticket go straight to the inner loop, as today. The outer loop is extra, never a required step.

### 2. Sources are set up by talking to Claude Code
- `/kitchen sources` in Claude Code (or Codex): you say what to watch ("GitHub issues labelled bug", "the #bugs Slack channel", "new Sentry errors"). The session uses the tools you already have there (`gh`, the Slack, Sentry or Linear connectors); Kitchen ships no integrations.
- It reads a few items as a test, shows them to you, and on your yes saves the source as a recipe: `.kitchen/sources/<name>.md`, plain words: where to read, how to tell what's new since last time, what to skip, which tool. You edit it by hand or by asking.
- A source records when it last collected and what it last saw (`.kitchen/sources/<name>.state.json`), so a collect never adds the same item twice.
- **Kitchen's own findings** are a built-in source with no setup: lanes add them as they finish (QA notes outside the criteria, non-blocking review findings, failed sweep or maintain recipes).

### 3. Collect: one session reads every source, then triages
- **Collect** (the outer loop's button, `kitchen collect`, or a schedule: Claude Code's scheduler or cron running `kitchen collect --detach`) starts one Claude session that:
  1. reads each source by its recipe and adds new items to the inbox (`kitchen inbox add`, raw text, link, source, when);
  2. triages all new items together: groups items with the same cause; reproduces each candidate on current `staging` with the verify map and `kitchen qa`; gives each a verdict: **propose** (a ticket: title, text intake will read, the items it covers, repro steps and evidence, kind, priority P1–P3 with a one-line reason), **duplicate** (of an item or a job), **fixed** (doesn't reproduce on staging), **not ours** (the user's setup, data, or an outside service), **unclear** (refine with you, ADR 0020).
- It never builds, merges, closes an issue or posts to a source. A wrong verdict costs one click.
- Verdicts are written through `kitchen inbox` verbs (single writer), with the evidence in the item's folder.

### 4. You choose what runs
The dashboard's outer loop lists **Proposed** (with a checkbox), **Held**, **In the Inner loop** (what you sent, with its job and current step) and **Set aside** (collapsed, each with its verdict and reason, and Propose anyway). For a proposed ticket: **Run** (this one, or selected ones: they become jobs at intake, in priority order), **Hold**, **Edit**, **Remove** (with Undo). Unclear ones show Refine with you. Nothing reaches the inner loop without your click.

### 5. One place for each thing
- The sidebar is the navigation: **Outer loop** (Inbox, Held, then each source with its last collect and new count, then "Add a source…" which says to run `/kitchen sources`), **Inner loop** (Needs you, Running, Done), Repos. No toolbar switch duplicating it.
- After Run, the sidebar's Running badge bumps and a banner ("2 sent to the Inner loop · 004, 005 at Intake · Show in Inner loop") stays until closed.
- A job that came from the outer loop shows its source ("from GitHub #17"), which links back to its item. When it merges and the source is a GitHub issue, Kitchen comments on the issue with the merge.

### 6. Storage and verbs
`.kitchen/inbox/<id>/item.json` (+ attachments, triage evidence), `.kitchen/inbox/proposals/<id>.json`, `.kitchen/sources/<name>.md` and `.state.json`. Verbs: `kitchen inbox add|list|propose|verdict|hold|remove|run`, `kitchen collect`, `kitchen sources list`. The dashboard calls the same functions.

## Not chosen
- **Every report straight into the queue:** builds duplicates and noise, and spends money before anyone looked.
- **One triage agent per report:** loses the thread between related reports (thirty slow-page reports are one fix).
- **Kitchen-built integrations (a Slack app, a GitHub webhook):** the user's Claude Code already reaches those tools; a recipe in plain words is enough and easy to change.
- **A paste box in the outer loop:** your own words are a ticket; New ticket is the one place to write one.
- **A toolbar switch between the loops:** the sidebar already does it.

## Later (own ADRs)
A gardening buffer (scans append to a document; a collect reads it every few days and proposes one root-cause ticket); auto-run rules (a reproduced low-risk bug runs without a click); a daily "what landed on staging" digest with a sample to read.
