import assert from "node:assert/strict";
import { test } from "vitest";
import { CorruptJob, jobIdOf, nextNumber, parseJob, slugify, titleOf } from "./store.ts";

test("job ids are NNN-slug, numbered after the highest in use", () => {
  assert.equal(nextNumber([]), 1);
  assert.equal(nextNumber(["001-a", "007-b", ".create.lock", "junk", "003-c"]), 8);
  assert.equal(jobIdOf(8, "Add a Dark-mode toggle!"), "008-add-a-dark-mode-toggle");
  assert.equal(jobIdOf(1234, "x"), "1234-x");
});

test("slugs are short, lowercase and never empty", () => {
  assert.equal(slugify("  Héllo,   Wörld  "), "hello-world");
  assert.equal(slugify("!!!"), "ticket");
  const long = slugify("a very long title that goes on and on past the forty character mark");
  assert.ok(long.length <= 40 && !long.endsWith("-"), long);
});

test("a prompt ticket's title is its first non-empty line", () => {
  assert.equal(titleOf("\n\n  Fix the login bug \nmore detail"), "Fix the login bug");
  assert.equal(titleOf("x".repeat(100)).length, 72);
});

test("job.json is checked against the schema: a bad one is corrupt with a reason", () => {
  const good = {
    id: "001-x",
    title: "x",
    ticket: { source: "prompt", id: "p1" },
    stage: "intake",
    round: 1,
    roundStart: 1,
    roundLimit: 3,
    risk: null,
    riskFloor: null,
    surfaces: [],
    kind: null,
    base: "",
    branch: "kitchen/001-x",
    worktree: "",
    pr: null,
    slot: null,
    toolkitRef: "",
    returnTo: null,
    gap: null,
    attempts: { drives: 0, render: 0, toolkitTicket: 0, repro: 0, inconclusive: 0, backoff: 0, errors: 0, refused: 0 },
    smith: { attempts: 0, toolkitPr: null },
    toolkitTicketRef: null,
    filed: [],
    agentRuns: [],
    moves: 0,
    running: null,
    startedAt: "t",
    updatedAt: "t",
    uid: "u",
    gitDir: "",
    toolkitBin: "",
    slotId: "001-x",
    manifestHead: { n: 0, hash: "0", mac: "m" },
    later: "a field a newer version wrote",
  };
  const j = parseJob(JSON.stringify(good));
  assert.equal(j.stage, "intake");
  assert.equal((j as unknown as { later: string }).later, "a field a newer version wrote", "unknown fields are kept");
  assert.throws(
    () => parseJob(JSON.stringify({ ...good, stage: "cooking" })),
    (e: Error) => e instanceof CorruptJob && /^stage: /.test(e.message),
  );
  assert.throws(
    () => parseJob(JSON.stringify(good).slice(0, 40)),
    (e: Error) => e instanceof CorruptJob && /^not JSON/.test(e.message),
  );
  assert.throws(() => parseJob(JSON.stringify({ ...good, attempts: { ...good.attempts, refused: -1 } })), /attempts\.refused/);
});
