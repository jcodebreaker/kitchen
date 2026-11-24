# One dashboard for every repo

**Status.** Accepted, 2026-11-23, by the user, after the clickable mock-up ("looks good"). Amends ADR 0009 (the dashboard).

## Why

Each `kitchen dashboard` serves the one repo it was started in, on its own port. A second repo can't use 7357, so it needs `--port`, and the person ends up with 7357, 7358, 7359… with no way to see which port is which repo, or that a job in another repo needs them. On 2026-11-23 the user had three open and couldn't tell them apart.

The server already keeps nothing about a repo in memory: every request reads that repo's `.kitchen/` (`snapshot(repo)`, `detail(repo, id)`, `act(repo, …)`). The repo is a single parameter fixed at start, so serving several repos means taking it from the URL instead.

## Decision

### 1. A list of repos
- `~/.kitchen/repos.json` lists the repos the dashboard shows: each with its path, and a key (the folder name, plus a short suffix when two share a name).
- `kitchen init` and `kitchen dashboard` add the current repo. `kitchen dashboard --forget` removes it. A repo whose folder or `.kitchen/` is gone is dropped when the list is read.
- `kitchen dashboard --private` (and `--port`) keep the old behaviour: one repo, its own server, not added to the list. Kitchen's own test runs use it.

### 2. One server
- `kitchen dashboard` with nothing on the port starts the server, as today, serving every repo on the list. It rereads the list on each request, so a repo added later shows up without a restart.
- When the port already has a Kitchen dashboard (`GET /kitchen.json` answers `{ kitchen: true, version }`), it adds the repo to the list, prints `already open: http://127.0.0.1:7357/#<key>` and exits. When something else holds the port, or an older Kitchen that doesn't answer, it says so and stops. It never takes another port on its own.
- The two processes don't talk to each other: the file is the only link.

### 3. Routes carry the repo
- `/r/<key>/data.json`, `/r/<key>/jobs/<id>/detail.json`, `/r/<key>/jobs/<id>/report.html`, `POST /r/<key>/api/<verb>`. A key not on the list is a 404; nothing outside a listed repo is served.
- `/repos.json` lists each repo's key, name, path and its needs-you, running and job counts, for the switcher.
- One server, one token. A POST names its repo in the path, and `act` runs on that repo only.
- The old routes (`/data.json`, …) keep working for a `--private` server.

### 4. The page (mock-up approved 2026-11-23)
- The sidebar's repo name becomes a button. Its menu lists every repo: its name, path, a "needs you" count, the running and job counts, and ⌘1–⌘9. The menu ends with how to add a repo (run `kitchen dashboard` in it) and how to remove one (`--forget`).
- The orange badge beside the repo name counts jobs in *other* repos that need you. The tab title counts all of them.
- The repo is in the address (`#<key>`), so a link opens the right board. With no hash, it opens the repo the last `kitchen dashboard` was run in.

## Not chosen
- **A port per repo, with a list page** on the side: there are still several servers to start and stop.
- **The server finding repos on its own** (scanning folders): it's slow and surprising. A repo is on the list because you ran Kitchen in it.
- **The second `kitchen dashboard` talking to the running server** (a POST to register): it needs the token, or an unauthenticated write. The file needs neither.

## Consequences
- One address, http://127.0.0.1:7357/, for everything. A job in any repo that needs you shows on whichever board you're on.
- `~/.kitchen/repos.json` is new state outside a repo. It holds only paths, and losing it only empties the switcher.
- A dashboard started by one Kitchen version serves repos initialised by another. The data it reads (`.kitchen/` job files) is the contract.

## Amendment, 2026-11-23: how it is built
- **The list** is `src/dashboard/repos.ts`: `{ repos: [{ key, path }], last }`, written to a temp file and renamed. `last` is the repo a hash-less page opens. `$KITCHEN_HOME` moves the folder (tests, trying Kitchen out). A key is the folder name with anything but `A-Za-z0-9._-` turned into `-`; on a clash, `-` and six hex characters of the path's SHA-256.
- **Adding needs `.kitchen/`.** `kitchen dashboard` in a folder without one says to run `kitchen init` (or use `--private`); `kitchen init` creates `.kitchen/` when it finishes, then adds the repo. A repo without it would only be dropped on the next read.
- **`--port n` means `--private`**, as the ADR's "(and `--port`)" says. To run a second shared dashboard beside your own (trying out a Kitchen build), `KITCHEN_DASHBOARD_PORT` moves the shared one's port.
- **`/kitchen.json` also says `private`.** A `--private` server answers it too, so a second `kitchen dashboard` can say "port 7357 already has a Kitchen dashboard for one repo (--private)" instead of adding the repo to a list nobody serves.
- **`/repos.json`** counts from each repo's `snapshot` (the page's own numbers); the page fetches it with `data.json`, at most every 3 s, and when the menu opens. Paths under the home folder show as `~/…`.
- **The page** takes `kitchen-mode` (`repos` or `one`) from a meta the server fills, like the token. Every route goes through one `BASE` (`/r/<key>` or empty). Switching bumps a generation counter so an answer for the repo you left is dropped, and resets the list, the panel, drafts and selection. In `one` mode the repo name is not a button (no chevron, no menu).
