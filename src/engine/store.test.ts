import assert from "node:assert/strict";
import { test } from "vitest";
import { CorruptJob, jobIdOf, nextNumber, parseJob, shortTitle, slugify, titleOf } from "./store.ts";

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

test("a prompt ticket's title until intake runs: the first sentence, no kind prefix, cut at a word at about 60 (ADR 0011)", () => {
  assert.equal(titleOf("\n\n  Fix the login bug \nmore detail"), "Fix the login bug");
  assert.equal(
    titleOf("add a feature: members can renew a loan once, for another 14 days. POST /loans/:id/renew answers 200 with the new due date"),
    "Members can renew a loan once, for another 14 days",
  );
  assert.equal(titleOf("Bug: the tasks list shows deleted tasks"), "The tasks list shows deleted tasks");
  assert.equal(titleOf("Feature request - dark mode in settings!"), "Dark mode in settings");
  // A long first sentence is cut at a word boundary, never mid-word, at about 60 characters.
  const long = titleOf("make the dashboard show every job's cost and time per stage in one compact table that sorts by any column");
  assert.ok(long.length <= 61, long);
  assert.equal(long, "Make the dashboard show every job's cost and time per stage…");
  assert.ok(titleOf("x".repeat(100)).length <= 61);
  // A dot inside a word (a file name) is not the end of a sentence.
  assert.equal(titleOf("Add lib/stats.js: print the counts. Then more."), "Add lib/stats.js: print the counts");
  assert.equal(titleOf("   "), "untitled");
  // An abbreviation is not the end of a sentence: one needs a space and a capital letter after it, and some length.
  assert.equal(titleOf("Show overdue loans, e.g. the ones past 14 days, in red. Then sort them."), "Show overdue loans, e.g. the ones past 14 days, in red");
  assert.equal(titleOf("Fix it. Now the list breaks on empty input."), "Fix it. Now the list breaks on empty input");
  // Bidi overrides and zero-width characters never reach a title.
  assert.equal(titleOf("Rename \u202Etxt.exe\u202C and the \u200Bdocs"), "Rename txt.exe and the docs");
});

test("intake's TITLE is cleaned to one short line, or nothing", () => {
  assert.equal(shortTitle("Renew a loan once for 14 more days"), "Renew a loan once for 14 more days");
  assert.equal(shortTitle("  Renew a `loan`\n "), "Renew a loan");
  assert.equal(shortTitle("Fix parse_args for a*b"), "Fix parse_args for a*b", "underscores and stars stay");
  assert.equal(shortTitle("Rename \u202Eexe.txt\u202C now"), "Rename exe.txt now", "no bidi override");
  assert.equal(shortTitle(""), null);
  assert.equal(shortTitle(undefined), null);
  assert.ok((shortTitle("word ".repeat(30)) ?? "").length <= 61);
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
