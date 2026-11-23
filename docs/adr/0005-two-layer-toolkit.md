# The Toolkit has two layers: primitives and feature drives

> **Superseded by [ADR 0016](0016-kitchen-lite.md)** (Kitchen lite, 2026-11-22): what this records was removed. Kept as history.

Primitives (the `bin/dev` commands every job depends on: prepare, up, down, reset, doctor, describe, login, press, screenshot…) change only through the Toolkit smith, on their own pull request, proven by `toolkit check` on main; a job that needs one pins to that PR's sha until a human merges it. Feature drives (how to reach and exercise one feature) are declarative lists of primitive calls in `features/<x>.md`, written by the verifier role inside the job's own pull request, because a new feature only exists on its job branch. Feature drives cannot contain code, so a drive can't print the answer it is judged on; anything that needs code is a primitive. This narrows ADR 0002's "proven against main, never inside a job" to primitives only.
