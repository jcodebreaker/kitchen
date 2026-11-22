import assert from "node:assert/strict";
import { test } from "vitest";
import { dedupe } from "./append.ts";
import { summarize } from "./report.ts";

const line = (key: string, event = "move", stage = "build") => JSON.stringify({ t: "t", job: "001-x", stage, round: 1, event, key });

test("readers keep the first line per key and skip a torn line", () => {
  const text = [line("a"), line("b", "agent"), line("a", "other"), '{"t":"t","job":"0', ""].join("\n");
  assert.deepEqual(
    dedupe(text).map((l) => [l.key, l.event]),
    [
      ["a", "move"],
      ["b", "agent"],
    ],
  );
});

test("lines without a key are not counted", () => {
  assert.equal(dedupe(JSON.stringify({ event: "x" })).length, 0);
});

test("report counts per stage and event, after dedupe", () => {
  const c = summarize(dedupe([line("a"), line("b", "move", "gate"), line("c", "refused", "gate"), line("a")].join("\n")));
  assert.equal(c.lines, 3);
  assert.deepEqual(c.byStage.gate, { move: 1, refused: 1 });
  assert.equal(c.byEvent.move, 2);
});
