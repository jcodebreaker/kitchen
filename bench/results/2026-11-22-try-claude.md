# Bench smoke on claude, 2026-11-22

0/1 runs correct (0%). Traps caught 0/0. False FAILs on controls: 0 over 1 runs. Tuned 0% (0/1), held-out n/a (0/0). Agent cost $0.17; ticket time 1 min; wall clock 1 min.

| ticket | set | kind | expected | actual | oracle | correct | rounds | verify FAILs | time | cost | path |
|---|---|---|---|---|---|---|---|---|---|---|---|
| b-control-long-title | tuned | control | done | needs-human (C1's proof uses the same over-length title for both adds, so the "200 characters) | n/a | **no** | 1 | 0 | 41 s | $0.175 | intake → build → needs-human |
