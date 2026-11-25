// ADR 0032 §3: a failed step in three lines: the useful line is the first error-ish line of the failing command's
// section, never Kitchen's own markers, and each kind says the recovery the verbs really offer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { diagnose, failureOf, LOG_TAIL, usefulLine } from "./diagnose.ts";
import type { Job } from "./machine.ts";

test("the useful line: the failing command's first error line, not the last line or a marker", () => {
  const log = [
    "$ npm ci",
    "npm warn deprecated x: this failed once",
    "[exit 0]",
    "",
    "$ npm test",
    "> vitest run",
    "\x1b[31m FAIL \x1b[39m src/a.test.ts > adds",
    "AssertionError: expected 2 to be 3",
    "Tests  1 failed | 4 passed",
    "[exit 1]",
  ].join("\n");
  assert.equal(usefulLine(log), "FAIL  src/a.test.ts > adds");
  assert.equal(usefulLine("$ make\nall good\n[exit 2]\n"), "all good");
  assert.equal(usefulLine("$ make\n[exit 2]\n"), "[exit 2]");
  assert.equal(usefulLine("sh: tsc: command not found\nENOENT: no such file"), "ENOENT: no such file");
});

test("passing lines that name errors are skipped; a failure in so many words wins (vitest, pytest, go, tsc)", () => {
  const vitest = [
    "$ npx vitest run",
    " ✓ src/error-handling.test.ts (4 tests) 12ms",
    " × src/cart.test.ts > total > rounds (3 ms)",
    "   → expected 41 to be 42",
    " Test Files  1 failed | 1 passed (2)",
    "[exit 1]",
  ].join("\n");
  assert.equal(usefulLine(vitest), "× src/cart.test.ts > total > rounds (3 ms)");
  const pytest = [
    "$ python3 -m pytest -q",
    "tests/test_errors.py .....                                         [ 50%]",
    "tests/test_cart.py ..F..                                           [100%]",
    "=================================== FAILURES ===================================",
    "    def test_total():",
    ">       assert total([1, 2]) == 4",
    "E       assert 3 == 4",
    "FAILED tests/test_cart.py::test_total - assert 3 == 4",
    "[exit 1]",
  ].join("\n");
  assert.equal(usefulLine(pytest), "E       assert 3 == 4");
  const go = [
    "$ go test ./...",
    "ok  \texample.com/errors\t0.01s",
    "--- FAIL: TestTotal (0.00s)",
    "    cart_test.go:9: got 3, want 4",
    "FAIL\texample.com/cart\t0.02s",
    "[exit 1]",
  ].join("\n");
  assert.equal(usefulLine(go), "--- FAIL: TestTotal (0.00s)");
  assert.equal(
    usefulLine("$ npx tsc --noEmit\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable\n[exit 2]"),
    "src/a.ts(3,7): error TS2322: Type 'string' is not assignable",
  );
});

test("each kind says what, and a recovery that exists", () => {
  assert.deepEqual(diagnose("checks", "$ npm test\nError: boom\n[exit 1]", { name: "test" }), {
    what: "Checks failed: test",
    line: "Error: boom",
    next: "Reply with how to fix it: it goes back to Build for another round",
  });
  assert.equal(diagnose("app", "", { why: "seed data missing", num: "004" }).next, "Fix the environment, then Reply: QA runs again (or kitchen resume 004)");
  assert.match(diagnose("merge", "", { target: "staging", ready: true }).next, /Ask for changes/);
});

test("failureOf reads the reason and the step's log; other jobs have none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-diag-"));
  fs.mkdirSync(path.join(dir, "rounds", "2"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rounds", "2", "checks.log"), "$ npm test\nTypeError: cannot read x of undefined\n[exit 1]\n");
  const job = {
    id: "004-renew",
    stage: "needs-human",
    round: 2,
    pausedReason: "the build lane failed 3 times: the checks failed: test (exit 1); the log is .kitchen/jobs/004-renew/rounds/2/checks.log",
  } as Job;
  const f = failureOf(dir, job);
  assert.equal(f?.what, "Checks failed: test");
  assert.equal(f?.line, "TypeError: cannot read x of undefined");
  assert.equal(f?.log, path.join("rounds", "2", "checks.log"));
  // A check's name may have spaces.
  const sp = failureOf(dir, { ...job, pausedReason: "the build lane failed 3 times: the checks failed: unit tests (exit timeout); the log is x" } as Job);
  assert.equal(sp?.what, "Checks failed: unit tests");
  // Only the log's last 64 KB is read: an early error line in a long log is past it.
  fs.writeFileSync(
    path.join(dir, "rounds", "2", "checks.log"),
    `$ npm test\nError: early, far up the log\n${"ok line\n".repeat(LOG_TAIL / 8)}AssertionError: the late one\n[exit 1]\n`,
  );
  assert.equal(failureOf(dir, job)?.line, "AssertionError: the late one");
  // A refused lane whose reason quotes the merge's words is a refused lane, not a merge.
  const quoted = failureOf(dir, { ...job, pausedReason: "the review lane failed 3 times: review: says merge into staging failed earlier" } as Job);
  assert.equal(quoted?.kind, "lane");
  const lane = failureOf(dir, { ...job, pausedReason: "the qa lane failed 3 times: QA: no verdict.json" } as Job);
  assert.equal(lane?.what, "Kitchen refused the QA agent's work 3 times");
  assert.equal(failureOf(dir, { ...job, pausedReason: "QA failed C1 after 3 rounds" } as Job), null);
  // ADR 0029: QA couldn't test some criteria (the environment), and a check whose findings couldn't be proposed.
  const nr = failureOf(dir, { ...job, pausedReason: "QA couldn't test C2, C4: the seed has no members" } as Job);
  assert.deepEqual(
    [nr?.what, nr?.line, nr?.next],
    ["QA couldn't test C2, C4", "the seed has no members", "Fix the environment, then Reply: QA runs again (or kitchen resume 004)"],
  );
  assert.equal(failureOf(dir, { ...job, pausedReason: "QA couldn't run: the app won't start" } as Job)?.line, "the app won't start");
  const pf = failureOf(dir, { ...job, stage: "done", check: { proposalsFailed: { error: "inbox locked", round: 2 } } } as Job);
  assert.deepEqual([pf?.what, pf?.line], ["Proposals failed", "inbox locked"]);
  assert.equal(failureOf(dir, { ...job, stage: "build" } as Job), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
