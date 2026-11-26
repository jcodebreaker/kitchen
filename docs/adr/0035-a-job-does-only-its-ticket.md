# A job does only its ticket

**Status.** Accepted, 2026-11-25, by the user ("yes go ahead", then "yes" to the smaller version). Amends ADR 0017 (verify map, the merge check).

## Why

A job can be sent back to Build for something its ticket never asked for. QA follows the verify map's recipes for the features a change touches, and writes a broken step as an `R-<feature>` row. Any failing row, criterion or recipe, makes QA's verdict FAIL (`roles/qa.md`, `readQa`), and the job goes back to Build. The merge check (regress) does the same with the features it drives (`finishRegress`). A known bug, or a recipe that doesn't fit the job's target branch, becomes Build work nobody asked for, and spends a round.

## Decision

1. **Only the ticket's criteria can send a job back to Build.** Recipes are advisory.
2. **A failing recipe is reported.** QA still follows the recipes and writes `R-` rows. A failing one never makes the verdict FAIL. The Report lists it under "Recipes that didn't hold (not this ticket's)", with QA's note and evidence. A job whose criteria pass goes on to Review as usual.
3. **The merge check reports in the same way.** A feature that fails on the trial merge doesn't send the job to Build. It holds the job at **Ready**: "the merge check saw <feature> fail: <note>". The person chooses with the existing controls: **Merge** or **Ask for changes**. In PR mode the PR body says so.
4. **The QA role says it plainly:** "Do only what the ticket asks. A recipe that fails is reported, never fixed."

## Not chosen

- **QA re-running each failing recipe on the job's base, to tell a known problem from a regression** (the first draft of this ADR), and **a local map per target branch**: more machinery than the problem needs. Reporting the failure and letting the person decide covers both.
- **Dropping recipes from QA:** they still show what a change may have touched.
