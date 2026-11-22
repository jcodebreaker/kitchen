# Bench full on claude, 2026-11-22

Kitchen dd02b29650252cc0782be395083d7c0eaeff3364

8/10 runs correct (80%). Traps caught 3/3. False FAILs on controls: 0 over 1 runs. Tuned 83% (5/6), held-out 75% (3/4). INCONCLUSIVE 0/23 proof runs (0%), flaky 0 (0%). Agent cost $2.15; ticket time 14 min; wall clock 8 min.

| ticket | set | kind | expected | actual | oracle | correct | rounds | verify FAILs | time | cost | path |
|---|---|---|---|---|---|---|---|---|---|---|---|
| a-invite-case | tuned | bug | done | done | pass | yes | 1 | 0 | 80 s | $0.165 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| a-trap-slug | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 116 s | $0.176 | intake → build → gate → drives → verify → review → ready → report → done |
| a-chore | tuned | chore | done | done | pass | yes | 1 | 0 | 74 s | $0.143 | intake → build → gate → drives → verify → review → ready → report → done |
| a-primitive | tuned | primitive | done | needs-human (refused: spec → build: spec-lint fails: C3: `$r not contains "2026"` holds whene) | n/a | **no** (ended needs-human, expected done) | 1 | 0 | 215 s | $0.546 | intake → spec → toolkit → spec → needs-human |
| b-done-many | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 62 s | $0.199 | intake → build → gate → drives → verify → review → ready → report → done |
| b-control-long-title | tuned | control | done | done | pass | yes | 1 | 0 | 65 s | $0.160 | intake → build → gate → drives → gate → drives → verify → review → ready → report → done |
| d-status-filter | heldout | feature | done | done | pass | yes | 1 | 0 | 62 s | $0.178 | intake → build → gate → drives → verify → review → ready → report → done |
| d-qty-100 | heldout | bug | done | done | pass | yes | 1 | 0 | 37 s | $0.138 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| d-discount | heldout | feature (trap) | done | done | pass | yes | 1 | 0 | 87 s | $0.279 | intake → spec → build → gate → drives → verify → review → ready → report → done |
| d-chore-subject | heldout | chore | done | needs-human (refused: intake → build: inline criteria fail spec-lint: C1: `not contains "rece) | n/a | **no** (ended needs-human, expected done) | 1 | 0 | 35 s | $0.168 | intake → needs-human |

## Drives

Per drive, across every run: how often Verify gave INCONCLUSIVE on a criterion that ran it, and in how many jobs it flaked (on the same source tree, one run's steps all ran and another's failed).

| fixture | drive | jobs | runs | Verify rows | INCONCLUSIVE | flaky jobs |
|---|---|---|---|---|---|---|
| a-web | invites.generate-and-join | 1 | 1 | 1 | 0 (0%) | 0 (0%) |
| a-web | primitive:login | 1 | 6 | 2 | 0 (0%) | 0 (0%) |
| a-web | primitive:open | 2 | 11 | 4 | 0 (0%) | 0 (0%) |
| a-web | primitive:press | 1 | 5 | 2 | 0 (0%) | 0 (0%) |
| a-web | primitive:read | 2 | 11 | 4 | 0 (0%) | 0 (0%) |
| a-web | primitive:sql | 1 | 1 | 0 | 0 (n/a) | 0 (0%) |
| a-web | primitive:type | 1 | 5 | 2 | 0 (0%) | 0 (0%) |
| a-web | projects.try-taken | 1 | 7 | 1 | 0 (0%) | 0 (0%) |
| b-cli | primitive:cli | 1 | 18 | 4 | 0 (0%) | 0 (0%) |
| b-cli | primitive:seed | 1 | 12 | 4 | 0 (0%) | 0 (0%) |
| d-api | create-order.place | 1 | 2 | 1 | 0 (0%) | 0 (0%) |
| d-api | primitive:db_order | 1 | 2 | 1 | 0 (0%) | 0 (0%) |
| d-api | primitive:http | 3 | 27 | 9 | 0 (0%) | 1 (33%) |
| d-api | primitive:mail | 1 | 4 | 2 | 0 (0%) | 0 (0%) |
| d-api | primitive:order | 1 | 4 | 2 | 0 (0%) | 0 (0%) |
| d-api | primitive:payments | 1 | 3 | 1 | 0 (0%) | 0 (0%) |
| d-api | primitive:read | 3 | 26 | 8 | 0 (0%) | 0 (0%) |
| d-api | read-orders.list | 1 | 3 | 1 | 0 (0%) | 0 (0%) |

Oracles retried after an infrastructure error: 0.
