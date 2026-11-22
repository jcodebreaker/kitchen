# Reference: criteria, proofs and drives

Kitchen proves a ticket by driving the real app. Every acceptance criterion names how it is proven; the engine runs that proof itself (`kitchen drive`), stamps every step as evidence, and decides every mechanical `expect:` without any agent.

## Criteria format (exact)

```
## Criteria
- [C1] <one observable behaviour, from the user's point of view>
  proof: toolkit <drive or primitive> --<arg> <value> [; toolkit <next> …]
  expect: <mechanical expect, or judged>
  covers: R1, R2              # the requirements of intake.md this criterion proves
- [C2] …
  proof: test <file>          # a test file, run with the project's test command
  expect: exit 0
- [C3] …
  proof: cmd <shell command>  # runs in the worktree with a fake env (see below)
  expect: contains "…"
  repro: true                 # bugs only: this criterion shows the bug on the current code
```

- A `cmd` or `test` proof runs in the job's worktree with the project's fake env, not your environment. It may name only paths inside the worktree: no absolute path (except `/dev/null`), no `..`, `~` or `$HOME`, no `env`/`printenv`, and no network tool (`curl`, `wget`, `nc`, `ssh`, `scp`…); spec-lint refuses anything else. Its expect also requires exit 0, unless the expect is about `exit`. Those lint rules are only a first line: the real boundary is the OS sandbox the engine runs every `cmd` and `test` proof in (no network but localhost, nothing under the home folder readable but the worktree and the toolchains, writes only in the worktree and temp), and what the proof prints is redacted before it is stored. A proof that needs the network or your files can't pass. A test that talks to the running app reads its address from the env var `KITCHEN_APP_URL` (the URL the Toolkit's `up` gave for the job's slot); never assume a port.

- Ids are `C1`, `C2`, … and unique. Two-space indent for `proof:`, `expect:`, `covers:`, `repro:`.
- `covers:` names the requirements of intake.md (`## Requirements`, R1…) the criterion proves. The engine refuses a contract where a criterion covers none, a requirement in scope is covered by none, a `(negative)` requirement is covered by no criterion asserting an absence, or an `(unchanged)` one (a regression guard) by no mechanical criterion showing the old behaviour still holds.
- `toolkit` segments run in one browser session, left to right, separated by ` ; `. A dotted name (`settings.toggle-dark`) is a feature drive; a plain name (`read`, `open`, `press`) is one primitive. Args are `--name value`; quote values with spaces (`--target "[data-testid=x]"`). A quote inside a value: single-quote the value (`--target 'a[href="/x"]'`), or double-quote it and escape the inner quotes (`--target "a[href=\"/x\"]"`); a backslash inside `'…'` is kept as is, so `\"` there is refused. A feature drive takes exactly the args it declares.
- Values saved by a drive (`save: theme`) are `$theme` in later segments' args and in `expect:`. A single primitive segment saves its output with `--save <var>` (`toolkit read --target "[data-testid=owner]" --save owner`, then `expect: $owner == "alice"`).
- Only primitives and feature drives that exist may be named, except a **new feature drive** for this ticket's feature: name it `<feature>.<verb>` and list it under `## New drives` with one line saying what it does step by step (what to open or press, what to read, what to `save:`). The verifier writes it later from primitives.
- If a behaviour can only be observed through something no primitive offers (for example a database row the UI never shows), name the **missing primitive** as a plain segment anyway, generic and read-only (`toolkit sql --query "SELECT …" --save rows`), and state no workaround: the engine sends the job to the Toolkit smith, who adds it on its own Toolkit PR. Never fake it with a `cmd` that reaches the app's database or network.

## expect (mechanical: the engine decides)

One clause, or several joined with ` and `:

| expect | holds when |
|---|---|
| `ok` | every step ran (toolkit), or exit 0 (cmd/test) |
| `exit 0` · `exit != 0` · `exit 1` | the cmd/test exit code; for a toolkit proof, the exit code of its last command step (a cli Toolkit's `cli`) |
| `text "Saved" visible` · `text "Bob plan" not visible` | the page's body text (read after the proof) contains / lacks it |
| `contains "dark"` · `not contains "x"` | the proof's last output contains / lacks it (a `cli` step: its stdout or stderr) |
| `json .theme == "dark"` · `json $me.theme == "dark"` | a JSON path into the last output, or into a saved var (an `http` step: its body) |
| `rows == 3` · `rows $list >= 1` | length of a JSON array (or its `rows`/`body` array) |
| `$theme == "Dark"` · `$owner != "alice"` · `$me contains "dark"` | a saved var |
| `judged` | NOT mechanical: only for layout, appearance, visual style, tone or copy quality ("looks right in dark mode", "the error copy is friendly"), never whether a message, label or value is there. An agent judges it from screenshots, citing evidence. Its proof must take a `screenshot` (a step, or a drive that takes one) |

Strings are double-quoted. Prefer mechanical expects: they are cheaper and can't be argued with.

**Command steps (a cli Toolkit).** The `cli` primitive runs the command and is a step that ran whatever its exit code: its output is `{exit, stdout, stderr}`, and the expect decides. The expect reads it as a terminal shows it: `exit …` is the exit code, `contains` / `not contains` read stdout and stderr, and `json …`, `rows …` and a `--save` read stdout (`toolkit cli --argv "stats --json"` then `expect: json .open == 4`; no `read --target stdout` needed). An expect that says nothing about `exit` also requires exit 0, as for a `cmd` proof. So a bug whose current code exits with the wrong code (an unknown command that exits 0, a command that crashes with 2) is reproduced by an expect that is false there (`expect: exit 1 and contains "unknown command"`). The step fails only when the command can't run at all, or when the drive pins `expect_exit: N` and the exit differs: pin `expect_exit: 0` on a setup step that must succeed (one that creates what a negative expect is about). A list arg goes in `'…'` as JSON (`--argv '["add","a title"]'`) or as one shell line (`--argv "add 'a title'"`): `--argv ["add","x"]` loses its inner quotes and is refused.

**HTTP steps.** An `http` step's output is the response, `{status, body}`. `json …`, `rows …` and a `--save` read its **body** (`toolkit http --method GET --path /api/me` then `expect: json .name == "alice"`; `--save me` then `$me contains "alice"`), and `--save v` also keeps the status as `$v_status` (`$v_status == "201"`). A key the body doesn't have is read from the response (`json .status == 404` when the body has no `status` of its own). `contains` on the last output reads the whole response. A negative on a response that failed (4xx/5xx) proves nothing and fails, unless the same expect asserts that error.

**Long literals.** When a criterion says how long a literal is ("a 201-character title", "exactly 200 characters", "longer than 200 characters"), the literal must have that length, or the contract is refused: count it, best as repeated 10-character blocks (`0123456789` × 20 = 200).

**Negative expects** (`not visible`, `not contains`, `!=`, and `== ""`, an empty read) hold whenever the thing never existed, so the engine accepts one only when something shows the thing would be there:
- **made by an earlier step** of the same proof that creates it (a feature drive, or an `http` POST/PUT/PATCH/DELETE), with that text as an arg: `toolkit notes.create --user bob --title "Bob plan" ; toolkit login --as alice ; toolkit open --path /notes` then `expect: text "Bob plan" not visible`. Who signs in or where a step goes makes nothing (`--as bob` doesn't make "Bob plan"). Text that only names what was made (a line around it, a marker beside it) counts when the same expect also shows the made thing: `toolkit cli --argv "add Zebra" ; toolkit cli --argv "list"` then `expect: contains "Zebra" and not contains "[x] Zebra"`;
- **a value read after a write**: `!=` on a value saved after a step that makes something: `toolkit http --method POST --path /cart/items --body '{"sku":"A1","qty":3}' ; toolkit read --target "[data-testid=total]" --save total` then `expect: $total != "0.00"` (the wrong value), best beside the right one (`$total == "30.00"`). A value that wasn't saved, is empty, is missing at its path, is a failed response or an error page never differs, so name the wrong value the bug or a wrong build would give, not an arbitrary one. `not contains` on a saved page is not this case: it is shown on the current code, below;
- **shown on the current code**: anything else (the old heading a rename removes, an error the fix makes go away), the engine runs the proof on the base before anything is built, and the clause must be FALSE there, so every step of that proof must run on the current code (keep checks of the new behaviour in another criterion). A negative that already holds on the base proves nothing and is refused, with the reason, once.

Make sure what you read would show it if it leaked: the page's text shows that very field (a list of names won't show a slug; `http --method GET --path /list` returns the page's HTML, links and ids included), for someone allowed to see it; pair the negative with a positive criterion that reads the same thing as someone who should see it. A negative also fails on an error or not-found page, a failed response, or an empty read: if an error is the expected outcome, assert the error itself in the same expect (`text "Not found" visible`, `contains "already used" and not contains "accepted"`). `$x == ""` names nothing that must not show, so it needs at least an earlier step that makes something; prefer naming the text that must not show (`not contains "bob-admin"`) on a read that would show it. A requirement that only says existing behaviour stays ("nothing else changes", "the other pages keep their layout", "a free slug still works") is `(unchanged)`, proven positively, not `(negative)`.

**A repro** (`repro: true`) must run every step on the current code and end with its expect FALSE: that is the bug, shown. A step that fails first is a broken proof, not a reproduction: `expect: ok` alone can never be false that way (refused), nor can a `read --equals` step (refused); an `http` answered with a 4xx fails its step unless `--expect_status` names that status. Save the value and assert the right one in the expect (`toolkit read --target "[data-testid=result]" --save r` then `$r == "Saved"`; an `http` step's `--save r` then `$r_status == "201"`). Don't pin the bug's own outcome on a step either (`--expect_status 400`, `--expect_exit 1`): that step passes on the buggy code and fails once it is fixed (refused). When the repro can't show the bug as written, the contract comes back to its author once with the evidence.

**Users.** A proof signs in (`--as`) or picks rows by username only as a seed user the Toolkit lists ("Seed users" in the Toolkit block), or as a user an earlier step of the same proof makes; anything else is refused.

**Before any build**, the engine runs every mechanical criterion once on the current code. A regression guard (a criterion covering only `(unchanged)` requirements) must hold there: one that fails on the current code misreads it (an `http` step's `json` reads its body; a drive's output is its last step's) and is refused with the evidence. For a feature, one that already passes there proves nothing about the change: the spec is sent back once to strengthen it, and Verify flags it as non-discriminating.

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
