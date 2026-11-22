# Toolkit template (contract v1)

`kitchen init` copies this folder (all of it except this file) into a repo's
`.kitchen/toolkit/` on the setup branch; the setup role then fills in `app.mjs`,
`SKILL.md` and `features/` for that repo. The contract is in Kitchen's
`docs/PLAN.md` §2 ("Toolkit contract") and `src/toolkit/contract.ts`, which
`kitchen toolkit check` enforces.

| file | whose | what |
|---|---|---|
| `bin/dev` | generic | command dispatch, flags (`--k=v`/`--k v`, a flag given twice refused), ids, per-id state, the one JSON line, `describe` generated from `app.mjs` + the feature files, cleanup of everything started through `ctx.spawn`/`ctx.container`/`ctx.compose` |
| `lib/common.mjs` | generic | helpers; `appEnv()` strips the control-plane variables (`KITCHEN_CONTROL_ENV`) before anything runs app code |
| `lib/browser.mjs`, `lib/browser-daemon.mjs` | optional module | web surfaces: a Playwright session daemon per instance, and the generic primitives open, reload, press, type, read, screenshot, http, login |
| `lib/terminal.mjs` | optional module | cli surfaces: a `cli {argv, stdin?, expect_exit?}` primitive (one process per call, output into `--out`; ok whatever the exit code, which it reports for the expect, unless `expect_exit` pins one) and `read` of the last output |
| `app.mjs` | project | name, surface, ports, prepare, up, doctor, reset, down, primitives, seed users, externals, parallel |
| `SKILL.md` | project | how agents use this Toolkit (pstack's verification-skill shape) |
| `features/` | project | the feature map: one file per feature, drives in Kitchen's drive format plus a `kitchen` block |

A Toolkit may be written in any language as long as it keeps the contract; this
template is Node because Kitchen already needs Node, and `app.mjs` can shell out
to anything (`python3`, `docker compose`, `make`). Delete the optional modules a
project doesn't use. The browser module wants `"playwright": "1.65.0"` in
`package.json` (the version Kitchen is tested with; another version downloads its
own browser build in `prepare`, which takes minutes on a cold cache).
