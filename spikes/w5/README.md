# W5 spikes: learning, dashboard, release, proven by running them

Asserting scripts (PASS/FAIL lines, exit 1 on any miss) for W5's exit (PLAN §7). Results: `results.md`. Default scratch is `spikes/w5/.work/` (ignored).

```sh
node spikes/w5/retro.ts [scratch]          # scripted, no model, no Docker (~20 s): the retro on a synthetic history of six jobs
node spikes/w5/ledger-copy.ts <bench out>… --to spikes/w5/w3b-ledger   # joins the W3b benchmark's per-run ledgers into one copy
node src/cli.ts report --repo spikes/w5/w3b-ledger                      # every §0 measure from that copy (saved: report-w3b.txt)
node spikes/w5/app-url.ts [scratch]        # no Docker: up's URL reaches a cmd/test proof as KITCHEN_APP_URL
node spikes/w5/dashboard.ts [scratch]      # fixture A + Docker, scripted agent (~3 min): kitchen dashboard during and after a run, screenshots
node spikes/w5/pack.ts [scratch]           # npm pack: contents, secrets scan, npx and install smoke from a temp dir
node spikes/w5/newcomer-setup.ts <dir>     # the newcomer test's kit: README.md alone, the tarball, a fresh clone of fixture B
```

| file | proves |
|---|---|
| `retro.ts` (+ `fake-retro.ts`) | `kitchen run` starts the retro after `retro.every_jobs` finished jobs; code/naming muted after 3 dismissals (2 `kitchen dismiss`, 1 trusted "not useful" PR reply through the forge; an untrusted one ignored); security never muted; review's mute check; ≤ `max_tickets` lesson drafts through the TicketSource, unlabelled, from the strongest signals; a lesson for a signal it wasn't given refused; a re-run files nothing new and starts no agent; `retro unmute`; `retro approve` |
| `ledger-copy.ts`, `w3b-ledger/` | the W3b full benchmark's 55 surviving per-run ledgers in one file (job ids prefixed by run), `proof` lines backfilled from each job's `proofs-m*.json`, the bench result lines |
| `app-url.ts` | W3b open item: `up` records the URL per slot; a sandboxed cmd proof sees it; gone after `down` |
| `dashboard.ts` | the board mid-run and after it (`screens/running-*.png`, `screens/done-*.png`, light and dark); done jobs carry verdict chips, review, report link; read-only, localhost-only, no path traversal |
| `evidence-race.ts` | six evidence commits at once all land (the race the first dashboard run hit) |
| `pack.ts` | the tarball holds only the allowlist; no secrets; `npx ./devkitchen-0.1.0.tgz --help` and an install into a temp prefix work from an empty dir |
