# Bench smoke on claude, 2026-11-22

2/5 runs correct (40%). Traps caught 0/1. False FAILs on controls: 0 over 1 runs. Tuned 40% (2/5), held-out n/a (0/0). Agent cost $0.87; ticket time 7 min; wall clock 3 min.

| ticket | set | kind | expected | actual | oracle | correct | rounds | verify FAILs | time | cost | path |
|---|---|---|---|---|---|---|---|---|---|---|---|
| a-count | tuned | feature | done | done | pass | yes | 1 | 0 | 87 s | $0.182 | intake → build → gate → drives → verify → review → ready → report → done |
| a-chore | tuned | chore | done | done | pass | yes | 2 | 0 | 116 s | $0.215 | intake → build → gate → drives → verify → review → build → gate → drives → verify → review → ready → report → done |
| b-stats-overdue | tuned | bug | done | needs-info (could not reproduce after 2 tries) | n/a | **no** | 1 | 0 | 52 s | $0.076 | intake → repro → repro → needs-info |
| b-done-many | tuned | feature (trap) | done | needs-human (proofs pass argv as one string ("done 1 2"); the cli primitive hands it to `task) | n/a | **no** | 2 | 1 | 72 s | $0.315 | intake → build → gate → drives → verify → build → needs-human |
| b-control-long-title | tuned | control | done | needs-info (could not reproduce after 2 tries) | n/a | **no** | 1 | 0 | 67 s | $0.081 | intake → repro → repro → needs-info |
