import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { leftOutOf, matchPath, parseIntake, qaDir, readQa, readReview, reviewFile } from "./lanes.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-lanes-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("intake.md: ACCEPT needs criteria with a check kind; NEEDS-INFO needs its question; anything else is refused", () => {
  const ok = parseIntake(
    "DECISION: ACCEPT\nTITLE: Renew a loan\nKIND: feature\nRISK: medium\nSURFACES: ui, none\nFILES: server.js, `lib/loans.js`\nAFTER: 3, 004-x\n\n## Criteria\n- C1 (http): POST /loans/1/renew → 200\n- **C2** (page): /loans shows renewed\n- C3 (vibes): ignored\n",
  );
  assert.ok("decision" in ok && ok.decision === "ACCEPT");
  if (ok.decision !== "ACCEPT") return;
  assert.deepEqual(
    ok.criteria.map((c) => [c.id, c.check]),
    [
      ["C1", "http"],
      ["C2", "page"],
    ],
  );
  assert.deepEqual([ok.files, ok.after, ok.surfaces], [["server.js", "lib/loans.js"], ["003", "004"], ["ui"]]);
  assert.match(String((parseIntake("DECISION: ACCEPT\nKIND: feature\nRISK: low\n") as { refused: string }).refused), /at least one criterion/);
  assert.deepEqual(parseIntake("DECISION: NEEDS-INFO\nQUESTION: Which page?\n"), { decision: "NEEDS-INFO", question: "Which page?", title: null });
  assert.ok("refused" in parseIntake("DECISION: NEEDS-INFO\n"));
  assert.ok("refused" in parseIntake("DECISION: maybe\n"));
});

test("the QA verdict: every criterion has a row; every row cites evidence that exists; a page PASS cites a screenshot; PASS only when every row passes", () => {
  const job = path.join(root, "job");
  const qa = qaDir(job, 1);
  fs.mkdirSync(qa, { recursive: true });
  const crit = [
    { id: "C1", text: "api", check: "http" as const },
    { id: "C2", text: "page", check: "page" as const },
  ];
  const write = (v: unknown) => fs.writeFileSync(path.join(qa, "verdict.json"), JSON.stringify(v));
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /no readable/);
  fs.writeFileSync(path.join(qa, "c1.http.txt"), "HTTP 200");
  write({ verdict: "PASS", criteria: [{ id: "C1", result: "PASS", evidence: ["c1.http.txt"] }] });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /no row for C2/);
  write({
    verdict: "PASS",
    criteria: [
      { id: "C1", result: "PASS", evidence: ["c1.http.txt"] },
      { id: "C2", result: "PASS", evidence: ["c2.txt"] },
    ],
  });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /C2: evidence c2.txt is missing/);
  fs.writeFileSync(path.join(qa, "c2.txt"), "text");
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /page criterion: its PASS cites a screenshot/);
  write({
    verdict: "PASS",
    criteria: [
      { id: "C1", result: "PASS", evidence: ["../../job.json"] },
      { id: "C2", result: "FAIL", evidence: ["c2.txt"] },
    ],
  });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /outside the QA folder/);
  write({
    verdict: "PASS",
    criteria: [
      { id: "C1", result: "PASS", evidence: ["c1.http.txt"] },
      { id: "C2", result: "FAIL", evidence: ["c2.txt"], note: "no button" },
    ],
  });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /verdict PASS, but a criterion's row is FAIL/);
  write({
    verdict: "FAIL",
    criteria: [
      { id: "C1", result: "PASS", evidence: ["c1.http.txt"] },
      { id: "C2", result: "FAIL", evidence: ["c2.txt"], note: "no button" },
    ],
  });
  assert.equal((readQa(job, 1, crit) as { verdict: string }).verdict, "FAIL");
});

test("the review: it blocks exactly when a finding does; a blocking finding needs its why", () => {
  const job = path.join(root, "rv");
  fs.mkdirSync(path.dirname(reviewFile(job, 1)), { recursive: true });
  fs.writeFileSync(reviewFile(job, 1), JSON.stringify({ findings: [{ id: "F1", blocks: false, why: "naming" }] }));
  assert.equal((readReview(job, 1) as { verdict: string }).verdict, "PASS");
  fs.writeFileSync(reviewFile(job, 1), JSON.stringify({ findings: [{ id: "F1", blocks: true, at: "a.js:3", why: "wrong owner" }] }));
  assert.equal((readReview(job, 1) as { verdict: string }).verdict, "BLOCKING");
  fs.writeFileSync(reviewFile(job, 1), JSON.stringify({ findings: [{ blocks: true }] }));
  assert.ok("refused" in readReview(job, 1));
});

test("high_paths globs", () => {
  assert.equal(matchPath("**/migrations/**", "db/migrations/001.sql"), true);
  assert.equal(matchPath("**/migrations/**", "migrations/001.sql"), true);
  assert.equal(matchPath("infra/**", "src/infra.ts"), false);
  assert.equal(matchPath("**/*payment*", "lib/payments.js"), true);
  assert.equal(matchPath("**/.env*", ".env.local"), true);
});

test("intake's LEFT OUT: line is read for the Report; nothing/none means nothing was left out", () => {
  const job = fs.mkdtempSync(path.join(root, "left-"));
  const write = (v: string) => fs.writeFileSync(path.join(job, "intake.md"), `DECISION: ACCEPT\nLEFT OUT: ${v}\n## Criteria\n- C1 (page): x\n`);
  write("the librarian's add-book form (the ticket names no admin tools)");
  assert.equal(leftOutOf(job), "the librarian's add-book form (the ticket names no admin tools)");
  write("nothing");
  assert.equal(leftOutOf(job), "");
  write("None.");
  assert.equal(leftOutOf(job), "");
  assert.equal(leftOutOf(path.join(root, "no-such-job")), "");
});

test("the QA verdict: a broken map recipe gets its own R-<feature>/<sub-feature> row, and its FAIL fails the verdict", () => {
  const job = path.join(root, "job-r");
  const qa = qaDir(job, 1);
  fs.mkdirSync(qa, { recursive: true });
  const crit = [{ id: "C1", text: "bold count", check: "page" as const }];
  fs.writeFileSync(path.join(qa, "c1.png"), "png");
  fs.writeFileSync(path.join(qa, "search.png"), "png");
  const write = (v: unknown) => fs.writeFileSync(path.join(qa, "verdict.json"), JSON.stringify(v));
  const rows = (r: unknown) => [{ id: "C1", result: "PASS", evidence: ["c1.png"] }, r];
  // The real run's row (job 006): every criterion passed, the search recipe didn't.
  write({ verdict: "FAIL", criteria: rows({ id: "R-search-page", result: "FAIL", evidence: ["search.png"], note: "all 6 rows" }) });
  assert.equal((readQa(job, 1, crit) as { verdict: string }).verdict, "FAIL");
  write({ verdict: "FAIL", criteria: rows({ id: "R-search-books/search-page", result: "FAIL", evidence: ["search.png"] }) });
  assert.equal((readQa(job, 1, crit) as { verdict: string }).verdict, "FAIL");
  write({ verdict: "PASS", criteria: rows({ id: "R-search-books/search-page", result: "FAIL", evidence: ["search.png"] }) });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /verdict PASS, but/);
  write({ verdict: "FAIL", criteria: rows({ id: "R-search-books", result: "FAIL", evidence: [] }) });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /R-SEARCH-BOOKS cites no evidence/);
  write({ verdict: "PASS", criteria: rows({ id: "R-search-books", result: "PASS", evidence: ["search.png"] }) });
  assert.equal((readQa(job, 1, crit) as { verdict: string }).verdict, "PASS");
  write({ verdict: "FAIL", criteria: rows({ id: "X9", result: "FAIL", evidence: ["search.png"] }) });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /C<n>, or R-<feature>/);
});
