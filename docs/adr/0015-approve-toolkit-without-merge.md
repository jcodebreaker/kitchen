# Approve the Toolkit locally; no merge, no commit

**Status.** Accepted, 2026-11-22, by the user. This amends ADR 0008 ("not merged = sandboxed") and ADR 0010 (where a Toolkit comes from).

**Problem.** A built Toolkit was usable only after `git merge kitchen/setup` into the base branch. A person running Kitchen locally doesn't want an unrequested commit on their `main`. They don't need git to say "I accept this code", and they may never push.

The user ran into it: a job paused for a Toolkit that was already built and proven, and the only way forward was a merge. In the user's words: "what if user dont want to push to git it want to run it locally and thats it".

## Decision

- **The trust gate is the person's approval, not a merge.**
  - `kitchen toolkit build` ends by asking `Use this Toolkit to run your app for every job? [Y/n]`. `--yes` and the `/kitchen` skill ask the same.
  - A yes writes the approval `{sha, at, by: "you"}`: outside the repo, in `$KITCHEN_HOME` (see Built).
- **Which Toolkit a job uses.**
  - Jobs use the Toolkit at the approved sha, through the existing `toolkitCheckout`. If the base branch has a newer proven Toolkit, they use that instead.
  - Jobs waiting `no-toolkit` wake on approval.
- **Sandboxing.**
  - An approved sha runs unsandboxed, as a merged one does today: a person accepted it.
  - An unapproved, unmerged sha still runs under `sandbox-exec` (ADR 0008).
  - Changing the Toolkit (`toolkit maintain`, a rebuild) produces a new sha, which needs a new approval.
- **Sharing is optional.**
  - `kitchen toolkit commit` merges or commits it into the base only when asked.
  - With the GitHub forge, the build offers a PR instead.
  - Nothing is ever pushed without the person.
- **Wording.** Every message that used to say "merge kitchen/setup" now says: "approve it (kitchen toolkit approve) — or commit it to share with your team".
- **Commands.**
  - `kitchen toolkit approve [--sha]` approves after the fact.
  - `kitchen toolkit revoke` withdraws an approval; jobs then wait again.

## Built (2026-11-22)

- `src/toolkit/trust.ts`: the approval, the record of shas that passed a full `toolkit check` (approval takes only those; the ones a build, a maintain fix or the smith offered are marked) and `toolkit.proven`, and the one trust predicate. They live in `$KITCHEN_HOME/repos/<hash of the repo's real path>/`, never in the repo (security review H1, round 2): an untrusted bin/dev runs under a profile that denies `$KITCHEN_HOME` as a whole, and may not rename the repo, any folder above it or above `$KITCHEN_HOME`, `.kitchen` or `.worktrees`, so it can't move a record aside and write its own. Records an older Kitchen kept in `.kitchen/` are moved there on first use and never read from the repo again.
- Toolkit checkouts: an untrusted sha's in the repo (`.worktrees/_toolkit@<sha>`, where its sandbox can read it); a trusted sha's in `$KITCHEN_HOME/repos/<…>/checkouts/_trusted@<sha>`, which no sandboxed run can reach, so nothing an untrusted run wrote (an ignored `node_modules/` file included) is ever run unsandboxed. A trusted checkout is used only at its sha with a clean `git status`.
- `src/toolkit/approve.ts`: `approve`, `revoke`, `commit` (one Kitchen commit of only `.kitchen/toolkit` and `.env.kitchen`, built on a private index; a PR with the GitHub forge), and where the Toolkit stands (`building`, `waiting`, `approved`, `base`, `none`) for every message.
- `src/engine/job-toolkit.ts`: a job's Toolkit is the base's, else the approved sha. A job on an approved sha follows the approval: approve a newer one and it takes it at its next step; revoke and it has none (it waits `no-toolkit` where it needs the app). A Toolkit PR's sha is left alone.
- The approved Toolkit's files are never needed in the job worktree: feature drives, `describe` and `SKILL.md` fall back to its own checkout (`.worktrees/_toolkit@<sha>`), and the template's `bin/dev` reads its own `.env.kitchen` when the source has none.
- The dashboard's Approve Toolkit is `POST /api/toolkit-approve`, which takes no fields: it approves `kitchen/setup`'s proven tip only.

**Deviations.** `kitchen toolkit commit` ships only `.kitchen/toolkit` and `.env.kitchen`, as decided; a Toolkit whose setup added dev-environment files elsewhere (its first `kitchen/setup` commit) needs those committed by the person, and until then an approved-only Toolkit can't see them in a job's tree (the setup role is now told to keep what it builds under `.kitchen/toolkit/`). Toolkits written before this change read `.env.kitchen` from the job's source only. `toolkit maintain` on a repo whose base has no Toolkit maintains the approved sha and asks for approval of the fixed one, like the build.

## Why not keep the merge
A merge mixes two separate decisions: "run this code on my machine" and "put this code in my project's history". Only the first is needed to work, and an approval records it exactly, pinned to a sha, with no side effects on the person's branch.
