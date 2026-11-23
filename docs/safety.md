# Safety model and known limitations

## Safety model

- **Agents hold no push rights and no GitHub token.** Kitchen runs them with a scrubbed environment: no `GH_TOKEN`, an empty gh config, git credential helpers off, push URLs rewritten to nothing. Kitchen itself commits, pushes and opens PRs, with your credentials, through one git helper that never trusts a worktree's own git config or hooks.
- **Agents can't write job state or evidence.** Each agent writes one file in its worktree; Kitchen copies it. The evidence manifest is hash-chained and signed with a key in `~/.kitchen` that agents can't read; an edited, dropped or rolled-back entry is refused.
- **Your app and your tests run with a scrubbed environment too**: no agent login, no git or GitHub credentials, plus only the fake values in `.env.kitchen` (made at setup; never your real `.env`). `cmd` and `test` proofs also run in a macOS sandbox: no network but localhost, your home folder unreadable except the worktree and toolchains.
- **Ticket text is data.** It is quoted to agents, never followed as instructions to Kitchen. On GitHub only a labelled issue becomes work, and only the issue's author (or listed operators) can answer its questions.
- **A human merges.** Kitchen never merges a pull request. High-risk paths are labelled `kitchen:review-required` and the Report opens with what a person must check.
- **Screenshots can't be scanned for secrets**, so a Toolkit seeds only fake data. Text evidence is redacted before it is stored.

## Known limitations (v0.1)

- **Linux runs unsandboxed.** On macOS, Toolkit code the setup agent just wrote (and any Toolkit not yet merged) and every `cmd`/`test` proof run under `sandbox-exec`, away from your SSH keys, cloud and GitHub credentials, agent logins and Kitchen's key. Linux has no sandbox yet: those run as you, and Kitchen logs `UNSANDBOXED` when they start. Review `kitchen/setup` before you merge it either way. Details: `docs/adr/0008-setup-bridge.md` in the source repository.
- **Your app and a merged Toolkit run unsandboxed.** They get no credentials through the environment, but they run as you, like `npm run dev` would. App code from a job branch is code an agent wrote; it is reviewed only after it ran.
- **Docker is guarded only for an unmerged Toolkit, on macOS.** Toolkit code not yet merged talks to Docker through Kitchen's guard: no bind mounts outside the repo and temp, no privileged or host-namespace containers, and no requests on containers it didn't create (another project's database can't be exec'd into or stopped). A merged Toolkit, and Linux, talk to Docker directly.
- **Ports are shared per machine.** Every Kitchen on the machine (each with its own `KITCHEN_HOME`) hands out slots from one registry, `~/.kitchen-slots/slots.json`, and skips ports something else listens on or a container publishes.
- **Codex parity is owed.** Every part of Kitchen was built and proven on Claude Code first. Codex runs the same roles and passed setup on three of four fixtures, but its full proof runs (end to end, review, the benchmark subset) are still to do.
- One machine, one repo per `kitchen run`. No hosted runner, no GitLab or Linear, no Windows, no mobile apps.
- The real-GitHub path (PRs, evidence branch, issue tickets) is built and tested against a `gh` stand-in; its first run on a real repository is still owed.
