# Spike: a steering message to a running `claude -p` (ADR 0009)

`spike.mjs` starts `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku`,
asks for `sleep 8; echo first-done`, and writes a second user message to stdin 1.5 s after the `tool_use` event,
while the Bash call is still running. stdin stays open until a `result` arrives with no further activity for 4 s.

```sh
node spikes/w6-steer/spike.mjs            # one haiku call, about $0.002
```

## Result (2026-11-22, Claude Code 2.1.330, one call, $0.0014)

```
  1995 assistant  tool_use:{"command":"sleep 8; echo first-done", ...}
  3499 >>> writing steer message
 10350 user  tool_result:first-done
 11769 assistant  thinking
 11829 assistant  text:first-done. PINEAPPLE
 12171 result success  {"cost":0.00136266,"turns":2,"sub":"success","result":"first-done. PINEAPPLE",...}
 16172 >>> closing stdin after 1 result(s)
 16775 exit 0 null
```

- **Mid-run delivery works.** The message written while the tool call ran was taken right after that call, inside the
  same turn: the next assistant message followed it ("PINEAPPLE"). There was one `result`, not a second turn.
- **The session does not end on its own while stdin is open.** It ended (exit 0) about 0.6 s after stdin closed.
  So the adapter closes stdin once a `result` arrives, unless a message it wrote has not been answered yet: then it
  waits for the turn that message starts.
- **The `result` line is the same object `--output-format json` printed**: `total_cost_usd`, `num_turns`, `subtype`,
  `is_error`, `result`, `session_id`, `usage`. Cost, turns, rate-limit text and session resume read as before.
- The stream carries no echo of the injected user message. The adapter counts a message as read once an assistant
  event arrives after it was written; one that was written but never followed by an assistant event goes back to the
  queue for the next role.

## Kitchen's adapter on a real `claude` (`adapter.ts`, one haiku call, $0.0020)

```sh
npx tsx spikes/w6-steer/adapter.ts
```

`ClaudeAdapter.run` with the scrubbed env, the sandbox settings and a steer inbox. The steer was queued 1.5 s in,
as soon as the first `tool_use` showed in the stream file, while `sleep 6` ran:

```
1517ms  queue steer m1
9359ms  read m1
{ "ok": true, "line": "Done: `spike.md` is written with \"done\" on line 1 and \"PINEAPPLE\" on line 2.",
  "usage": { "usd": 0.00196334, "inTok": 35373, "outTok": 652 }, "read": ["m1"], "out": "done\nPINEAPPLE\n" }
```

The message was read right after the tool call it arrived during, acted on (the out file has its line), and marked
read. Cost, tokens, session and the out file read as before.

## A steer during the final answer (`late.mjs`, one haiku call, $0.0069)

No tools: the model writes a 250-word paragraph; the steer ("end your answer with PINEAPPLE") is written 1.5 s
after `system init`, while it writes. The first run of the script had a bug (it wrote a steer on every turn's
`system init`, so it looped about 70 short turns before it was killed); its first two turns answer the question:

```
  1320 system init
  2821 >>> writing steer
  4547 assistant  msg_…wfiJ  text(1391 chars, ends "…to a risen, golden loaf.")
  4878 result success   {"cost":0.00086089,"turns":1}
  5195 system init
  6394 assistant  msg_…x7na  thinking
  7622 assistant  msg_…x7na  text(1401 chars, ends "…golden loaf. PINEAPPLE")
  7953 result success   {"cost":0.00139682,"turns":1}
```

- **A message that arrives while the final answer is written is not seen by that answer.** That turn ends with its
  own `result`; then, with stdin still open, Claude Code starts **a new turn** for the queued message (a fresh
  `system init`, a new `message.id`) and acts on it.
- So a message counts as answered only by an assistant event after a turn boundary that follows it (a tool result,
  or a new `system init`); more blocks of the message it arrived during don't count (`ClaudeStream`).
- **`total_cost_usd` is cumulative** over the session's turns (0.00086 → 0.00140 → …); **`num_turns` and `usage`
  are per turn** (1 each), so the adapter sums them over every `result`.
- Every turn starts with its own `system init`.
