# Honest findings: what was seen, what caused it, and whose evidence it is

**Status.** Accepted, 2026-11-24, by the user (order agreed on a call). Builds on ADR 0016 (QA evidence), 0022 (the inbox), 0028 (check tickets and their findings), 0029 (trust what a run reports).

## Why

A review of check runs ("make test reports more honest") found five ways a Report says more than its evidence shows:

1. **Findings overstate causes.** A finding is `{ title, seen, repro, evidence }`. QA writes its guess at the cause into `seen`, and the Report and the Inbox proposal read it as fact. Nothing separates the symptom from the cause, or a cause QA proved from one it suspects.
2. **Evidence can belong to another scenario.** `kitchen qa page|http` write plain files. A screenshot from an earlier round, another job or a tree with other commits looks the same as one from this run, and `readQa` accepts it.
3. **Acceptance scope is blurred.** One criterion often bundles a chain ("sending yes, storing it, delivering it, using it"). A PASS then proves the first link, and a FAIL doesn't say which one broke.
4. **Preconditions are assumed.** "As a member with an overdue loan, renewing is refused" passes or fails on whatever state the app happened to have. When the seed has no overdue loan, the row is a FAIL that says nothing about the product.
5. **Check findings lack an independent look.** A check's findings go straight to the Inbox as proposed bugs. A wrong high-severity finding costs a person's attention and, if run, a Build.

## Decision

1. **A finding says what was expected and how sure the cause is.** A finding gains `expected` (what should have happened) and `cause: { text, confidence: "suspected" | "confirmed", evidence? }`, plus an optional `severity: low | medium | high`.
   - A cause written as a plain string is read as `suspected`.
   - `confirmed` needs `cause.evidence`: files that exist in the QA folder, at least one beyond the finding's own evidence (which shows the symptom). Without that, `readQa` refuses: "a confirmed cause cites evidence that shows the cause … else say suspected".
   - These rules refuse only in `kitchen job finish`. The Report, the dashboard and proposing again read leniently: an unknown severity or a cause with no text is left out, and an unproven confirmed cause reads as suspected, so an older verdict still renders and proposes.
   - The Report and the Inbox proposal show **Seen**, **Expected**, and **Suspected cause** or **Confirmed cause**, each on its own. The proposal carries the cause's evidence with the symptom's. A finding written before this has none of the new fields and still renders.
2. **Every capture carries where it came from.** `kitchen qa page|http` write a sidecar `<file>.meta.json` next to each file they save: the job and round (or the verify run), the lane, the worktree's commit SHA and whether the tree was dirty, the URL with host and port, the app instance (`app.json`'s pid and start time) and a timestamp.
   - `readQa` checks the meta of every cited file that has one (rows, preconditions, findings, causes): the job and round must be this one, and the SHA the head QA drove (the job branch's head; a check's tip), when Kitchen passes it (`kitchen job finish` does).
   - A mismatch refuses the verdict with the reason: `C2 cites a capture from another commit: c2-renew.png was taken on 1a2b3c4, QA's checkout is at 5d6e7f8`, or `… from another round` / `… another job`.
   - A file the agent made by hand (no meta) is still allowed.
   - The passes a retry round carries (ADR 0029 §2) were checked in their own round, so their captures keep that round's stamps. Kitchen keeps the carried rows in job state (`carried`: the round, the round they came from, the criteria retried, the rows), not in the QA folder. `readQa` honours only those, and only when each is a PASS for a criterion the retry doesn't test again, with every file a copy under `from-round-<from>/` and any stamp from that round. Kitchen copies only files in the earlier round's QA folder, before the move; a pass it can't carry is tested again. QA again in a round folder it used (Resume) drops that round's carry and drives everything.
   - Upgrading from ADR 0029: a round with no carry in job state but a `carried.json` is read as a retry's only when the round before couldn't test something and failed nothing, and only for rows that round passed, then checked like any carry. A job still in that retry gets it in job state at its next finish; a finished one is read from the file.
   - What keeps this honest: lane agents write files with Edit/Write and Bash. The guard hook (`hooks/guard-worktree.py`) refuses Edit/Write to the job folder's Kitchen files (job.json, the steering and message files, the ticket, briefs, the checks Kitchen ran, the criteria QA was given, every `.meta.json` stamp) and, for the second look, anything in QA's folder. Bash isn't covered by the guard, so the real protection is in Kitchen's own reading: the checks on carried rows above, the stamps, and the verdict's hash (§5).
3. **One observable claim per criterion.** The intake brief says so, with a generic example: "a todo is shared, stored, delivered and shown" is four criteria. The parser can't judge this; it stays brief-only.
4. **A criterion may name its precondition.** The grammar becomes `- C1 (page): <claim> · given: <state>`; `given` stays optional. The separator is exactly ` · given: ` (a middle dot with spaces, case as written), at its last occurrence, so a claim's own `;`, `|` or "Given:" stays in the claim. A `given` is a state a page or a request can show; one only a command or a test can see makes the criterion `cmd` or `test`. Briefs, the approval question, the dashboard and the queue section show the claim with its `given`.
   - QA reads the state back through the app before checking the claim and cites that in the row's `given`: `{ "evidence": [...], "note": "..." }`.
   - Any row's `given` files, on any criterion, are files in the QA folder (the Report inlines them). A PASS or FAIL row for a criterion with a `given` must have it. For a `page` or `http` criterion, at least one of its files is a `kitchen qa` capture (it has a meta): seed or reset output alone doesn't show the state.
   - A precondition that doesn't hold is not a FAIL: QA marks the row `NOT_RUN` (ADR 0029's per-criterion rework), which skips this rule.
5. **A consequential check finding gets a second look before it is proposed.** A finding is consequential when QA marks it `severity: high`, or every finding of a check with `risk: high`.
   - A check whose QA found one goes to a new lane, **second-look** (QA → second-look → done), instead of done. A review-style agent (the reviewer's model, `roles/second-look.md`) reads each consequential finding, its evidence and its repro, in the checkout QA drove, changes nothing, and writes `rounds/<n>/second-look.json`: `{ "findings": [{ "finding": 1, "confirmed": true, "note": "…" }] }`.
   - Confirmed findings and the ones that needed no second look are proposed in the Inbox as today. A finding that didn't hold up stays in the job's Report, marked "not confirmed" with the note, and is not proposed. The result words say so: `Found 1 problem · 1 not confirmed`.
   - The lane is wired the way regress was: a stage and lane in the machine, the wave plan's ORDER (downstream first), its role file and its finish. A refused `second-look.json` is retried, three refusals go to a person, and Resume runs it again.
   - When the check goes to its second look, Kitchen keeps the sha256 of QA's `verdict.json` in job state (`check.verdict`). The second look may write in the job folder, so a verdict that changed after that is refused.
   - Only a check gets one. Starting or finishing the lane checks that the job is a check, its QA verdict is the one Kitchen accepted, reads and isn't INCOMPLETE, and a finding needs the look. If not, the job goes to a person escalated as from QA, so Answer (or `kitchen feedback <id> --to qa`) runs QA again (the agent can't fix QA's verdict). Three refused `second-look.json` files escalate from the second look, which Resume runs again. A person sends a job to `second-look` only when it escalated from there (`--to second-look` and the move table both refuse otherwise), so a feature job can never close as done through it.
   - The lane reads the check's checkout; gone, it is made again, detached at the tip QA checked. A `second-look.json` is removed whenever a QA or second-look lane starts, so answers never outlive the QA they read. A rejected check's checkout is removed.
   - The panel links each finding to its proposal by the finding's inbox item (`kitchen:<job>:check:<round>.<n>`), so a finding not confirmed has none and the others keep theirs.

## Not chosen

- **Refusing evidence with no meta:** QA's hand-made files (command output, a spec run) are real evidence; the rule is that a stamp, when present, must match.
- **Having the parser split compound criteria:** it would be guessing at the wording; ADR 0029 already keeps criteria in intake's words.
- **A failed precondition as FAIL, or as BLOCKED:** a FAIL blames the product for the environment; BLOCKED stops the whole round for one row.
- **A second look on every finding:** it doubles the cost of every check for findings that are cheap to set aside in the Inbox.
- **A second look on a job's QA:** a job's FAIL rows go back to Build and are read again by review; only a check's findings go to a person unseen.
- **Letting the second look re-run the app:** it would become a second QA. It reads what QA left, and the code, and says whether that holds up.
