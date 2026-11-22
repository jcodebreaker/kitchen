# W4 results: review, report, feedback, maintain

Run on 2026-11-22, macOS, Claude Code 2.1.330 (sonnet for strong roles, haiku for medium: verifier, reviewers, report; the maintain fixer is smith-tier, sonnet), Docker, copies of fixture A. Codex not run: its quota is out until 2026-12-21. How to rerun: `README.md`.

## Exit table

| W4 exit | Result | Evidence |
|---|---|---|
| A medium feature ticket goes to done with real agents; review lens(es) run; report renders with every id resolved and is published through the fake forge | **PASS** | `e2e.ts ui` 12/12: intake → spec → build → gate → drives → verify → review → ready → report → done, one round, risk medium, lenses code + ux + ui, 4 notes, 0 blocking; `report.html` with every id inlined, the job folder on `kitchen-evidence`, the PR comment (fake forge). `reports/ui-medium.report.html`, `reports/ui-medium.json` |
| A planted made-up id in report.src.html is refused | **PASS** | engine path: `scripted.ts` (report → report, "unknown evidence id e99999", second render passes); on both real runs, the report role's own source + `{{e999999}}` is refused, and an id stamped for an older HEAD is refused ("not stamped for the final HEAD") |
| A high-risk ticket (auth) gets code + security, `kitchen:review-required` (fake forge), report opens with "what a human must check" | **PASS** (4th ticket, see below) | `e2e.ts auth` 12/12 on "Permissions (authorization): admins see every user's projects with the owner shown; regular users still see only their own, with no owner shown": risk high, lenses code, security, ux, ui; label on PR #1 (one call); `<section id="human-check">` first, with 5 concrete checks (incl. the two NON-DISCRIMINATING criteria and where `is_admin` comes from). `reports/auth-high-risk.report.html` |
| A UI ticket gets ux + ui lenses using Verify's screenshots and one VIEW request | **PASS** | ui run: no judged criterion, so no Verify screenshot; the UI lens asked for `/projects --as bob-admin` and `/projects --as alice`, the engine ran both (e41–e46, stamped `reviewer-ui`, `view:ui`) and re-ran the lens once. Auth run: 4 views (ux 2, ui 2, one a toolkit chain toggling dark mode), 3 ran, 1 failed on a wedged browser driver (fixed after: a view retries on a fresh app once). Scripted: a VIEW line runs, the lens is re-run with the screenshot |
| A scripted reviewer finding that isn't demonstrable doesn't block; a demonstrable one sends the job back to build | **PASS** | `scripted.ts` 26/26: round 1 `server.js:258` (the theme UPDATE, high) blocks → build (round 2); "blocking" with no anchor → note ("names no line, requirement or evidence"); low confidence on the same line → note, merged into F1; round 2 `server.js:99999` → note ("past the end of the file (355 lines)") → ready. The builder's round-2 prompt carries only the blocking row |
| done → build from a trusted PR comment (fake forge); an untrusted commenter is ignored | **PASS** | `scripted.ts`: comment by `drive-by` (CONTRIBUTOR) → "ignored: not a trusted person", job stays done, `pr-comment-ignored` in the ledger; comment by `maintainer-alice` (listed in `feedback.trusted`) → done → build, round budget reset, the builder's prompt has it quoted and not the ignored one |
| `toolkit maintain` on fixture A: a stale feature file (selector changed in the app) detected and fixed in one proven PR (local forge) | **PASS** | `maintain.ts` part 1 (real): the settings reader reports `DRIFT: yes, settings.md:27 and :34 use nav-settings, now nav-preferences (server.js:92)`, the other two none; the live pass fails at `drive settings.toggle-dark`; the fixer changes only `.kitchen/toolkit/features/settings.md`; the engine's full check of the fix commit passes (sandbox-exec, unmerged); one PR in `.kitchen/local-forge.jsonl`; main untouched. Part 2 (scripted): the churn trigger, see below |
| Unit tests for pure code; npm test / typecheck / lint green | **PASS** | `npm test` 315/315 (new: `findings.test.ts`, `report-render.test.ts`, `review-report.test.ts`, two machine rows), typecheck and biome clean |

Containers: every script checks none of its own is left running.

## Runs, cost and time

| run | result | wall | cost | notes |
|---|---|---|---|---|
| `scripted.ts` | 26/26 | 69 s | $0 | scripted agent, real engine, Toolkit, Docker |
| `e2e.ts ui` | 12/12 | 132 s | $0.354 | intake $0.087 · spec $0.104 · build $0.138 · review (3 lenses + 1 re-run) $0.021 · report $0.004 |
| `e2e.ts auth` (final ticket) | 12/12 | 279 s | $0.398 | intake $0.069 · spec $0.209 · build $0.087 · review (4 lenses + 2 re-runs, 4 views) $0.029 · report $0.005 |
| auth attempt 1 (sign-in, keep the username, never the password, "still works") | needs-human at spec | – | $0.292 | intake made "a successful sign-in still works" and "never put the password back" negative requirements; the spec could not write an absence the W3a lint accepts (an absence needs an earlier step that creates the text) |
| auth attempt 2 (keep the username only) | needs-info at repro | – | $0.075 | intake rated it a **low-risk bug** ("no auth logic or session change") |
| auth attempt 3 ("Sign out of all devices") | needs-human (round limit) | – | $0.804 | build BLOCKED: a criterion read a 401 through `http`, which answers `ok:false` for any status ≥ 400; answered with `kitchen feedback --to spec` (the spec role now sees human feedback: before, only the builder did); then C3/C4 were `test` proofs that assumed the app on port 3000 and failed 3 rounds |
| `maintain.ts` (final) | 14/14 | 95 s maintain | $0.068 | 3 haiku readers $0.005–0.006 each (15–18 s, in parallel), sonnet fixer $0.052 (35 s); part 2 scripted, $0 |
| maintain runs 1–3 | 13/14, 13/14, 12/14 | | $0.255 | run 1–2: the churn trigger read the feature files with a cwd-relative pathspec (engine git runs from the gitdir: nothing listed) → fixed (`ls-tree --full-tree <sha>:…`); run 3: another session's job container on this machine counted as ours → the check ignores job-slot containers |

Total Claude spend for W4: about **$2.25** (budget $6).

## Findings (fixed in this wave)

1. **The PR comment hid the screenshots.** It listed the first six evidence ids of a criterion; a judged criterion's screenshot was the 8th. Now screenshots first (linked into the published folder), then "+N more".
2. **Commands in reports were unreadable** (`bin/dev login --id=… --src=/Users/… --out=/Users/… --as=alice`). `shortCmd` drops the engine's own flags in the report, its appendix and the report role's prompt; the role is shown only the entries worth citing (the verdict's and the views'), each with what it returned.
3. **Review screenshots** included the drives stage's check runs; a criterion's own screenshots are now preferred.
4. **A VIEW failed on a wedged browser driver** (the app Verify left running). A view now retries once on a fresh app.
5. **Human feedback to spec reached nobody.** `kitchen feedback --to spec "<text>"` wrote the text, but only the builder read feedback. The spec role now gets it (with its earlier spec).
6. **The churn trigger listed no feature file**: see maintain runs 1–2.

## Open (outside W4, found while proving it)

- `test` proofs can't reach the job's running app: no URL is handed to them, so a test that needs the app guesses (`localhost:3000`) and fails every round. Either pass the app URL to `test`/`cmd` proofs (the sandbox allows loopback) or have spec-lint refuse a `test` proof that names HTTP. W3a/W3b.
- `http` answers `ok:false` for any status ≥ 400, so no proof can assert a 401/403/404 except through a page. Either `http` returns `{status, body}` with `ok:true` for any answer (and `expect` checks the status), or the spec role is told. Toolkit contract (W3b).
- Intake's reading of a ticket: "still works as before" became a negative requirement; "keep the typed username" became a low-risk bug. Prompt tuning on the benchmark, not W4.
- The UX lens didn't ask for a view in the ui run (the UI lens did): VIEW requests are the lens's choice.
- Codex: none of W4 ran on Codex (quota until 2026-12-21).
