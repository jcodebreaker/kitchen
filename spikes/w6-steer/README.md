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
