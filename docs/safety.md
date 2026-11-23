# Safety model and known limitations

Kitchen lite (ADR 0016) traded the OS sandbox for speed and simplicity. This page says plainly what protects you
now and what doesn't.

## What protects you

- **Guard hooks on every tool call.** `kitchen init` installs Claude Code hooks into `.claude/settings.json`. They
  run for the orchestrator session and for every lane agent it starts (project hooks run inside subagents too):
  - `guard-secrets`: no reading or piping `.env*` files (the example files stay readable), SSH keys, `.npmrc`,
    credentials files, `.pem`.
  - `guard-key-literals`: no live-looking API key written into a file (refused before it lands, by line number,
    never echoing the value).
  - `guard-protected-push`: no `git push` that updates or deletes `main`, `master` or `staging.base`, and no
    `gh pr merge --admin`.
  - `guard-delete-outside`: no `rm`, `find -delete` or `git clean` outside the project, never `/` or your home.
  - `guard-worktree`: worktrees only under `.worktrees/`; a lane agent writes files (Edit, Write) only in its job's
    worktree and job folder, never the main checkout or another job.
  Adapted from super-board's hooks (MIT, see NOTICE).
- **Kitchen moves the jobs, not the agents.** A job changes stage only through `kitchen job` verbs, which refuse
  any move the stage table doesn't list. An agent's say-so decides nothing: Kitchen runs your checks itself after
  Build and again on staging before a merge, refuses a QA verdict whose evidence files are missing, and refuses a
  review of a branch that moved while it was reviewed.
- **Staging, never main.** Kitchen merges only into `staging.branch`, which may never be the base, `main` or
  `master` (refused in config and in code), and only the commit the review passed (`--match-head-commit` on
  GitHub). High risk, high-risk paths and big diffs stop at Ready for you.
- **No GitHub token in the session.** `kitchen run` starts the session without `GH_TOKEN`/`GITHUB_TOKEN`; Kitchen's
  own push and merge use `gh`'s stored login.
- **Ticket text and your messages are data.** They are quoted to agents, fenced, never followed as instructions to
  Kitchen.

## What doesn't

- **Hooks stop accidents, not a determined or injected agent.** Lane agents run as you, with your shell, in your
  Claude Code session. A Bash command can write anywhere you can (the write guard sees Edit and Write, not every
  shell redirect), reach the network, and run `gh` with your stored login. There is no OS sandbox and no container.
  Keep secrets out of the repo, and don't run Kitchen on a machine whose credentials you can't risk.
- **Merges into staging happen without a person.** Read the Reports before you merge staging onward.
- **Evidence is plain files.** The hash chain and signing key are gone; the evidence's integrity rests on QA running
  in its own lane and Kitchen checking the files exist. An agent that wanted to fake a screenshot could.
- **Your app runs as you** when QA starts it, with your environment, like `npm start` would.
- **Hooks need Claude Code and Python 3.** Codex can file tickets and read status, but running the queue needs Claude
  Code (its Agent tool and hooks).
- **`kitchen stop` can't kill an in-session agent.** It parks the job at once and drops the agent's result; the
  agent itself finishes its current work.
- The real-GitHub merge path is built and tested against a `gh` stand-in and a local bare repository; its first run
  on a real GitHub repository is still owed.
