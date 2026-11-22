# Reference: criteria, proofs and drives

Kitchen proves a ticket by driving the real app. Every acceptance criterion names how it is proven; the engine runs that proof itself (`kitchen drive`), stamps every step as evidence, and decides every mechanical `expect:` without any agent.

## Criteria format (exact)

```
## Criteria
- [C1] <one observable behaviour, from the user's point of view>
  proof: toolkit <drive or primitive> --<arg> <value> [; toolkit <next> …]
  expect: <mechanical expect, or judged>
- [C2] …
  proof: test <file>          # a test file, run with the project's test command
  expect: exit 0
- [C3] …
  proof: cmd <shell command>  # runs in the worktree, no network, fake env
  expect: contains "…"
  repro: true                 # bugs only: this criterion shows the bug on the current code
```

- Ids are `C1`, `C2`, … and unique. Two-space indent for `proof:`, `expect:`, `repro:`.
- `toolkit` segments run in one browser session, left to right, separated by ` ; `. A dotted name (`settings.toggle-dark`) is a feature drive; a plain name (`read`, `open`, `press`) is one primitive. Args are `--name value`; quote values with spaces (`--target "[data-testid=x]"`). A feature drive takes exactly the args it declares.
- Values saved by a drive (`save: theme`) are `$theme` in later segments' args and in `expect:`.
- Only primitives and feature drives that exist may be named, except a **new feature drive** for this ticket's feature: name it `<feature>.<verb>` and list it under `## New drives` with one line saying what it does step by step (what to open or press, what to read, what to `save:`). The verifier writes it later from primitives.

## expect (mechanical: the engine decides)

One clause, or several joined with ` and `:

| expect | holds when |
|---|---|
| `ok` | every step ran (toolkit), or exit 0 (cmd/test) |
| `exit 0` · `exit != 0` | the cmd/test exit code |
| `text "Saved" visible` · `text "Error" not visible` | the page's body text (read after the proof) contains / lacks it |
| `contains "dark"` · `not contains "x"` | the proof's last output contains / lacks it |
| `json .theme == "dark"` · `json $me.body.theme == "dark"` | a JSON path into the last output, or into a saved var |
| `rows == 3` · `rows $list >= 1` | length of a JSON array (or its `rows`/`body` array) |
| `$theme == "Dark"` · `$theme != "Light"` · `$me contains "dark"` | a saved var |
| `judged` | NOT mechanical: only for a visual or wording criterion ("looks right", "reads clearly"); an agent judges it from screenshots, citing evidence. Its proof must take a `screenshot` |

Strings are double-quoted. Prefer mechanical expects: they are cheaper and can't be argued with.

## Feature drives (`.kitchen/toolkit/features/<feature>.md`)

A feature drive is a fenced block whose info string is `drive`, in a restricted YAML subset the engine interprets. It holds no code: only primitive calls.

```drive
drive: settings.toggle-dark
args: [user]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=nav-settings]" }
  - wait:  { until: { text: "Appearance" }, timeout: 10s }
  - read:  { target: "[data-testid=theme-state]" }
    save: theme
  - retry: { times: 2, on: fail }
  - screenshot: { name: settings }
```

- Top-level keys: `drive`, `args`, `steps` only. One step per line, written as a flow mapping `{ … }`. `save: <name>` is the only line that may follow a step. `retry` applies to the step before it.
- Step names are primitives from describe, plus the built-in `wait: { until: { text, target?, attr? }, timeout }`, which polls `read` until the text shows up (it fails on timeout).
- `$name` refers to an arg or an earlier `save`. Never pass `id`, `src`, `out` or `ports`.
- No loops, branches, scripts, multi-line values or other code blocks. Anything that needs code is a missing primitive (a Toolkit gap), not a drive.
