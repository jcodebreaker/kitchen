import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type Anchors,
  anchorProblem,
  changedLines,
  dedupe,
  dismissedBy,
  fixableAnchors,
  judge,
  lensStats,
  parseAt,
  parseFindings,
  renderReview,
  similarTitles,
  unparseable,
  verdictOf,
  viewsOf,
} from "./findings.ts";

const HEAD = "h".repeat(40);
const anchors: Anchors = {
  lines: (f) => ({ "server.js": 120, "db/003_owner.sql": 4, "README.md": 30 })[f] ?? null,
  changed: (f) => ({ "server.js": [86, 87, 88, 12], "db/003_owner.sql": [1, 2, 3, 4] })[f] ?? [],
  requirements: ["R1", "R2", "R3"],
  unproven: ["R3"],
  evidence: [
    { id: "e1", sha: "old" },
    { id: "e2", sha: HEAD, phase: "base" },
    { id: "e14", sha: HEAD, criterion: "C2", role: "engine" },
    { id: "e15", sha: HEAD, criterion: "C1", role: "verifier" },
    { id: "e20", sha: HEAD, criterion: "view:code", role: "reviewer-code" },
    { id: "e21", sha: HEAD, criterion: "view:ux", role: "reviewer-ux" },
    { id: "e22", sha: HEAD, criterion: "view:code", role: "reviewer-ux" },
  ],
  criteria: [
    { id: "C1", covers: ["R1"] },
    { id: "C2", covers: ["R2"] },
    { id: "C3", covers: ["R3"] },
  ],
  head: HEAD,
};

const CODE = `VERDICT: BLOCKING

### F1: regular users see every project
- kind: blocking
- confidence: high
- at: server.js:88
- requirement: R3
- why: the query has no owner condition

### F2: helper name is vague
- kind: note
- confidence: medium

### F3: owner leaks to regular users
- kind: blocking
- confidence: medium
- at: \`server.js\` line 999
- why: past the end

### F4: might be slow
- kind: blocking
- confidence: low
- at: server.js:12
`;

const base = { id: "x", lens: "code", title: "t", kind: "blocking" as const, confidence: "high" as const, evidence: [] as string[], why: "" };

test("findings parse: kind, confidence, anchors; unclear kind is a note, unclear confidence low", () => {
  const f = parseFindings(CODE, "code", 2);
  assert.deepEqual(
    f.map((x) => [x.id, x.kind, x.confidence, x.at?.line, x.requirement]),
    [
      ["code-2-1", "blocking", "high", 88, "R3"],
      ["code-2-2", "note", "medium", undefined, undefined],
      ["code-2-3", "blocking", "medium", 999, undefined],
      ["code-2-4", "blocking", "low", 12, undefined],
    ],
  );
  const odd = parseFindings("### F1: x\n- kind: maybe blocking?\n- confidence: very\n", "ux", 1)[0];
  assert.equal(odd.kind, "note");
  assert.equal(odd.confidence, "low");
  assert.equal(verdictOf(CODE), "BLOCKING");
});

test("file:line shapes; a whole file is not a line", () => {
  assert.deepEqual(parseAt("server.js:42"), { file: "server.js", line: 42 });
  assert.deepEqual(parseAt("`src/a.ts:12-14`"), { file: "src/a.ts", line: 12 });
  assert.deepEqual(parseAt("./server.js line 7"), { file: "server.js", line: 7 });
  assert.equal(parseAt("server.js"), null);
  assert.equal(parseAt("the login handler"), null);
});

test("only a demonstrable, confident blocking finding blocks", () => {
  const j = judge(parseFindings(CODE, "code", 2), anchors);
  assert.deepEqual(
    j.map((x) => x.blocks),
    [true, false, false, false],
  );
  assert.match(j[2].downgraded ?? "", /not demonstrable: server\.js:999 is past the end of the file \(120 lines\)/);
  assert.match(j[3].downgraded ?? "", /low confidence never blocks/);
});

test("anchors: none at all, an unknown file, an out-of-scope requirement, an id not in the manifest or not for HEAD", () => {
  assert.match(anchorProblem(base, anchors) ?? "", /names no line, requirement or evidence/);
  assert.match(anchorProblem({ ...base, at: { file: "nope.js", line: 1 } }, anchors) ?? "", /not a tracked file/);
  assert.match(anchorProblem({ ...base, requirement: "R9" }, anchors) ?? "", /R9 is not a requirement in scope/);
  assert.match(anchorProblem({ ...base, evidence: ["e14", "e99"] }, anchors) ?? "", /evidence e99 is not in this job's manifest/);
  assert.match(anchorProblem({ ...base, evidence: ["e1"] }, anchors) ?? "", /e1 is not stamped for HEAD/);
  assert.match(anchorProblem({ ...base, evidence: ["e2"] }, anchors) ?? "", /e2 is not stamped for HEAD/, "a base-phase run shows the base, not the change");
  assert.match(anchorProblem({ ...base, atRaw: "the router" }, anchors) ?? "", /is not file:line/);
  assert.equal(anchorProblem({ ...base, evidence: ["e14"] }, anchors), null, "evidence for HEAD is demonstrable");
});

test("an at: anchor must be in this change (within 3 lines of a changed line)", () => {
  assert.equal(anchorProblem({ ...base, at: { file: "server.js", line: 91 } }, anchors), null, "3 lines after a changed line");
  assert.match(
    anchorProblem({ ...base, at: { file: "server.js", line: 92 } }, anchors) ?? "",
    /server\.js:92 is not in this change \(the diff changed lines 12, 86-88/,
  );
  assert.match(
    anchorProblem({ ...base, at: { file: "README.md", line: 5 } }, anchors) ?? "",
    /README\.md:5 is not in this change \(the diff doesn't touch README\.md\)/,
  );
});

test("a requirement-only finding blocks only when its criteria are all NON-DISCRIMINATING, or with evidence", () => {
  assert.match(anchorProblem({ ...base, requirement: "R2" }, anchors) ?? "", /R2 alone: its criteria passed and discriminate/);
  assert.equal(anchorProblem({ ...base, requirement: "R3" }, anchors), null, "R3's criteria all held on the base: unproven");
  assert.equal(anchorProblem({ ...base, requirement: "R2", evidence: ["e14"] }, anchors), null);
  assert.equal(anchorProblem({ ...base, requirement: "R2", at: { file: "server.js", line: 87 } }, anchors), null);
});

test("a requirement-only finding's evidence must be about it: this lens's own view, or a run of a criterion covering the requirement", () => {
  assert.equal(anchorProblem({ ...base, requirement: "R2", evidence: ["e14"] }, anchors), null, "C2 covers R2");
  assert.equal(anchorProblem({ ...base, requirement: "R2", evidence: ["e20"] }, anchors), null, "the code lens's own view");
  assert.match(
    anchorProblem({ ...base, requirement: "R2", evidence: ["e15"] }, anchors) ?? "",
    /^evidence e15 doesn't show R2: it is neither a view this lens asked for \(view:code\) nor a run for a criterion covering R2$/,
    "a PASS of C1 (R1) shows nothing about R2",
  );
  assert.match(anchorProblem({ ...base, requirement: "R2", evidence: ["e21"] }, anchors) ?? "", /evidence e21 doesn't show R2/, "another lens's view");
  assert.match(
    anchorProblem({ ...base, requirement: "R2", evidence: ["e22"] }, anchors) ?? "",
    /evidence e22 doesn't show R2/,
    "view:code not run as reviewer-code",
  );
  assert.match(anchorProblem({ ...base, requirement: "R2", evidence: ["e14", "e15"] }, anchors) ?? "", /^evidence e15 doesn't show/, "every id must hold");
  assert.equal(anchorProblem({ ...base, requirement: "R1", evidence: ["e15"] }, anchors), null);
  assert.equal(anchorProblem({ ...base, lens: "ux", requirement: "R2", evidence: ["e21"] }, anchors), null, "the ux lens's own view");
  assert.equal(
    anchorProblem({ ...base, requirement: "R2", at: { file: "server.js", line: 87 }, evidence: ["e15"] }, anchors),
    null,
    "with a line in the change, the line carries it",
  );
  const [j] = judge([{ ...base, requirement: "R2", evidence: ["e15"] }], anchors);
  assert.equal(j.blocks, false);
  assert.match(j.downgraded ?? "", /^not demonstrable: evidence e15 doesn't show R2/);
});

test("changed lines from a diff: added lines and where a removal happened, per file (new side)", () => {
  const patch = `diff --git a/server.js b/server.js
index 1..2 100644
--- a/server.js
+++ b/server.js
@@ -10,4 +10,5 @@ x
 a
-b
+B
+C
 d
diff --git a/old.js b/old.js
deleted file mode 100644
--- a/old.js
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+one
+two
`;
  const c = changedLines(patch);
  assert.deepEqual(c.get("server.js"), [11, 11, 12]);
  assert.deepEqual(c.get("new.md"), [1, 2]);
  assert.equal(c.has("old.js"), false);
});

test("a fixable anchor (not file:line, no such file, past the end) gets a re-ask; one outside the change doesn't", () => {
  const f = parseFindings(CODE, "code", 2);
  assert.deepEqual(
    fixableAnchors(f, anchors).map((x) => x.finding.id),
    ["code-2-3"],
  );
  const out = parseFindings("### F1: x\n- kind: blocking\n- confidence: high\n- at: README.md:3\n", "code", 1);
  assert.deepEqual(fixableAnchors(out, anchors), []);
});

test("VERDICT: BLOCKING without a readable blocking finding is unparseable", () => {
  assert.match(unparseable("VERDICT: BLOCKING\n\nThe owner leaks on line 88.", []) ?? "", /no `### F<n>: <title>` finding block/);
  const notes = parseFindings("VERDICT: BLOCKING\n### F1: x\n- kind: note\n", "code", 1);
  assert.match(unparseable("VERDICT: BLOCKING\n### F1: x\n- kind: note\n", notes) ?? "", /none of its 1 finding/);
  assert.equal(unparseable(CODE, parseFindings(CODE, "code", 1)), null);
  assert.equal(unparseable("VERDICT: PASS", []), null);
});

test("a dismissed finding raised again by the same lens on the same anchor is a note", () => {
  const d = [{ finding: "code-1-1", lens: "code", round: 1, by: "alice", reason: "intended", at: { file: "server.js", line: 87 } }];
  const j = judge(parseFindings(CODE, "code", 2), anchors, d);
  assert.equal(j[0].blocks, false);
  assert.match(j[0].downgraded ?? "", /^dismissed by alice \(code-1-1\): intended/);
  const other = judge(parseFindings(CODE, "security", 2), anchors, d);
  assert.equal(other[0].blocks, true, "another lens on the same line is not the dismissed finding");
  assert.equal(lensStats("code", "BLOCKING", j, dedupe(j)).redismissed, 1);
});

test("re-raise: same lens and the same line (±1), or the same requirement in similar words; a different finding nearby is not muted", () => {
  const d = [
    {
      finding: "code-1-6",
      lens: "code",
      round: 1,
      by: "alice",
      reason: null,
      title: "the saved theme is never read back after the update",
      at: { file: "server.js", line: 87 },
      requirement: "R1",
    },
  ];
  const f = (o: Partial<Parameters<typeof dismissedBy>[0]>) => dismissedBy({ ...base, ...o }, d)?.finding;
  assert.equal(f({ title: "anything", at: { file: "server.js", line: 88 } }), "code-1-6", "same line ±1");
  assert.equal(f({ title: "theme column takes any string", at: { file: "server.js", line: 90 } }), undefined, "3 lines away: a different finding");
  assert.equal(f({ title: "the saved theme is still never read back", requirement: "R1" }), "code-1-6", "same requirement, similar title");
  assert.equal(f({ title: "the saved theme is still never read back", requirement: "R1", at: { file: "server.js", line: 120 } }), "code-1-6");
  assert.equal(f({ title: "the toggle has no label", requirement: "R1" }), undefined, "same requirement, another problem");
  assert.equal(f({ title: "the saved theme is still never read back", requirement: "R2" }), undefined, "another requirement");
  assert.equal(
    f({ lens: "security", title: "the saved theme is never read back after the update", at: { file: "server.js", line: 87 }, requirement: "R1" }),
    undefined,
    "another lens",
  );
  assert.equal(similarTitles("the saved theme is never read back after the update", "the saved theme is still never read back"), true);
  assert.equal(similarTitles("the theme update doesn't check the value it stores", "the saved theme is never read back after the update"), false);
  assert.equal(similarTitles("", "x"), false);
});

test("the same line (±1) from two lenses is one finding that keeps both; distinct findings on one requirement all stay", () => {
  const sec = `VERDICT: BLOCKING\n\n### F1: missing owner check\n- kind: blocking\n- confidence: high\n- at: server.js:87\n- why: no WHERE owner_id\n\n### F2: R2 not met\n- kind: note\n- confidence: medium\n- requirement: R2\n`;
  const ux = `VERDICT: PASS\n\n### F1: owner column visible\n- kind: note\n- confidence: high\n- requirement: R2\n- evidence: e14\n\n### F2: empty state missing\n- kind: blocking\n- confidence: high\n- requirement: R3\n- why: no empty state\n`;
  const j = judge([...parseFindings(CODE, "code", 1), ...parseFindings(sec, "security", 1), ...parseFindings(ux, "ux", 1)], anchors);
  const m = dedupe(j);
  const line88 = m.find((x) => x.at?.line === 88);
  assert.ok(line88?.blocks);
  assert.deepEqual(line88?.lenses, ["code", "security"]);
  assert.deepEqual(line88?.also, ["security-1-1"]);
  assert.deepEqual(line88?.members, [{ id: "security-1-1", lens: "security", title: "missing owner check", why: "no WHERE owner_id", blocks: true }]);
  const r2 = m.filter((x) => x.requirement === "R2" && !x.at);
  assert.equal(r2.length, 2, "two findings on R2 are two findings");
  assert.ok(m.find((x) => x.id === "ux-1-2")?.blocks, "R3 is unproven: a requirement finding blocks");
  assert.equal(m[0].blocks, true, "blocking first");
  const s = lensStats("security", "BLOCKING", j, m);
  assert.deepEqual(s, {
    lens: "security",
    verdict: "BLOCKING",
    findings: 2,
    claimedBlocking: 1,
    blocks: 1,
    lowConfidence: 0,
    notDemonstrable: 0,
    redismissed: 0,
    duplicates: 1,
  });
  const md = renderReview({ round: 1, head: "abc", lenses: ["code", "security", "ux"], merged: m, stats: [s] });
  assert.match(md, /^REVIEW: BLOCKING/);
  assert.match(
    md,
    /\| code-1-1 \(\+security-1-1\) \| code, security \| BLOCKS \|.*the query has no owner condition \+ security-1-1 \(security\): missing owner check: no WHERE owner_id \|/,
  );
});

test("VIEW lines", () => {
  assert.deepEqual(viewsOf("VERDICT: PASS\nVIEW: /settings --as alice\nVIEW: `settings.toggle-dark --user alice`\nVIEW: none\n"), [
    "/settings --as alice",
    "settings.toggle-dark --user alice",
  ]);
});
