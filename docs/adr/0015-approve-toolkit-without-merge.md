# Approve the Toolkit locally; no merge, no commit

**Status.** Accepted, 2026-11-22, by the user. This amends ADR 0008 ("not merged = sandboxed") and ADR 0010 (where a Toolkit comes from).

**Problem.** A built Toolkit was usable only after `git merge kitchen/setup` into the base branch. A person running Kitchen locally doesn't want an unrequested commit on their `main`. They don't need git to say "I accept this code", and they may never push.

The user ran into it: a job paused for a Toolkit that was already built and proven, and the only way forward was a merge. In the user's words: "what if user dont want to push to git it want to run it locally and thats it".

## Decision

- **The trust gate is the person's approval, not a merge.**
  - `kitchen toolkit build` ends by asking `Use this Toolkit to run your app for every job? [Y/n]`. `--yes` and the `/kitchen` skill ask the same.
  - A yes writes `.kitchen/toolkit.approved` (gitignored): `{sha, at, by: "you"}`.
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

## Why not keep the merge
A merge mixes two separate decisions: "run this code on my machine" and "put this code in my project's history". Only the first is needed to work, and an approval records it exactly, pinned to a sha, with no side effects on the person's branch.
