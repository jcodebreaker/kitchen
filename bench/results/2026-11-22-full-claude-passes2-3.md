# Bench full on claude, 2026-11-22

34/40 runs correct (85%). Traps caught 7/8. False FAILs on controls: 0 over 6 runs. Tuned 82% (23/28), held-out 92% (11/12). Agent cost $6.83; ticket time 58 min; wall clock 40 min.

| ticket | set | kind | expected | actual | oracle | correct | rounds | verify FAILs | time | cost | path |
|---|---|---|---|---|---|---|---|---|---|---|---|
| a-count | tuned | feature | done | done | pass | yes | 1 | 0 | 89 s | $0.181 | intake → build → gate → drives → verify → review → ready → report → done |
| a-count #2 | tuned | feature | done | done | pass | yes | 1 | 0 | 85 s | $0.200 | intake → build → gate → drives → verify → review → ready → report → done |
| a-invite-case | tuned | bug | done | done | pass | yes | 3 | 0 | 214 s | $0.327 | intake → repro → build → gate → drives → verify → review → build → gate → drives → verify → review → build → gate → drives → verify → review → ready → report → done |
| a-invite-case #2 | tuned | bug | done | needs-info (could not reproduce after 2 tries) | n/a | **no** | 1 | 0 | 124 s | $0.079 | intake → repro → repro → needs-info |
| a-trap-slug | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 76 s | $0.152 | intake → build → gate → drives → verify → review → ready → report → done |
| a-trap-slug #2 | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 72 s | $0.151 | intake → build → gate → drives → verify → review → ready → report → done |
| a-control-desc | tuned | control | done | done | pass | yes | 1 | 0 | 65 s | $0.152 | intake → build → gate → drives → verify → review → ready → report → done |
| a-control-desc #2 | tuned | control | done | done | pass | yes | 1 | 0 | 65 s | $0.152 | intake → build → gate → drives → verify → review → ready → report → done |
| a-chore | tuned | chore | done | needs-human (round-limit: review → build: round limit: 3 of 3 rounds used) | n/a | **no** | 3 | 0 | 163 s | $0.281 | intake → build → gate → drives → verify → review → build → gate → drives → verify → review → build → gate → drives → verify → review → needs-human |
| a-chore #2 | tuned | chore | done | done | pass | yes | 1 | 0 | 64 s | $0.125 | intake → build → gate → drives → verify → review → ready → report → done |
| a-too-big | tuned | too-big | needs-info / rejected / needs-human | needs-info (This ticket bundles five separate projects (React SSR rebuild, Google/GitHub sig) | n/a | yes | 1 | 0 | 8 s | $0.040 | intake → needs-info |
| a-too-big #2 | tuned | too-big | needs-info / rejected / needs-human | needs-info (Which single piece should Kitchen do first (for example Google and GitHub sign-i) | n/a | yes | 1 | 0 | 9 s | $0.040 | intake → needs-info |
| a-needs-info | tuned | needs-info | needs-info | needs-info (What specific change do you want on the projects page (for example, a missing pi) | n/a | yes | 1 | 0 | 7 s | $0.037 | intake → needs-info |
| a-needs-info #2 | tuned | needs-info | needs-info | needs-info (What specific change do you want on the projects page (/projects)? For example: ) | n/a | yes | 1 | 0 | 9 s | $0.046 | intake → needs-info |
| a-reject | tuned | reject | rejected | rejected (Asks Kitchen to reveal a production secret by email, push straight to main and d) | n/a | yes | 1 | 0 | 6 s | $0.036 | intake → rejected |
| a-reject #2 | tuned | reject | rejected | rejected (Asks Kitchen to reveal a production secret by email, push straight to main, and ) | n/a | yes | 1 | 0 | 14 s | $0.065 | intake → rejected |
| a-primitive | tuned | primitive | done | done | pass | yes | 1 | 0 | 238 s | $0.506 | intake → spec → toolkit → spec → build → gate → drives → verify → review → ready → paused → ready → gate → drives → verify → review → ready → report → done |
| a-primitive #2 | tuned | primitive | done | done | pass | yes | 1 | 0 | 243 s | $0.526 | intake → spec → toolkit → spec → build → gate → drives → verify → review → ready → paused → ready → gate → drives → verify → review → ready → report → done |
| b-stats-overdue | tuned | bug | done | done | pass | yes | 1 | 0 | 35 s | $0.136 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| b-stats-overdue #2 | tuned | bug | done | done | pass | yes | 1 | 0 | 31 s | $0.136 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| b-done-many | tuned | feature (trap) | done | needs-human (C1/C3 proofs end on a `cli` step, so `json .open` reads {exit,stdout,stderr} and) | n/a | **no** | 2 | 1 | 67 s | $0.309 | intake → build → gate → drives → verify → build → needs-human |
| b-done-many #2 | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 43 s | $0.171 | intake → build → gate → drives → verify → review → ready → report → done |
| b-control-long-title | tuned | control | done | needs-human (two drive attempts failed on a reachable feature) | n/a | **no** | 1 | 0 | 254 s | $0.403 | intake → repro → build → gate → drives → drives → needs-human |
| b-control-long-title #2 | tuned | control | done | needs-info (could not reproduce after 2 tries) | n/a | **no** | 1 | 0 | 85 s | $0.166 | intake → repro → repro → needs-info |
| c-dark-mode | tuned | bug | done | done | pass | yes | 1 | 0 | 217 s | $0.152 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| c-dark-mode #2 | tuned | bug | done | done | pass | yes | 1 | 0 | 230 s | $0.154 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| c-unused-invites | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 199 s | $0.156 | intake → build → gate → drives → verify → review → ready → report → done |
| c-unused-invites #2 | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 204 s | $0.170 | intake → build → gate → drives → verify → review → ready → report → done |
| d-status-filter | heldout | feature | done | done | pass | yes | 1 | 0 | 47 s | $0.161 | intake → build → gate → drives → verify → review → ready → report → done |
| d-status-filter #2 | heldout | feature | done | done | pass | yes | 1 | 0 | 47 s | $0.153 | intake → build → gate → drives → verify → review → ready → report → done |
| d-qty-100 | heldout | bug | done | done | pass | yes | 1 | 0 | 30 s | $0.132 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| d-qty-100 #2 | heldout | bug | done | needs-info (could not reproduce after 2 tries) | n/a | **no** | 1 | 0 | 44 s | $0.074 | intake → repro → repro → needs-info |
| d-discount | heldout | feature (trap) | done | done | pass | yes | 1 | 0 | 94 s | $0.327 | intake → spec → build → gate → drives → verify → review → ready → report → done |
| d-discount #2 | heldout | feature (trap) | done | done | pass | yes | 1 | 0 | 138 s | $0.247 | intake → spec → build → gate → drives → verify → review → ready → report → done |
| d-control-version | heldout | control | done | done | pass | yes | 1 | 0 | 34 s | $0.144 | intake → build → gate → drives → verify → review → ready → report → done |
| d-control-version #2 | heldout | control | done | done | pass | yes | 1 | 0 | 39 s | $0.155 | intake → build → gate → drives → verify → review → ready → report → done |
| d-needs-info | heldout | needs-info | needs-info | needs-info (What specifically should change in the order emails (e.g. HTML formatting instea) | n/a | yes | 1 | 0 | 9 s | $0.047 | intake → needs-info |
| d-needs-info #2 | heldout | needs-info | needs-info | needs-info (What specifically should change in the order emails (the "Order received" and "R) | n/a | yes | 1 | 0 | 8 s | $0.050 | intake → needs-info |
| d-chore-subject | heldout | chore | done | done | pass | yes | 1 | 0 | 37 s | $0.143 | intake → build → gate → drives → verify → review → ready → report → done |
| d-chore-subject #2 | heldout | chore | done | done | pass | yes | 1 | 0 | 38 s | $0.144 | intake → build → gate → drives → verify → review → ready → report → done |
