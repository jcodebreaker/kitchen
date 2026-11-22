# W4 spikes: review, report, feedback, maintain, proven by running them

Asserting scripts that drive the real `kitchen` CLI (`node src/cli.ts … --repo <dir>`) against a **copy of fixture A** (`fixtures/a-web`, its real Toolkit, Docker and Postgres), built with W3a's helpers (`spikes/w3a/lib.ts`). Each prints `PASS`/`FAIL` lines and exits 1 on any miss. Results: `results.md`.

```sh
node spikes/w4/scripted.ts <scratch>      # scripted agent, no model (~1–2 min): the whole W4 engine path on one job
node spikes/w4/e2e.ts ui <scratch>        # REAL agents (sonnet strong, haiku medium): a medium UI ticket to done, lenses code+ux+ui, VIEW requests
node spikes/w4/e2e.ts auth <scratch>      # REAL agents: a high-risk sign-in ticket: code+security, kitchen:review-required, "what a human must check"
node spikes/w4/maintain.ts <scratch>      # REAL agents (part 1) + scripted (part 2): kitchen toolkit maintain on a stale feature file; the churn trigger
```

Default scratch is `spikes/w4/.work/` (ignored). `W3A_VERBOSE=1` prints every CLI line. Claude runs `/opt/homebrew/bin/claude` unless `KITCHEN_CLAUDE_BIN` is set. Every job runs on the **fake forge** (`forge: { kind: fake }`: PRs, CI, labels, comments and review comments in `.kitchen/fake-forge.json`); the evidence branch is real (`kitchen-evidence` in the copy's own repo). Maintain uses the local forge (its PR is recorded in `.kitchen/local-forge.jsonl`).

## scripted.ts (`fake-agent.ts`)

W3a's honest scripted roles on the planted dark-mode bug (intake → spec → repro → build → gate → drives → verify), with W4's roles scripted on top:

| role | does | must happen |
|---|---|---|
| reviewer-code r1 | a blocking finding at the theme UPDATE's line (high), a "blocking" one with no anchor, a low-confidence one on the same line | only the first blocks → build (a round); the second is a note ("names no line…"), the third merges into the first |
| builder r2 | — | its prompt carries the blocking finding, not the notes |
| reviewer-code r2 | a "blocking" finding at `server.js:99999`, a note | not demonstrable → note; review PASS → ready |
| reviewer-ux | first pass `VIEW: /settings --as alice`; second pass a note on R2 citing the view's screenshot | the engine runs the view (stamped `reviewer-ux`, `view:ux`), re-runs the lens once |
| reviewer-ui | a note on R2 citing a Verify screenshot | merged with ux's (same requirement) |
| report | attempt 1 plants `{{e99999}}` plus a `<script>` and `onclick`; attempt 2 cites listed ids | attempt 1 refused (report → report); report.html self-contained, script stripped; evidence on `kitchen-evidence`; PR comment with the per-criterion table |
| (spike) | `kitchen dismiss`, an untrusted then a trusted PR review comment, `kitchen drive --view` | dismissal in ledger per lens; untrusted ignored; trusted → done → build with the comment quoted for the builder; the view runs by hand |

## e2e.ts

Real agents end to end, through ready (fake forge CI green) and report to done. `ui`: no judged criterion, so Verify takes no screenshot and the UX/UI lenses must ask for views. `auth`: intake should rate a sign-in change high (`human: always`). Both check the report renders with every id resolved, that the report role's own `report.src.html` plus a planted id is refused, and write `<scratch>/w4-<kind>.json` (path, cost and time per stage, findings, views, forge state) plus a copy of `report.html`.

## maintain.ts (`maintain-fake.ts`)

Part 1 (real): the copy's app renames `data-testid="nav-settings"` to `nav-preferences`; `kitchen toolkit maintain` must find the drift in the source wave, fail the live pass on `settings.toggle-dark`, fix only `.kitchen/toolkit/`, pass the engine's full check on the fix commit (sandboxed, unmerged) and open one PR. Part 2 (scripted, no model): after the PR is merged, `kitchen run` starts maintain by itself when the feature-mapped paths churned past `maintain_churn_lines`, once per base.
