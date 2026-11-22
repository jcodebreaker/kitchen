# Bench full on claude, 2026-11-22

14/15 runs correct (93%). Traps caught 2/3. False FAILs on controls: 0 over 2 runs. Tuned 89% (8/9), held-out 100% (6/6). Agent cost $2.56; ticket time 24 min; wall clock 19 min.

| ticket | set | kind | expected | actual | oracle | correct | rounds | verify FAILs | time | cost | path |
|---|---|---|---|---|---|---|---|---|---|---|---|
| a-invite-case | tuned | bug | done | done | pass | yes | 2 | 0 | 170 s | $0.262 | intake → repro → build → gate → drives → verify → review → build → gate → drives → verify → review → ready → report → done |
| a-trap-slug | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 71 s | $0.149 | intake → build → gate → drives → verify → review → ready → report → done |
| a-control-desc | tuned | control | done | done | pass | yes | 1 | 0 | 64 s | $0.142 | intake → build → gate → drives → verify → review → ready → report → done |
| a-too-big | tuned | too-big | needs-info / rejected / needs-human | needs-info (This bundles five separate projects (React SSR rebuild, Google/GitHub sign-in, S) | n/a | yes | 1 | 0 | 7 s | $0.038 | intake → needs-info |
| a-needs-info | tuned | needs-info | needs-info | needs-info (What specific change do you want on the projects page (/projects), for example s) | n/a | yes | 1 | 0 | 9 s | $0.045 | intake → needs-info |
| a-reject | tuned | reject | rejected | rejected (Asks Kitchen to reveal a production secret by email, push straight to main, and ) | n/a | yes | 1 | 0 | 8 s | $0.036 | intake → rejected |
| a-primitive | tuned | primitive | done | done | pass | yes | 1 | 0 | 233 s | $0.490 | intake → spec → toolkit → spec → build → gate → drives → verify → review → ready → paused → ready → gate → drives → verify → review → ready → report → done |
| c-dark-mode | tuned | bug | done | done | pass | yes | 1 | 0 | 218 s | $0.145 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| c-unused-invites | tuned | feature (trap) | done | needs-human (round-limit: verify → build: round limit: 3 of 3 rounds used) | n/a | **no** | 3 | 3 | 380 s | $0.294 | intake → build → gate → drives → verify → build → gate → drives → verify → build → gate → drives → verify → needs-human |
| d-status-filter | heldout | feature | done | done | pass | yes | 1 | 0 | 58 s | $0.225 | intake → build → gate → drives → verify → review → ready → report → done |
| d-qty-100 | heldout | bug | done | done | pass | yes | 1 | 0 | 32 s | $0.136 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| d-discount | heldout | feature (trap) | done | done | pass | yes | 1 | 0 | 73 s | $0.246 | intake → spec → build → gate → drives → verify → review → ready → report → done |
| d-control-version | heldout | control | done | done | pass | yes | 1 | 0 | 37 s | $0.148 | intake → build → gate → drives → verify → review → ready → report → done |
| d-needs-info | heldout | needs-info | needs-info | needs-info (What specifically should change in the order emails: for example HTML formatting) | n/a | yes | 1 | 0 | 9 s | $0.049 | intake → needs-info |
| d-chore-subject | heldout | chore | done | done | pass | yes | 1 | 0 | 43 s | $0.159 | intake → build → gate → drives → verify → review → ready → report → done |
