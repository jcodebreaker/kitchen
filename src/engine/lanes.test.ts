import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { findingText } from "../inbox/findings.ts";
import {
  consequential,
  criteriaOf,
  givenOf,
  leftOutOf,
  legacyCarried,
  matchPath,
  parseIntake,
  type QaFinding,
  type QaRow,
  type QaVerdict,
  qaDir,
  qaVerdictFile,
  readQa,
  readReview,
  readSecondLook,
  reviewFile,
  secondLookFile,
} from "./lanes.ts";

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
    String(
      (
        parseIntake(`DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n## Criteria\n- C1 (http): GET /items → 200\n${crit}`, { strict: true }) as {
          refused?: string;
        }
      ).refused,
    );
  assert.equal(
    refused("- C2 (page): the list\n- C3 (page + http): both work\n"),
    "C3 (page + http): one kind per criterion: split it into C3 (page) and C4 (http)",
  );
  assert.equal(refused("- C3 (page, http): both\n"), "C3 (page, http): one kind per criterion: split it into C3 (page) and C4 (http)");
  assert.equal(refused("- C5: the list shows\n"), "C5 has no kind: write - C5 (page|http|test|cmd): …");
  assert.equal(refused("- C2 was dropped: the ticket doesn't ask for it\n"), "undefined", "a note naming a criterion is no criterion");
  assert.match(refused("- C2 (page):\n"), /^C2 \(page\) needs what must be true after the colon/);
  assert.match(refused("- C2 (UI): the list\n"), /^C2 \(UI\): the kind is one of page, http, test or cmd/);
  assert.equal(refused("- C1 (page): again\n"), "C1 is listed twice");
  assert.match(refused("- C2 (page) the list\n"), /^C2 \(page\) needs a colon/);
  // Every bad line at once, so one rerun fixes them all.
  assert.equal(refused("- C2: x\n- C1 (http): y\n"), "C2 has no kind: write - C2 (page|http|test|cmd): …; C1 is listed twice");
  const ok = parseIntake(
    "DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n## Criteria\n- C1 (HTTP): GET /items → 200\n- **C2** (Cmd): `make x` prints ok\n- **C3 (page):** the list\n",
    { strict: true },
  );
  assert.deepEqual("decision" in ok && ok.decision === "ACCEPT" && ok.criteria.map((c) => [c.id, c.check, c.text]), [
    ["C1", "http", "GET /items → 200"],
    ["C2", "cmd", "`make x` prints ok"],
    ["C3", "page", "the list"],
  ]);
});

test("intake.md (ADR 0029 §1): an intake accepted before the rule is read leniently: what parses stays, a repeated id keeps its first", () => {
  const job = fs.mkdtempSync(path.join(root, "old-"));
  fs.writeFileSync(
    path.join(job, "intake.md"),
    "DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n## Criteria\n- C1 (http): GET /items → 200\n- C2 (page + http): both\n- C1 (page): again\n- C3 (page): the list\n",
  );
  assert.deepEqual(
    criteriaOf(job).map((c) => `${c.id} ${c.check} ${c.text}`),
    ["C1 http GET /items → 200", "C3 page the list"],
  );
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
  // ADR 0033 §4: missing tooling is why a criterion couldn't run: a tooling finding (no repro) names that NOT_RUN row,
  // and with every NOT_RUN row covered the check is FAIL (done, waiting for the tooling), not INCOMPLETE.
  const tool = { kind: "tooling", title: "a fixture loader", seen: "C2 needs member 4", evidence: ["c2-seed.txt"], criterion: "C2" };
  const refused = (v: unknown) => {
    write(v);
    return String((readQa(job, 1, crit, { check: true }) as { refused?: string }).refused);
  };
  write({ verdict: "FAIL", criteria: [c1, c2], findings: [tool] });
  const t = readQa(job, 1, crit, { check: true }) as QaVerdict;
  assert.deepEqual([t.verdict, t.findings[0]?.kind, t.findings[0]?.repro], ["FAIL", "tooling", []]);
  const { criterion: _, ...noCriterion } = tool;
  assert.match(refused({ verdict: "FAIL", criteria: [c1, c2], findings: [noCriterion] }), /names no criterion/);
  const c2fail = { id: "C2", result: "FAIL", evidence: ["c2-seed.txt"], note: "no member" };
  assert.match(refused({ verdict: "FAIL", criteria: [c1, c2fail], findings: [tool] }), /names C2, which is FAIL: .*covers only a NOT_RUN row/);
  assert.match(refused({ verdict: "FAIL", criteria: [c1, c2], findings: [tool, { ...tool, criterion: "C1" }] }), /names C1, which is PASS/);
  // A NOT_RUN row no tooling covers is run again first (INCOMPLETE), the tooling one with it.
  const c1nr = { id: "C1", result: "NOT_RUN", why: "the service is down", evidence: ["c1.http.txt"] };
  write({ verdict: "FAIL", criteria: [c1nr, c2], findings: [tool] });
  assert.equal((readQa(job, 1, crit, { check: true }) as QaVerdict).verdict, "INCOMPLETE");
  write({ verdict: "FAIL", criteria: [c1nr, c2], findings: [tool, { ...tool, criterion: "C1", title: "a stub service" }] });
  assert.equal((readQa(job, 1, crit, { check: true }) as QaVerdict).verdict, "FAIL", "every NOT_RUN row covered: waits for the tooling");
  // A real FAIL stays FAIL (everything proposed), even beside tooling and a NOT_RUN row nobody covers.
  const c1fail = { id: "C1", result: "FAIL", evidence: ["c1.http.txt"], note: "500" };
  const real = { title: "renew 500", seen: "500", repro: ["renew"], evidence: ["c1.http.txt"], criterion: "C1" };
  const c3nr = { id: "C3", result: "NOT_RUN", why: "the service is down", evidence: ["c2-seed.txt"] };
  write({ verdict: "FAIL", criteria: [c1fail, c2, c3nr], findings: [real, tool] });
  const rf = readQa(job, 1, crit, { check: true }) as QaVerdict;
  assert.deepEqual([rf.verdict, rf.findings.length], ["FAIL", 2]);
  // One finding may cover several rows (criteria), each NOT_RUN.
  const { criterion: _c, ...bare } = tool;
  write({ verdict: "FAIL", criteria: [c1nr, c2], findings: [{ ...bare, criteria: ["c1", "C2"] }] });
  const m = readQa(job, 1, crit, { check: true }) as QaVerdict;
  assert.deepEqual([m.verdict, m.findings[0]?.criterion, m.findings[0]?.criteria], ["FAIL", "C1", ["C1", "C2"]]);
  assert.match(refused({ verdict: "FAIL", criteria: [c1, c2], findings: [{ ...bare, criteria: ["C1", "C2"] }] }), /names C1, which is PASS/);
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
  // The retry round: C1's pass carried (in job state, ADR 0031), QA writes C2 only.
  const qa2 = qaDir(job, 2);
  fs.mkdirSync(path.join(qa2, "from-round-1"), { recursive: true });
  fs.copyFileSync(path.join(qa, "c1.http.txt"), path.join(qa2, "from-round-1", "c1.http.txt"));
  const row1 = { ...c1, result: "PASS" as const, evidence: ["from-round-1/c1.http.txt"] };
  const state = (rows: QaRow[], ids = ["C2"]) => ({ carried: [{ round: 2, from: 1, ids, rows }] });
  fs.writeFileSync(path.join(qa2, "c2.png"), "png");
  write({ verdict: "PASS", criteria: [{ id: "C2", result: "PASS", evidence: ["c2.png"] }] }, qa2);
  const r2 = readQa(job, 2, crit, { job: state([row1]) }) as QaVerdict;
  assert.deepEqual([r2.verdict, r2.criteria.map((r) => `${r.id} ${r.result}`)], ["PASS", ["C2 PASS", "C1 PASS"]]);
  // ADR 0031: a carried.json counts only as an ADR 0029 retry's (upgrade): never after a round that FAILED (Build came
  // between) or for a criterion that round didn't pass.
  fs.writeFileSync(path.join(qa2, "carried.json"), JSON.stringify([row1]));
  write({ verdict: "FAIL", criteria: [c1, { id: "C2", result: "FAIL", evidence: ["c2-seed.txt"] }] });
  assert.equal(legacyCarried(job, 2), undefined);
  assert.equal((readQa(job, 2, crit) as { refused: string }).refused, "no row for C1");
  write({ verdict: "FAIL", criteria: [{ ...c1, result: "NOT_RUN", why: "down" }, c2] });
  assert.equal((readQa(job, 2, crit) as { refused: string }).refused, "no row for C1", "round 1 didn't pass C1");
  write({ verdict: "FAIL", criteria: [c1, c2] });
  assert.deepEqual(legacyCarried(job, 2, { qaRetry: { from: 1, ids: ["C2"] } }), { round: 2, from: 1, ids: ["C2"], rows: [row1] });
  assert.equal((readQa(job, 2, crit) as QaVerdict).verdict, "PASS", "a 0029 retry's carry, read as one");
  fs.rmSync(path.join(qa2, "carried.json"));
  // Job state is checked too: never a retried id, every file round 1's copy.
  assert.match(
    String((readQa(job, 2, crit, { job: state([row1], ["C1", "C2"]) }) as { refused: string }).refused),
    /C1 is carried from round 1, but this round tests it again/,
  );
  assert.match(
    String((readQa(job, 2, crit, { job: state([{ ...row1, evidence: ["c2.png"] }]) }) as { refused: string }).refused),
    /C1's carried evidence c2.png isn't round 1's copy \(from-round-1\/\)/,
  );
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

test("ADR 0031 §4: a criterion may name its precondition (· given: <state>); an empty one is refused", () => {
  const i = parseIntake(
    "DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n## Criteria\n- C1 (http): renewing is refused with 409 · given: ana has an overdue loan\n- C2 (page): /todos lists nothing\n",
  );
  assert.ok("decision" in i && i.decision === "ACCEPT");
  assert.deepEqual(i.criteria, [
    { id: "C1", text: "renewing is refused with 409", check: "http", given: "ana has an overdue loan" },
    { id: "C2", text: "/todos lists nothing", check: "page" },
  ]);
  // Only ` · given: `, exactly, at its last occurrence: a claim's own `;`, `|` or "Given:" stays in the claim.
  assert.deepEqual(givenOf("the note reads a; given: b"), { text: "the note reads a; given: b" });
  assert.deepEqual(givenOf("GET /x returns a|given: header"), { text: "GET /x returns a|given: header" });
  assert.deepEqual(givenOf("the label says · Given: x"), { text: "the label says · Given: x" });
  assert.deepEqual(givenOf("shows `· given: a` · given: two todos"), { text: "shows `· given: a`", given: "two todos" });
  const bare = "DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n- C1 (page): the badge shows · given: a loan is overdue\n";
  for (const strict of [true, false]) {
    const p = parseIntake(bare, { strict });
    assert.ok("criteria" in p, `strict ${strict}`);
    assert.deepEqual(p.criteria, [{ id: "C1", text: "the badge shows", check: "page", given: "a loan is overdue" }], `strict ${strict}`);
  }
  const empty = "DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n- C1 (http): refused · given:\n- C2 (http): · given: a loan\n- C3 (http): allowed\n";
  const r = parseIntake(empty, { strict: true }) as { refused: string };
  assert.match(r.refused, /C1: given: names the state the claim needs/);
  assert.match(r.refused, /C2 \(http\) needs what must be true before given/);
  // Lenient (an intake accepted earlier): the lines that parse, as for any malformed criterion (ADR 0029 §1).
  const lenient = parseIntake(empty);
  assert.ok("criteria" in lenient);
  assert.deepEqual(
    lenient.criteria.map((c) => c.id),
    ["C3"],
  );
});

test("ADR 0031: readQa refuses an unshown precondition, a confirmed cause without its evidence, and a capture from another round, job or commit", () => {
  const job = path.join(root, "031-honest");
  const qa = qaDir(job, 2);
  fs.mkdirSync(qa, { recursive: true });
  const crit = [{ id: "C1", text: "renewing is refused", check: "http" as const, given: "ana has an overdue loan" }];
  const write = (v: unknown) => fs.writeFileSync(path.join(qa, "verdict.json"), JSON.stringify(v));
  const refused = (o: { check?: boolean; sha?: string } = {}) => String((readQa(job, 2, crit, { ...o, strict: true }) as { refused?: string }).refused);
  const stamp = (f: string, m: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(qa, `${f}.meta.json`),
      JSON.stringify({ job: "031-honest", round: 2, sha: "a".repeat(40), dirty: false, url: "", app: null, at: "", ...m }),
    );
  for (const f of ["c1.http.txt", "c1-given.http.txt", "seed.txt", "app.log"]) fs.writeFileSync(path.join(qa, f), "x");
  const row = (given?: unknown) => ({ id: "C1", result: "FAIL", evidence: ["c1.http.txt"], note: "200, expected 409", ...(given ? { given } : {}) });
  // §4: a PASS or FAIL row shows the precondition held, through a kitchen qa capture.
  write({ verdict: "FAIL", criteria: [row()] });
  assert.match(refused(), /C1 needs given: .*"ana has an overdue loan" held, read back through the app/);
  write({ verdict: "FAIL", criteria: [row({ evidence: ["seed.txt"], note: "the seed adds one" })] });
  assert.match(refused(), /C1: given cites no kitchen qa capture: .*seed or reset output alone/);
  stamp("c1-given.http.txt", {});
  write({ verdict: "FAIL", criteria: [row({ evidence: ["c1-given.http.txt"], note: "loan 4 due 2026-11-01" })] });
  const ok = readQa(job, 2, crit) as { verdict: string; criteria: { given?: unknown }[] };
  assert.equal(ok.verdict, "FAIL");
  assert.deepEqual(ok.criteria[0].given, { evidence: ["c1-given.http.txt"], note: "loan 4 due 2026-11-01" });
  write({ verdict: "FAIL", criteria: [row(["c1-given.http.txt"])] });
  assert.equal((readQa(job, 2, crit) as { verdict: string }).verdict, "FAIL", "given as a plain list");
  // Any row's given evidence is a file in the QA folder, even a criterion's with no given (the Report inlines it).
  write({ verdict: "FAIL", criteria: [row(["c1-given.http.txt"]), { id: "C2", result: "PASS", evidence: ["seed.txt"], given: ["../../../etc/hosts"] }] });
  assert.equal(refused(), "C2: given evidence ../../../etc/hosts is missing, empty or outside the QA folder");
  write({ verdict: "FAIL", criteria: [row(["c1-given.http.txt"])] });
  // §2: a stamp names this job, this round and the head QA drove; a file with no stamp (made by hand) is allowed.
  assert.equal((readQa(job, 2, crit, { sha: "a".repeat(40) }) as { verdict: string }).verdict, "FAIL");
  assert.equal(refused({ sha: "b".repeat(40) }), "C1 cites a capture from another commit: c1-given.http.txt was taken on aaaaaaa, QA's checkout is at bbbbbbb");
  stamp("c1.http.txt", { round: 1 });
  assert.equal(refused(), "C1 cites a capture from another round: c1.http.txt was taken in round 1, this is round 2");
  stamp("c1.http.txt", { job: "007-other" });
  assert.equal(refused(), "C1 cites a capture from another job: c1.http.txt was taken for 007-other, this is 031-honest");
  fs.rmSync(path.join(qa, "c1.http.txt.meta.json"));
  // §1: a finding's expected, cause and severity; a confirmed cause cites evidence beyond the symptom's.
  const finding = (x: Record<string, unknown>) =>
    write({
      verdict: "FAIL",
      criteria: [row(["c1-given.http.txt"])],
      findings: [{ title: "Renew ignores overdue", seen: "200 on an overdue loan", repro: ["renew loan 4"], evidence: ["c1.http.txt"], criterion: "C1", ...x }],
    });
  finding({ expected: "409", cause: { text: "the overdue check runs after the save", confidence: "confirmed", evidence: ["c1.http.txt"] } });
  assert.match(refused({ check: true }), /finding 1 \(Renew ignores overdue\): a confirmed cause cites evidence that shows the cause .*or say suspected/);
  finding({ cause: { text: "x", confidence: "sure" } });
  assert.match(refused({ check: true }), /cause.confidence is suspected or confirmed/);
  finding({ severity: "urgent" });
  assert.match(refused({ check: true }), /severity is low, medium or high/);
  stamp("app.log", { round: 1 });
  finding({ cause: { text: "x", confidence: "confirmed", evidence: ["app.log"] } });
  assert.match(refused({ check: true }), /^finding 1 \(Renew ignores overdue\) cites a capture from another round: app.log/);
  fs.rmSync(path.join(qa, "app.log.meta.json"));
  assert.deepEqual((readQa(job, 2, crit, { check: true }) as { findings: QaFinding[] }).findings[0], {
    title: "Renew ignores overdue",
    seen: "200 on an overdue loan",
    repro: ["renew loan 4"],
    evidence: ["c1.http.txt"],
    criterion: "C1",
    cause: { text: "x", confidence: "confirmed", evidence: ["app.log"] },
  });
  // Lenient (the Report, proposing again): what can't be read is left out; an unproven confirmed cause is suspected.
  finding({ severity: "urgent", cause: { text: "late", confidence: "confirmed", evidence: ["c1.http.txt"] } });
  const lenient = (readQa(job, 2, crit, { check: true }) as { findings: QaFinding[] }).findings[0];
  assert.deepEqual([lenient.severity, lenient.cause], [undefined, { text: "late", confidence: "suspected", evidence: ["c1.http.txt"] }]);
  finding({ expected: 409 });
  assert.match(refused({ check: true }), /expected is a sentence \(a string\)/);
  finding({ cause: ["the check runs late"] });
  assert.match(refused({ check: true }), /cause is a sentence or \{ text, confidence, evidence \}/);
  assert.equal((readQa(job, 2, crit, { check: true }) as { findings: QaFinding[] }).findings[0].cause, undefined, "leniently: left out");
  finding({ cause: { confidence: "confirmed" } });
  assert.match(refused({ check: true }), /cause needs text/);
  assert.equal((readQa(job, 2, crit, { check: true }) as { findings: QaFinding[] }).findings[0].cause, undefined);
  finding({ expected: "409", cause: "the check runs late", severity: "HIGH" });
  const s = (readQa(job, 2, crit, { check: true }) as { findings: QaFinding[] }).findings[0];
  assert.deepEqual([s.expected, s.cause, s.severity], ["409", { text: "the check runs late", confidence: "suspected" }, "high"]);
  assert.equal(findingText(s), "Seen: 200 on an overdue loan\nExpected: 409\nSuspected cause: the check runs late");
  finding({});
  const old = (readQa(job, 2, crit, { check: true }) as { findings: QaFinding[] }).findings[0];
  assert.equal(findingText(old), "200 on an overdue loan", "an older finding is its seen alone");
});

test("ADR 0031 with ADR 0029's retry: a mixed round (C1 PASS, C2 NOT_RUN) retried; C1's carried capture and its stamp stand", () => {
  const job = path.join(root, "031-carry");
  const sha = "a".repeat(40);
  const crit = [
    { id: "C1", text: "the list shows", check: "page" as const, given: "two todos exist" },
    { id: "C2", text: "renewing is refused", check: "http" as const, given: "a loan is overdue" },
  ];
  const capture = (dir: string, f: string, round: number) => {
    fs.writeFileSync(path.join(dir, f), "x");
    fs.writeFileSync(path.join(dir, `${f}.meta.json`), JSON.stringify({ job: "031-carry", round, sha, dirty: false, url: "", app: null, at: "" }));
  };
  const qa1 = qaDir(job, 1);
  fs.mkdirSync(qa1, { recursive: true });
  for (const f of ["c1.png", "c1-given.txt", "c2-given.http.txt"]) capture(qa1, f, 1);
  const c1 = { id: "C1", result: "PASS", evidence: ["c1.png"], note: "two rows", given: { evidence: ["c1-given.txt"], note: "two todos" } };
  // A given that doesn't hold is NOT_RUN with why: the given rule skips it, and it is never a FAIL.
  const c2 = { id: "C2", result: "NOT_RUN", why: "no overdue loan in the seed", evidence: ["c2-given.http.txt"] };
  fs.writeFileSync(qaVerdictFile(job, 1), JSON.stringify({ verdict: "FAIL", criteria: [c1, c2] }));
  assert.equal((readQa(job, 1, crit, { sha }) as QaVerdict).verdict, "INCOMPLETE");
  // Round 2: Kitchen carried C1 (its captures and their round-1 stamps under from-round-1/); QA writes C2 only.
  const qa2 = qaDir(job, 2);
  fs.mkdirSync(path.join(qa2, "from-round-1"), { recursive: true });
  for (const f of ["c1.png", "c1-given.txt"]) {
    fs.copyFileSync(path.join(qa1, f), path.join(qa2, "from-round-1", f));
    fs.copyFileSync(path.join(qa1, `${f}.meta.json`), path.join(qa2, "from-round-1", `${f}.meta.json`));
  }
  const carried = { ...c1, result: "PASS" as const, evidence: ["from-round-1/c1.png"], given: { evidence: ["from-round-1/c1-given.txt"], note: "two todos" } };
  const state = { carried: [{ round: 2, from: 1, ids: ["C2"], rows: [carried] }] };
  for (const f of ["c2.http.txt", "c2-given.http.txt"]) capture(qa2, f, 2);
  const c2pass = { id: "C2", result: "PASS", evidence: ["c2.http.txt"], note: "409", given: { evidence: ["c2-given.http.txt"], note: "loan 4 overdue" } };
  fs.writeFileSync(qaVerdictFile(job, 2), JSON.stringify({ verdict: "PASS", criteria: [c2pass] }));
  const v2 = readQa(job, 2, crit, { sha, job: state }) as QaVerdict;
  assert.deepEqual(
    [v2.verdict, v2.criteria.map((r) => `${r.id} ${r.result} ${r.evidence.join(",")}`)],
    ["PASS", ["C2 PASS c2.http.txt", "C1 PASS from-round-1/c1.png"]],
  );
  // Only a carried row is exempt: QA citing the round-1 capture in a row of its own is refused.
  fs.writeFileSync(qaVerdictFile(job, 2), JSON.stringify({ verdict: "PASS", criteria: [c2pass, carried] }));
  assert.equal(
    (readQa(job, 2, crit, { sha, job: state }) as { refused: string }).refused,
    "C1 cites a capture from another round: from-round-1/c1.png was taken in round 1, this is round 2",
  );
  // A carried capture whose stamp isn't round 1's is refused.
  fs.writeFileSync(qaVerdictFile(job, 2), JSON.stringify({ verdict: "PASS", criteria: [c2pass] }));
  capture(path.join(qa2, "from-round-1"), "c1.png", 2);
  assert.equal((readQa(job, 2, crit, { sha, job: state }) as { refused: string }).refused, "C1's carried capture from-round-1/c1.png wasn't taken in round 1");
});

test("ADR 0031 §5: which findings get a second look, and its answers", () => {
  assert.deepEqual(consequential([{ severity: "high" }, {}, { severity: "low" }], "low"), [1]);
  assert.deepEqual(consequential([{ severity: "high" }, {}], "high"), [1, 2], "a high-risk check: every finding");
  assert.deepEqual(consequential([{ severity: "high", kind: "tooling" }, { severity: "high" }], "high"), [2], "ADR 0033: tooling never gets a second look");
  const job = path.join(root, "031-look");
  fs.mkdirSync(path.dirname(secondLookFile(job, 1)), { recursive: true });
  const write = (v: unknown) => fs.writeFileSync(secondLookFile(job, 1), JSON.stringify(v));
  assert.match(String((readSecondLook(job, 1, [1]) as { refused: string }).refused), /no readable/);
  write({ findings: [{ finding: 1, confirmed: true, note: "holds" }] });
  assert.match(String((readSecondLook(job, 1, [1, 2]) as { refused: string }).refused), /no answer for finding 2/);
  write({ findings: [{ finding: 1, confirmed: "yes", note: "holds" }] });
  assert.match(String((readSecondLook(job, 1, [1]) as { refused: string }).refused), /confirmed is true or false/);
  write({ findings: [{ finding: 1, confirmed: false }] });
  assert.match(String((readSecondLook(job, 1, [1]) as { refused: string }).refused), /a note says why/);
  write({ findings: [{ finding: 2, confirmed: false, note: "the page hadn't loaded" }] });
  assert.deepEqual(readSecondLook(job, 1, [2]), [{ finding: 2, confirmed: false, note: "the page hadn't loaded" }]);
});
