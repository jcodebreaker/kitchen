import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { carriedFile, leftOutOf, matchPath, parseIntake, type QaVerdict, qaDir, readQa, readReview, reviewFile } from "./lanes.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-lanes-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("intake.md: ACCEPT needs criteria with a check kind; NEEDS-INFO needs its question; anything else is refused", () => {
  const ok = parseIntake(
    "DECISION: ACCEPT\nTITLE: Renew a loan\nKIND: feature\nRISK: medium\nSURFACES: ui, none\nFILES: server.js, `lib/loans.js`\nAFTER: 3, 004-x\n\n## Criteria\n- C1 (http): POST /loans/1/renew → 200\n- **C2** (Page): /loans shows renewed\n",
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

test("intake.md (ADR 0029 §1): a criterion line that can't be read refuses the intake with the line and the fix; kinds in any case", () => {
  const refused = (crit: string) =>
    String((parseIntake(`DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n## Criteria\n- C1 (http): GET /items → 200\n${crit}`) as { refused?: string }).refused);
  assert.equal(
    refused("- C2 (page): the list\n- C3 (page + http): both work\n"),
    "C3 (page + http): one kind per criterion: split it into C3 (page) and C4 (http)",
  );
  assert.equal(refused("- C3 (page, http): both\n"), "C3 (page, http): one kind per criterion: split it into C3 (page) and C4 (http)");
  assert.equal(refused("- C5: the list shows\n"), "C5 has no kind: write - C5 (page|http|test|cmd): …");
  assert.equal(refused("- **C5** the list shows\n"), "C5 has no kind: write - C5 (page|http|test|cmd): …");
  assert.match(refused("- C2 (UI): the list\n"), /^C2 \(UI\): the kind is one of page, http, test or cmd/);
  assert.equal(refused("- C1 (page): again\n"), "C1 is listed twice");
  assert.match(refused("- C2 (page) the list\n"), /^C2 \(page\) needs a colon/);
  // Every bad line at once, so one rerun fixes them all.
  assert.equal(refused("- C2: x\n- C1 (http): y\n"), "C2 has no kind: write - C2 (page|http|test|cmd): …; C1 is listed twice");
  const ok = parseIntake("DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n## Criteria\n- C1 (HTTP): GET /items → 200\n- **C2** (Cmd): `make x` prints ok\n");
  assert.deepEqual("decision" in ok && ok.decision === "ACCEPT" && ok.criteria.map((c) => [c.id, c.check]), [
    ["C1", "http"],
    ["C2", "cmd"],
  ]);
});

test("intake.md ACCEPT (ADR 0020): the `- ` lines under ## Later slices are its slices, none when it has none", () => {
  const base = "DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n## Criteria\n- C1 (http): GET /loans → 200\n";
  const i = parseIntake(`${base}\n## Later slices\n- Lena can mark an overdue loan returned\n- members get an email\n\n## Notes\n- not this\n`);
  assert.deepEqual("decision" in i && i.decision === "ACCEPT" && i.slices, ["Lena can mark an overdue loan returned", "members get an email"]);
  const none = parseIntake(base);
  assert.deepEqual("decision" in none && none.decision === "ACCEPT" && none.slices, []);
});

test("intake.md REFINE (ADR 0020): a REASON from the four and at least one line under ## Refine", () => {
  assert.deepEqual(
    parseIntake("DECISION: REFINE\nTITLE: Overdue\nREASON: too big: three jobs\n\n## Refine\n- 1: the flag\n- 2: the page\n\n## Notes\n- not this\n"),
    {
      decision: "REFINE",
      reason: "too-big",
      items: ["1: the flag", "2: the page"],
      title: "Overdue",
    },
  );
  assert.match(String((parseIntake("DECISION: REFINE\nREASON: vague\n## Refine\n- A\n") as { refused: string }).refused), /REASON: readings \| too-big/);
  assert.match(String((parseIntake("DECISION: REFINE\nREASON: readings\n") as { refused: string }).refused), /## Refine/);
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

test("the QA verdict (ADR 0029 §2): a row may be NOT_RUN with why; no FAIL makes the round INCOMPLETE; BLOCKED is every row NOT_RUN; carried passes stand", () => {
  const job = path.join(root, "job-b");
  const qa = qaDir(job, 1);
  fs.mkdirSync(qa, { recursive: true });
  const crit = [
    { id: "C1", text: "api", check: "http" as const },
    { id: "C2", text: "page", check: "page" as const },
  ];
  const write = (v: unknown, d = qa) => fs.writeFileSync(path.join(d, "verdict.json"), JSON.stringify(v));
  fs.writeFileSync(path.join(qa, "c1.http.txt"), "HTTP 200");
  fs.writeFileSync(path.join(qa, "c2-seed.txt"), "no member 4 in the seed");
  const c1 = { id: "C1", result: "PASS", evidence: ["c1.http.txt"], note: "200" };
  write({ verdict: "FAIL", criteria: [c1, { id: "C2", result: "NOT_RUN", evidence: ["c2-seed.txt"] }] });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /C2 is NOT_RUN: say why/);
  const c2 = { id: "C2", result: "not run", why: "the seed has no member 4", evidence: ["c2-seed.txt"] };
  write({ verdict: "FAIL", criteria: [c1, c2] });
  const v = readQa(job, 1, crit) as QaVerdict;
  assert.equal(v.verdict, "INCOMPLETE");
  assert.deepEqual(v.criteria[1], { id: "C2", result: "NOT_RUN", why: "the seed has no member 4", evidence: ["c2-seed.txt"], note: "" });
  write({ verdict: "PASS", criteria: [c1, c2] });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /verdict PASS, but a criterion's row is NOT_RUN/);
  write({ verdict: "FAIL", criteria: [{ ...c1, result: "FAIL" }, c2] });
  assert.equal((readQa(job, 1, crit) as QaVerdict).verdict, "FAIL", "any FAIL is FAIL");
  // A check: a NOT_RUN is never a finding.
  write({ verdict: "FAIL", criteria: [c1, c2], findings: [{ title: "x", seen: "y", repro: ["z"], evidence: ["c2-seed.txt"], criterion: "C2" }] });
  assert.match(String((readQa(job, 1, crit, { check: true }) as { refused: string }).refused), /names C2, which was NOT_RUN/);
  // BLOCKED: every row NOT_RUN with its why.
  write({ verdict: "BLOCKED", blocked: "the app won't start", evidence: ["app.log"] });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /evidence app\.log is missing/);
  fs.writeFileSync(path.join(qa, "app.log"), "EADDRINUSE");
  const b = readQa(job, 1, crit) as QaVerdict;
  assert.deepEqual(
    [b.verdict, b.blocked, b.criteria.map((r) => `${r.id} ${r.result} ${r.why}`)],
    ["INCOMPLETE", "the app won't start", ["C1 NOT_RUN the app won't start", "C2 NOT_RUN the app won't start"]],
  );
  write({ verdict: "BLOCKED", evidence: ["app.log"] });
  assert.match(String((readQa(job, 1, crit) as { refused: string }).refused), /says why in blocked/);
  // The retry round: C1's pass carried (Kitchen's carried.json), QA writes C2 only.
  const qa2 = qaDir(job, 2);
  fs.mkdirSync(path.join(qa2, "from-round-1"), { recursive: true });
  fs.copyFileSync(path.join(qa, "c1.http.txt"), path.join(qa2, "from-round-1", "c1.http.txt"));
  fs.writeFileSync(carriedFile(qa2), JSON.stringify([{ ...c1, evidence: ["from-round-1/c1.http.txt"] }]));
  fs.writeFileSync(path.join(qa2, "c2.png"), "png");
  write({ verdict: "PASS", criteria: [{ id: "C2", result: "PASS", evidence: ["c2.png"] }] }, qa2);
  const r2 = readQa(job, 2, crit) as QaVerdict;
  assert.deepEqual([r2.verdict, r2.criteria.map((r) => `${r.id} ${r.result}`)], ["PASS", ["C2 PASS", "C1 PASS"]]);
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
