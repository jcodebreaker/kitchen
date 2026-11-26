# Cut the evidence ceremony

**Status.** Accepted, 2026-11-26, by the user (after an independent design review). Supersedes in part ADR 0029 (§2, carried passes), 0031 (§1 cause confidence, §2 stamp refusals and carried rows, §4's read-back requirement, §5 the second look and the verdict hash) and 0033 (§4's "never gets a second look").

## Why

Kitchen grew from about 6k to 17.6k lines in three days, and none of that growth was measured against a run. An independent design review read it against two rules: design for observed usage, with no speculative validators; and add complexity only when it demonstrably improves outcomes.

The review split what ADRs 0029, 0031 and 0033 added into two kinds:

- **Real: seen in runs.** A criterion intake dropped silently (0029 §1). A broken environment read as a broken product, so a Build round "fixed" code that was fine (0029 §2, NOT_RUN). Setup that looked like a hang (0029 §4). Apps and sessions left running (0029 §5). Findings whose guessed cause read as fact (0031 §1, `expected` apart from `seen`). Test data that skipped the action under test (0033 §1, scenarios). These stay.
- **Speculative: from reviewers imagining attacks.** No run ever showed a QA agent reusing a capture from another round or commit, rewriting its verdict after Kitchen read it, faking a carried pass, or claiming a confirmed cause it hadn't shown. The rules against those came out of review rounds, not failures, and each one then needed review rounds of its own: carried rows needed job state, then a legacy reader, then an adopter, then copies under `from-round-<n>/` with their stamps; the second look needed a lane, a stage, a role, moves, a scheduler entry, a verdict hash and a refusal path back to QA. None of it was shown to change an outcome.

The cost is real: more code to read, more refusals a lane agent must satisfy before its true result counts, more moves a person can land in. The benefit was never observed.

## Decision

1. **No carried rows.** An INCOMPLETE QA round (a criterion NOT_RUN, no FAIL) runs **all of QA again, once**, in a new round on fresh data: the QA lane's first `kitchen qa up` resets the app (`qaRetry.reset`, as before), and no Build round is counted. QA drives every criterion again; nothing from the round before stands. Still NOT_RUN after that: the job goes to a person, as before. NOT_RUN itself stays. Gone: `job.carried`, `carriedRows`, `legacyCarried`, `carryPasses`, `adoptCarried`, the `from-round-<n>/` copies and `carried.json`.
2. **No verdict hash.** `check.verdict` (the sha256 of QA's `verdict.json`) and the refusal and escalation around it are gone.
3. **No cause confidence.** A finding keeps `title`, `seen`, `expected`, `cause`, `repro`, `evidence` and `severity`; `cause` is free text. There is no suspected or confirmed, and no rule that a cause cites evidence beyond the symptom. A verdict written before this (a cause object) reads as its `text`. The Report and the Inbox proposal say **Cause**.
4. **Stamps inform, never refuse.** `kitchen qa page|http` still write `<file>.meta.json` (job, round, commit, browser, URL, time), and the Report shows it beside the capture. `readQa` never refuses a verdict because of a stamp. `· given:` is still parsed and shown, and a row's `given` evidence is shown when QA cites it; a row without one is never refused.
5. **No second look.** The second-look lane, its stage, its moves, `roles/second-look.md`, its place in the wave plan's order, the scheduler and dashboard names, `--to second-look`, `readSecondLook`, `consequential()` and the skip list are gone. A check's findings are proposed directly when its QA finishes, as before ADR 0031. **Migration:** a job stored in stage `second-look` (or needs-human or paused from it) reads as being in `qa` (escalated or paused from `qa`), with no lane open. Its next `job next` starts QA again (or Answer and Resume do, for one with a person), and that QA's findings are proposed directly. Chosen over closing it as done with the old findings proposed: a QA run costs a little, but it never proposes findings from a verdict Kitchen can no longer vouch for, and it needs no code beyond one stage name in the store's upgrade table.

## Not chosen

- **Keep the rules, turn them off by default.** Code that doesn't run still has to be read, kept and reviewed, and a switch is one more thing a person must understand.
- **Rerun only the NOT_RUN criteria, without carrying rows.** The verdict would then be missing the passed rows, or Kitchen would have to merge two verdicts: carried rows by another name. One full rerun is simpler and checks everything on the same data.
- **Close a check left in its second look as done, proposing its findings.** It saves one QA run per such job, but it needs a step in `job next` that exists only for the migration, and it proposes findings no current lane accepted.
- **Keep the second look for high-risk checks only.** Nothing showed a high-risk check's findings were wrong more often; the person still sets aside a wrong proposal in the Inbox in one click.
- **Bring a rule back on a guess.** A rule from this list comes back only with a run that shows the failure it prevents.
