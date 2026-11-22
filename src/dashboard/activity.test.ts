import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ActivityParser, activityOf } from "./activity.ts";

const WT = "/repo/.worktrees/005-x";
const line = (o: object) => JSON.stringify(o);
const assistant = (t: string, ...content: object[]) => line({ type: "assistant", timestamp: t, message: { content } });
const result = (t: string, id: string, content: string, is_error = false) =>
  line({ type: "user", timestamp: t, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });

test("a Claude transcript: reasoning lines, calls with their targets, edit counts, durations and outcomes", () => {
  const p = new ActivityParser([WT]);
  for (const l of [
    line({ type: "user", timestamp: "2026-11-22T10:00:00Z", message: { content: "the prompt, as a string: not activity" } }),
    assistant(
      "2026-11-22T10:00:01Z",
      { type: "text", text: "**Find** where `status` prints its rows\n\nmore detail" },
      { type: "tool_use", id: "a", name: "Read", input: { file_path: `${WT}/src/cli/commands.ts` } },
    ),
    result("2026-11-22T10:00:01.400Z", "a", "file text"),
    assistant("2026-11-22T10:00:02Z", {
      type: "tool_use",
      id: "b",
      name: "Edit",
      input: { file_path: `${WT}/src/cli/commands.ts`, old_string: "a\nb", new_string: "a\nb\nc\nd" },
    }),
    result("2026-11-22T10:00:02.500Z", "b", "ok"),
    assistant("2026-11-22T10:00:03Z", { type: "tool_use", id: "c", name: "Bash", input: { command: "npm test -- status\n# second line" } }),
    result("2026-11-22T10:00:09Z", "c", "…\nTests  15 passed (15)\n"),
    assistant("2026-11-22T10:00:10Z", { type: "tool_use", id: "d", name: "Bash", input: { command: "npm run lint" } }),
    result("2026-11-22T10:00:11Z", "d", "src/x.ts: lint error\nmore", true),
    assistant("2026-11-22T10:00:12Z", { type: "tool_use", id: "e", name: "mcp__kitchen__drive", input: { criterion: "C1" } }),
    line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "a subagent's line: left out" }] } }),
    "not json",
  ])
    p.feed(l);
  const evs = p.events;
  assert.deepEqual(
    evs.map((e) => [e.c, e.vb ?? "", e.tg ?? e.t]),
    [
      ["think", "", "Find where status prints its rows"],
      ["tool", "Read", "src/cli/commands.ts"],
      ["tool", "Edit", "src/cli/commands.ts"],
      ["tool", "Bash", "npm test -- status"],
      ["res", "", "Tests  15 passed (15)"],
      ["tool", "Bash", "npm run lint"],
      ["bad", "", "src/x.ts: lint error"],
      ["tool", "Kitchen", "drive C1"],
    ],
  );
  assert.deepEqual(evs[2].df, [4, 2], "Edit: +new −old lines");
  assert.equal(evs[1].dur, 0.4);
  assert.equal(evs[3].dur, 6);
  assert.equal(evs.at(-1)?.dur, null, "the call still running has no duration");
});

test("Codex exec --json events: commands, file changes, reasoning", () => {
  const p = new ActivityParser([WT]);
  const ev = (type: string, item: object, t: string) => line({ type, item, _t: t });
  p.feed(ev("item.completed", { id: "r", type: "reasoning", text: "**Plan** the change" }, "2026-11-22T10:00:00Z"));
  p.feed(ev("item.started", { id: "x", type: "command_execution", command: "/bin/zsh -lc 'npm test'" }, "2026-11-22T10:00:01Z"));
  p.feed(
    ev(
      "item.completed",
      { id: "x", type: "command_execution", command: "/bin/zsh -lc 'npm test'", aggregated_output: "fail: 1\n", exit_code: 1 },
      "2026-11-22T10:00:04Z",
    ),
  );
  p.feed(ev("item.completed", { id: "f", type: "file_change", changes: [{ path: `${WT}/src/a.ts`, kind: "update" }] }, "2026-11-22T10:00:05Z"));
  assert.deepEqual(
    p.events.map((e) => [e.c, e.vb ?? "", e.tg ?? e.t, e.dur ?? null]),
    [
      ["think", "", "Plan the change", null],
      ["tool", "Bash", "npm test", 3],
      ["bad", "", "fail: 1", null],
      ["tool", "Edit", "src/a.ts", 0],
    ],
  );
});

test("a stream file is read incrementally: only what was appended is parsed, a torn last line waits", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-act-")), "s.jsonl");
  const a = assistant("2026-11-22T10:00:01Z", { type: "tool_use", id: "a", name: "Bash", input: { command: "sleep 9" } });
  fs.writeFileSync(f, `${a}\n`);
  assert.equal(activityOf(f).length, 1);
  const r = result("2026-11-22T10:00:10Z", "a", "done");
  fs.appendFileSync(f, r.slice(0, 20));
  assert.equal(activityOf(f).at(-1)?.dur, null, "half a line is not read yet");
  fs.appendFileSync(f, `${r.slice(20)}\n`);
  const evs = activityOf(f);
  assert.equal(evs[0].dur, 9);
  assert.equal(evs.at(-1)?.t, "done");
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test("paths from another checkout of the repo still read relative", () => {
  const p = new ActivityParser(["/elsewhere"]);
  p.feed(assistant("t", { type: "tool_use", id: "a", name: "Read", input: { file_path: "/old/place/.worktrees/005-x/src/a.ts" } }));
  p.feed(assistant("t", { type: "tool_use", id: "b", name: "Write", input: { file_path: "/old/place/.kitchen/scratch/005/report.md", content: "x" } }));
  assert.deepEqual(
    p.events.map((e) => e.tg),
    ["src/a.ts", ".kitchen/scratch/005/report.md"],
  );
});
