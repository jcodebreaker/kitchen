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

## Amendment, 2026-11-24: GitHub and Slack first, read by Kitchen's code

After researching how tools take in work (notes: GitHub's REST `since` + ETag polling, Slack's 2025 limits for unlisted apps, super-board's scheduled intake), the user chose GitHub and Slack as the only sources for now, read by code rather than by an agent:
- `/kitchen sources` still sets them up by talking, but writes a config, not a recipe: `github: { repo, label: kitchen }` (issues with the label, via `gh api` with `since` and the saved ETag: a 304 costs nothing) and `slack: { channel, emoji: kitchen }` (threads in the channel that carry the emoji, via `conversations.history`/`replies` with an `oldest` watermark). Kitchen's code reads them: no tokens spent, deterministic, testable.
- Slack: each user creates their own internal app from a manifest Kitchen ships (internal apps keep the normal rate limits; an unlisted distributed app is held to 1 request a minute since 2025-05-29). The bot token is stored where `gh` keeps its own (the OS keychain), never in the repo.
- Every item is keyed `source:native_id` (`github:<repo>#<number>`, `slack:<channel>:<ts>`); each source keeps a watermark, refetched with a small overlap; a content hash makes an edited item a new sighting, not a duplicate. One collect at a time (a lock per repo; a busy collect exits without writing). A source that can't be reached is reported "unavailable", never "empty", and its watermark doesn't move after a partial read.
- Scheduling: `kitchen collect` by hand, from the dashboard, or on a schedule (`kitchen collect --install-schedule` writes a launchd `StartCalendarInterval` job on macOS or a systemd timer with `Persistent=true` on Linux, so a run missed while asleep happens on wake).
- Agent-read recipes for other sources (Linear, Sentry, email), and instant triggers (a Slack Socket Mode listener for the emoji, a GitHub Action on the label), are later decisions.

## Amendment, 2026-11-24: how it is built

- **Storage and the single writer.** `src/inbox/store.ts` owns `.kitchen/inbox/` (items `i-<n>/item.json` with triage evidence beside them, `proposals/p<n>.json`), every verb under one inbox lock; the CLI (`kitchen inbox list|add|propose|verdict|hold|bring-back|remove|edit|run`) and the dashboard's POSTs call the same functions. Remove keeps the proposal (state `removed`, its items stay covered); `bring-back` is its Undo. `run` files jobs through `fileTicket` (the `kitchen ticket` path) in priority order, with the proposal's title and a `from` on the job: the first item's source, native ref and link, the label the dashboard shows ("GitHub #17", "2 reports"), the proposal and every item's ref. The ticket intake reads is the proposal's text, triage's repro steps and the reports, quoted.
- **Sources** (`src/sources/`): `config.ts` reads `.kitchen/sources/<name>.json` and keeps `<name>.state.json` (watermark, ETag and the request it belongs to, last collect, new count, available/unavailable and why). `github.ts` pages `gh api -i repos/{repo}/issues?labels=…&state=open&sort=updated&direction=asc&since=<watermark − 5 min>`, the ETag on the first page (a steady state costs a 304), PRs skipped. `slack.ts` calls `conversations.history` from the watermark less two days (a late emoji is still seen; the first read goes back 14 days), keeps messages carrying the emoji (skin tones too), reads each thread with `conversations.replies`, names people through `users.info`, and links back with the workspace URL from `auth.test`; the hash covers the report's own words, so a thread reply is not a new sighting. `secret.ts` reads the bot token from the keychain (`security` on macOS, `secret-tool` on Linux); `KITCHEN_SLACK_TOKEN` wins when set (machines without a keychain, and tests, which never touch the real one). `slack-app-manifest.json` ships at the package root; `kitchen sources add slack` prints the setup and `kitchen sources slack-token` stores the token without echoing it. `kitchen sources try …` reads a few items and saves nothing: the `/kitchen sources` conversation's test read.
- **Collect** (`src/inbox/collect.ts`): the collect lock (`.kitchen/collect.lock`, taken without waiting: busy exits 4 untouched), each source read whole or marked unavailable with its state and the inbox left as they were, then triage on every untriaged item. Progress lives in `.kitchen/inbox/collect.json` while it runs (pid-checked), so the dashboard shows a collect it didn't start. `--detach` is what the dashboard's Collect and the schedule run (log `.kitchen/collect.log`). `src/inbox/schedule.ts` writes a launchd agent (`StartCalendarInterval`, the installing shell's PATH) or a systemd user service and timer (`Persistent=true`); `--every` takes divisors of an hour or a day.
- **Triage** (`src/inbox/triage.ts`, `roles/triage.md`): one headless session, started like `kitchen run`'s (the same binary or `agent.command`, the scrubbed environment, `agent.max_usd`, tools allowed up front: Bash, Read, Glob, Grep, Skill, TodoWrite, no edits, no agents), on the intake lane's model. Before it starts Kitchen checks staging out as a `triage-<stamp>` run under `.kitchen/verify/` (the run id `kitchen qa` already takes), so the session reproduces with `kitchen qa up|page|http <run>`; the brief quotes the items, lists the proposals and jobs (for duplicates) and carries the verify map. The stream drives the Collect button's words ("Reproducing on staging" on a `kitchen qa` call, "Writing verdicts" on `kitchen inbox propose|verdict`) and its cost goes to the ledger. With Codex as the tool, triage is skipped and the items wait.
- **Kitchen findings** (`src/inbox/findings.ts`): QA's new optional `notes` in verdict.json, a passing review's non-blocking findings, and the FAIL rows of a sweep or map upkeep become items keyed `kitchen:<job or run>:<lane>:<round.n | feature>` when the lane finishes; adding them never stops a job.
- **The merge comment** (`src/inbox/comment.ts`): after a job with GitHub refs merges, `gh issue comment <n> --repo <owner/repo>` with the sha and the Report's path, once per merge (the job's `filed` keys), best effort.
- **Dashboard.** `GET /inbox.json` (and `/inbox/<item>/evidence/<file>` for triage's screenshots: the page's CSP now allows `img-src 'self'`), `POST collect|inbox-run|inbox-hold|inbox-unhold|inbox-remove|inbox-edit|inbox-verdict`; `inbox-run` wakes the orchestrator like `ticket`. The page is the approved mock-up's patch set applied to `dashboard.html` with its frozen data replaced by those routes: the page polls `/inbox.json` (faster while a collect runs) and repaints only on change and never under an edit; Remove is held five seconds for its Undo before it is sent, like Reject. Job cards carry `from`; the panel's first activity line says "Filed from the Outer loop · …" or "Filed by you (New ticket)". The page opens on the loop you last looked at (Inner loop the first time; `?outer` opens the other).
- **Changed from the decision above:** sources are a config, not a recipe (the amendment); an unclear proposal is refined with `/kitchen refine p<n>` in Claude Code, which ends with `kitchen inbox edit` and `kitchen inbox verdict <p> propose`.
