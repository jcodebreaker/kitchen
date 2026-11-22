// The dashboard's data for one job and its card: timers from the moves, unread messages, who asks, what counts as sent back.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { Stage } from "../engine/machine.ts";
import { addMessage } from "../engine/messages.ts";
import { createJob, jobDirOf, updateJob } from "../engine/store.ts";
import { appendLedger } from "../ledger/append.ts";
import { snapshot } from "./data.ts";
import { detail } from "./detail.ts";

let repo = "";
const saved = process.env.KITCHEN_HOME;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-detail-"));
  process.env.KITCHEN_HOME = path.join(repo, ".home");
  fs.writeFileSync(path.join(repo, "kitchen.yaml"), "version: 1\nagent: { tool: codex }\n");
});
afterEach(() => {
  process.env.KITCHEN_HOME = saved;
  fs.rmSync(repo, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-22T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
/** A job walked through `path` (stage after each move), a move every `step` minutes, ending in `stage` with `round`. */
async function walked(path: [Stage, Stage][], o: { stage: Stage; round?: number; extra?: Partial<Record<string, unknown>> }) {
  const { job } = await createJob(repo, { title: "x", ticket: { source: "prompt", id: "p1" }, body: "x", roundLimit: 3, base: "", now: new Date(T0) });
  for (const [i, [from, to]] of path.entries())
    appendLedger(repo, {
      t: at(10 * (i + 1)),
      job: job.id,
      stage: from,
      round: 1,
      event: "move",
      result: to,
      key: `${job.id}/m${i + 1}/${from}>${to}`,
      detail: {},
    });
  await updateJob(repo, job.id, (j) => ({ ...j, stage: o.stage, round: o.round ?? 1, moves: path.length, ...(o.extra ?? {}) }));
  return job.id;
}

test("timers: a running job counts from its last move, a paused one is frozen at the time it ran, its age is its own", async () => {
  const run = await walked(
    [
      ["intake", "build"],
      ["build", "gate"],
    ],
    { stage: "gate" },
  );
  const paused = await walked(
    [
      ["intake", "build"],
      ["build", "paused"],
    ],
    { stage: "paused", extra: { pausedFrom: "build", pausedReason: "by-you" } },
  );
  const s = await snapshot(repo, T0 + 60 * 60_000);
  const a = s.jobs.find((j) => j.id === run);
  const b = s.jobs.find((j) => j.id === paused);
  assert.equal(a?.movedAt, at(20), "the move into gate");
  assert.equal(a?.pausedSecs, null);
  assert.equal(b?.pausedSecs, 600, "it ran 10 minutes in build before the pause, whatever the clock says now");
  assert.equal(b?.secs, 3600, "the age, for the panel only");
  assert.equal(s.tool, "codex", "read with loadConfig");
});

test("one round everywhere: the card carries job.json's round, as the timeline does", async () => {
  const id = await walked([["intake", "build"]], { stage: "build", round: 3, extra: { roundStart: 3 } });
  const s = await snapshot(repo, T0 + 30 * 60_000);
  assert.equal(s.jobs.find((j) => j.id === id)?.round, 3);
  assert.equal((await detail(repo, id)).tl.at(-1)?.round, 3);
});

test("cost: today and in all come from the same ledger lines (setup included)", async () => {
  appendLedger(repo, { t: new Date(T0).toISOString(), job: "-", stage: "init", round: 0, event: "agent", key: "init/1", usd: 1.05 });
  appendLedger(repo, { t: new Date(T0 - 3 * 86_400_000).toISOString(), job: "-", stage: "init", round: 0, event: "agent", key: "init/2", usd: 0.5 });
  const s = await snapshot(repo, T0 + 60_000);
  assert.equal(s.usdToday, 1.05);
  assert.equal(s.usdTotal, 1.55);
  assert.ok(s.usdToday <= s.usdTotal);
});

test("a repro that can't reproduce asks as the Repro agent; a drives that goes back to gate is sent back, not a pass", async () => {
  const id = await walked(
    [
      ["intake", "repro"],
      ["repro", "needs-info"],
    ],
    { stage: "needs-info" },
  );
  const d = await detail(repo, id);
  const ask = d.tl.at(-1)?.evs.find((e) => e.c === "ask");
  assert.equal(ask && "who" in ask ? ask.who : "", "Repro agent");
  assert.equal((await snapshot(repo, T0)).jobs[0].agent, "Repro agent");

  const back = await walked(
    [
      ["intake", "build"],
      ["build", "gate"],
      ["gate", "drives"],
      ["drives", "gate"],
    ],
    { stage: "gate" },
  );
  const tl = (await detail(repo, back)).tl;
  assert.deepEqual(
    tl.map((x) => [x.nm, x.st]),
    [
      ["Intake", "ok"],
      ["Build", "ok"],
      ["Gate", "ok"],
      ["Drives", "bad"],
      ["Gate", "run"],
    ],
  );
});

test("a message no agent has read yet is marked so the panel keeps its segment open", async () => {
  const id = await walked(
    [
      ["intake", "build"],
      ["build", "gate"],
    ],
    { stage: "gate" },
  );
  const dir = jobDirOf(repo, id);
  await addMessage(dir, { kind: "steer", text: "early note", stage: "build", now: new Date(at(15)) });
  const d = await detail(repo, id);
  const build = d.tl.find((x) => x.stage === "build");
  const m = build?.evs.find((e) => e.c === "you");
  assert.ok(m && "sent" in m && m.sent, "in the closed Build segment, flagged unread");
});
