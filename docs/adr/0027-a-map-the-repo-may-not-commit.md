# A verify map that works whether or not the repo commits it

**Status.** Accepted, 2026-11-24, by the user ("fix it all"). Builds on ADR 0017 (the verify skill and its feature map) and 0025 (intake reads the job's base).

## Why

1. **The skill's name can come from a worktree folder.** `verify-<name>` takes `package.json`'s name, else the folder's name (`src/verify/skill.ts`). When staging has no committed skill and QA passes, the skill is first written inside the job's worktree, so a repo without a package name gets `verify-007-…`.
2. **A map that can't be committed fails a tested change.** On a QA pass Kitchen runs `git add` on the map (`src/verify/admit.ts`); git refuses an ignored path, the error isn't caught, the whole finish fails and the job doesn't move.
3. **Init adopts a skill git doesn't track.** It takes any `verify-*` folder in the checkout (`src/verify/map.ts`) without checking it is committed; job worktrees, cut from staging, don't have it, and nothing warns until QA's brief says "no verify skill yet".

Underneath: a repo that ignores `.claude/` (a normal choice) can't use the map at all today.

## Decision

1. **The name is chosen once.** `kitchen init` writes `verify.skill: verify-<name>` to kitchen.yaml: an existing `verify-*` skill's name, else the repo's (package name, else the main checkout's folder). Every lane, sweep and upkeep uses that name; nothing derives it from a worktree. A kitchen.yaml without the key gets it on the next `kitchen run` (from the same rule, run in the main checkout).
2. **Where the map lives is checked, not assumed.** Init asks git (`check-ignore`, `ls-files`) about `.claude/skills/<name>/`:
   - **tracked, or trackable:** `verify.map: repo` (today): the map lives in the repo and is committed with the change that taught it.
   - **ignored:** `verify.map: local`: the map lives at `.kitchen/verify/skill/<name>/` (Kitchen's own, never committed). Kitchen copies it into each job worktree, trial merge and sweep run when the lane starts (so lanes and the skill loader see it at the usual path), reads it for intake and the merge-check drive, and writes QA's map updates back to it instead of committing them. Init says once: "This repo ignores .claude/: the verify map stays on this machine (.kitchen/verify/skill)."
   - **present but untracked and not ignored:** init warns "commit .claude/skills/<name> so jobs see it" and uses the local map until a commit has it.
   An existing install that hits an ignored path switches to `local` by itself (once, with that line), seeding the local copy from the checkout's skill.
3. **A map update never blocks a change.** If writing or committing the map fails for any reason, the tested change moves on as it would have, and the job's line and Report say "map update skipped: <reason>".

## Not chosen

- `git add -f` past the repo's ignore rules: overrides the repo's own policy.
- Asking the person to change `.gitignore`: ignoring `.claude/` is legitimate; Kitchen copes.
- Failing the finish so the person notices: the change was tested and passed; a helper file shouldn't hold it back.
