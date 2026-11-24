# A target branch per ticket, and who merges

**Status.** Accepted, 2026-11-24, by the user ("yes go ahead"). Builds on ADR 0016 (staging, the trial merge), 0018 (catch-ups), 0025 (intake reads the job's base).

## Why

Kitchen has one target, `staging.branch`. Work aimed at a feature branch (a team's long-lived `feature/x`, a release branch) can't go through Kitchen, and pointing staging at another base per ticket would mix two histories in one branch. On a shared GitHub repo, Kitchen also merges its own PRs (`forge.kind: github` merges with `--match-head-commit`), where a team expects its review, CI and branch protection to decide and a person to merge.

## Decision

1. **A ticket names its target.** `kitchen ticket --into <branch>` (the dashboard's New ticket gets the same choice; the outer loop's Run uses the default). Default: `staging.branch`. The job stores `target`; a job without one (every job filed before this) targets `staging.branch`.
2. **Everything that used staging uses the job's target:** the build worktree is cut from the target's tip, intake reads the target (ADR 0025 §1), the trial merge and its checks run on the target's tip, catch-ups (ADR 0018) follow the target when it moves, and the wave plan's file overlap and merge order are per target.
3. **A target must exist and be safe.** It must exist on the remote (GitHub) or locally; Kitchen never creates it. With `merge: kitchen`, a target equal to `staging.base`, `main` or `master` is refused, as today. With `merge: pr` any branch may be a target, since a person merges.
4. **Who merges: `staging.merge`.**
   - `kitchen` (default for `forge.kind: local`, and today's behaviour): Kitchen merges a passing job into its target.
   - `pr` (default for `forge.kind: github`, set by `kitchen init`; existing kitchen.yaml files keep what they have): after the merge check passes, Kitchen pushes the job branch and opens (or updates) a PR into the target, with the Report in the body (criteria, evidence, the merge check, screenshots linked). The job waits under **Needs you** as "PR open · waiting for review"; Kitchen never merges it. When the PR merges on GitHub, the job moves to Done (merged, `mergedBy: github`); closed without merging, to Done (rejected). Kitchen sees this when it next looks (each orchestrator wave and each dashboard poll of the job, via `gh pr view`), no webhook.
   - While a PR is open and the target moves, Kitchen re-runs the merge check on the new tip; a conflict or a red caused by the target is a catch-up (no round), and the PR is updated. A red check on the job's own change sends it back to Build, as today.
5. **One merge per target at a time.** Merges (and PR updates) into the same target are serialized; different targets run in parallel.
6. **Shown once.** The job card shows its target only when it isn't the default ("→ feature/x"). The board's Done lane says "merged into <target>".

## Not chosen

- **One dynamic staging re-pointed per ticket:** mixes histories; staging stops meaning anything.
- **A `staging/<target>` branch per target:** a second branch per target to merge onward by hand; the target itself, with the merge check, does the same job.
- **PR mode without Kitchen's merge check (only the repo's CI):** two PRs can each pass CI and break the target once both land, unless the repo uses GitHub's merge queue. The check costs little and keeps "green on the merged result".

## Later

GitHub merge queue awareness (let the queue do the final merge check when the repo has one); a target per outer-loop source (a source's items go to a set branch).
