# Bench smoke on claude, 2026-11-22

3/3 runs correct (100%). Traps caught 1/1. False FAILs on controls: 0 over 1 runs. Tuned 100% (3/3), held-out n/a (0/0). Agent cost $0.56; ticket time 2 min; wall clock 2 min.

| ticket | set | kind | expected | actual | oracle | correct | rounds | verify FAILs | time | cost | path |
|---|---|---|---|---|---|---|---|---|---|---|---|
| b-stats-overdue | tuned | bug | done | done | pass | yes | 1 | 0 | 29 s | $0.138 | intake → repro → build → gate → drives → verify → review → ready → report → done |
| b-done-many | tuned | feature (trap) | done | done | pass | yes | 1 | 0 | 43 s | $0.182 | intake → build → gate → drives → verify → review → ready → report → done |
| b-control-long-title | tuned | control | done | done | pass | yes | 1 | 0 | 68 s | $0.235 | intake → build → gate → drives → verify → review → ready → report → done |
