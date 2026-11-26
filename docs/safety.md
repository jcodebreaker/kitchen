# Safety model and known limitations

Kitchen lite (ADR 0016) traded the OS sandbox for speed and simplicity. This page says plainly what protects you
now and what doesn't.

## What protects you

- **Guard hooks on every tool call (Claude Code).** `kitchen init` installs Claude Code hooks into
  `.claude/settings.json` (Python 3, standard library). They run for every Claude lane session `kitchen run` starts
  (each starts in the repo, so the repo's hooks load, and `KITCHEN_JOB` binds it to its job), and for an in-session
  `/kitchen run` and its lane subagents (project hooks run inside subagents too). `kitchen run` brings the installed
  hook scripts up to date before it starts. They don't run for Codex lanes: see below.
  - `guard-secrets`: no reading or piping `.env*` files (the example files stay readable), SSH keys, `.npmrc`,
    credentials files, `.pem`.
  - `guard-key-literals`: no live-looking API key written into a file (refused before it lands, by line number,
    never echoing the value).
  - `guard-protected-push`: no `git push` that updates or deletes `main`, `master` or `staging.base`, and no
    `gh pr merge --admin`.
  - `guard-delete-outside`: no `rm`, `find -delete` or `git clean` outside the project, never `/` or your home.
  - `guard-worktree`: worktrees only under `.worktrees/`; a lane agent writes files (Edit, Write) only in its job's
    worktree and job folder, never the main checkout or another job. In its job folder, the files Kitchen owns
    (job.json, briefs, the checks Kitchen ran, the criteria QA was given, the capture stamps) are never its to edit
    with Edit or Write (a shell command isn't covered: see below).
    A lane whose job you removed, or whose job ended while it worked, is refused every call.
  Adapted from super-board's hooks (MIT, see NOTICE).
- **Codex lanes run in Codex's sandbox instead** (`agent.tool: codex`, ADR 0030). Each `codex exec` runs with
  `--sandbox workspace-write` in its own checkout (never `--dangerously-bypass-approvals-and-sandbox`): it writes only
  there, in its job folder and, for a Build, the git paths a commit needs (the worktree's git dir, `objects/`, and the
  `kitchen/` branch refs and their logs), never the repo's git config, hooks or other branches. The network is off,
  except for QA and the merge check, which need the app on localhost and so get the whole network. Claude Code's guard hooks don't apply here:
  the sandbox, those narrowed writable roots and Kitchen's checks at finish are what guard a Codex lane. At finish
  Kitchen refuses a lane that moved another job's branch, or rewired its worktree's git dir (`commondir`, `gitdir`,
  a new or changed `config.worktree`); Kitchen's own git in a worktree names its git dir outright. Codex running the
  queue headless is built and tested against stand-ins, not yet on a real Codex run.
- **Kitchen's own git.** Every git call Kitchen makes that touches a job worktree or a merge (finish, the merge,
  staging) runs with `core.fsmonitor=false`.
  Your repo's hooks (pre-commit, husky) still run on Kitchen's commits and merges: a Codex lane can't write
  `.git/hooks` or the git config, and a Claude lane can run any shell, so a hook it planted is no new risk.
- **Kitchen moves the jobs, not the agents.** A job changes stage only through `kitchen job` verbs, which refuse
  any move the stage table doesn't list. An agent's say-so decides nothing: Kitchen runs your checks itself after
  Build and again on the target before a merge, refuses a criteria list it can't parse, refuses a QA verdict whose
  evidence files are missing, and refuses a review of a branch that moved while it was reviewed.
- **Evidence carries where it came from.** `kitchen qa page|http` stamp each capture with the job, round, commit,
  URL, app instance and browser (`<file>.meta.json`), and the Report shows the stamp beside the capture. It is
  information for the person reading the Report, never a reason Kitchen refuses a verdict (ADR 0036).
- **Nothing left running.** Each agent session Kitchen starts runs in its own process group: when it ends, or when
  `kitchen run --stop`, `kitchen stop` or `kitchen remove` ends it, the whole group goes, with anything the agent
  started by hand. A job's app is stopped on every way out of a lane, and when the queue drains (ADR 0029).
- **init and doctor never run your app's steps unasked.** `kitchen init` and plain `kitchen doctor` never reset,
  start or stop your app. `kitchen doctor --app` starts it on a throwaway checkout, and `--reset` runs `app.reset`,
  each after a warning. Under `kitchen run`, QA lanes and the merge gate do run `app.reset` and `app.start` (below).
  A fixed port that already answers is never mistaken for your app: Kitchen leaves it alone and stops nothing there
  (ADR 0033).
- **Staging, never main.** Kitchen merges only into a job's target (`staging.branch`, or the branch a ticket named
  with `--into`), never the base, `main` or `master` (refused in config and in code), and only the commit the review
  passed (`--match-head-commit` on GitHub). High risk, high-risk paths and big diffs stop at Ready for you. With
  `staging.merge: pr`, Kitchen never merges at all: a person merges its PR on GitHub.
- **No GitHub token in a lane.** `kitchen run` starts each lane session without `GH_TOKEN`, `GITHUB_TOKEN` and similar
  tokens (`NPM_TOKEN` too); Kitchen's own push and merge use `gh`'s stored login.
- **Ticket text and your messages are data.** They are quoted to agents, fenced, never followed as instructions to
  Kitchen.
- **No browser downloads.** QA drives the Chrome or Edge you have installed, or a Playwright Chromium already on
  disk; Kitchen never fetches one (ADR 0034).

## What doesn't

- **Hooks stop accidents, not a determined or injected agent.** A Claude lane runs as you, with your shell: `claude -p`
  with Bash, Read, Edit and Write allowed and edits accepted. A Bash command can write anywhere you can (the write
  guard sees Edit and Write, not every shell redirect), reach the network, and run `gh` with your stored login.
  There is no OS sandbox and no container for Claude lanes. Keep secrets out of the repo, and don't run Kitchen on a
  machine whose credentials you can't risk.
- **Your checks and your app run unsandboxed, as you.** After Build and before every merge, Kitchen runs your checks
  on the lane's code, and QA and the merge gate start your app (`app.reset`, `app.start`) with your shell's
  environment, Claude and Codex lanes alike. The Codex sandbox limits where a lane writes, not what its code does: a
  lane can put anything in that code. If your app migrates or seeds on start, it touches whatever `DATABASE_URL`
  (or your environment) points at.
- **A lane can reach Kitchen's own state.** A Claude lane can rewrite `job.json` or other Kitchen files in its job
  folder with a Bash command, and a Codex lane can write them directly (its job folder is writable). Either can run
  `kitchen` verbs itself: `kitchen merge`, `approve`, `feedback`, `job finish`. The owned-files guard covers Edit and
  Write in Claude lanes only; the real protection is what Kitchen checks when it finishes a lane and before a merge.
- **Codex lanes can read anywhere you can.** `guard-secrets` doesn't run for them, so a Codex lane can read `.env`
  files and `~/.ssh`. Its QA and merge-check lanes get the whole network, not only localhost.
- **PR mode doesn't bind a Claude lane.** With `staging.merge: pr` Kitchen never merges, but a Claude lane can still
  `git push origin HEAD:staging`, or `gh pr merge` with your stored `gh` login. The push guard covers only `main`,
  `master`, `staging.base` and `KITCHEN_PROTECTED_BRANCHES`. Turn on branch protection on GitHub for `staging` and
  any branch you use as a target.
- **Merges into staging happen without a person** (with `staging.merge: kitchen`). Read the Reports before you merge
  staging onward.
- **Evidence is plain files.** The stamps say where a capture came from, but Kitchen doesn't check them, and a
  capture with no `.meta.json` (a file the agent made by hand) reads the same. A lane agent can write files with Bash; the evidence's integrity rests on QA running in its own lane and on Kitchen's checks
  when it reads it. An agent that wanted to fake a screenshot could.
- **An in-session agent can't be killed.** Under `kitchen run`, `kitchen stop <id>` ends the lane's session at once.
  Under `/kitchen run` in your own Claude Code session, it parks the job and drops the agent's result; the subagent
  itself finishes its current work.
- The real-GitHub merge path is built and tested against a `gh` stand-in and a local bare repository; its first run
  on a real GitHub repository is still owed.
