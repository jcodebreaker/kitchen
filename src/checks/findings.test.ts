import assert from "node:assert/strict";
import { test } from "vitest";
import { type Anchors, anchorProblem, dedupe, judge, lensStats, parseAt, parseFindings, renderReview, verdictOf, viewsOf } from "./findings.ts";

const anchors: Anchors = {
  lines: (f) => ({ "server.js": 120, "db/003_owner.sql": 4 })[f] ?? null,
  requirements: ["R1", "R2", "R3"],
  evidence: ["e1", "e2", "e14"],
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

test("anchors: none at all, an unknown file, an out-of-scope requirement, an id not in the manifest", () => {
  const base = { id: "x", lens: "code", title: "t", kind: "blocking" as const, confidence: "high" as const, evidence: [] as string[], why: "" };
  assert.match(anchorProblem(base, anchors) ?? "", /names no line, requirement or evidence/);
  assert.match(anchorProblem({ ...base, at: { file: "nope.js", line: 1 } }, anchors) ?? "", /not a tracked file/);
  assert.match(anchorProblem({ ...base, requirement: "R9" }, anchors) ?? "", /R9 is not a requirement in scope/);
  assert.match(anchorProblem({ ...base, evidence: ["e14", "e99"] }, anchors) ?? "", /e99 is not in the manifest/);
  assert.match(anchorProblem({ ...base, atRaw: "the router" }, anchors) ?? "", /is not file:line/);
  assert.equal(anchorProblem({ ...base, requirement: "R2" }, anchors), null, "a requirement not met is demonstrable");
  assert.equal(anchorProblem({ ...base, evidence: ["e14"] }, anchors), null, "a failing run is demonstrable");
});

test("the same line from two lenses is one finding; it blocks if either member does", () => {
  const sec = `VERDICT: BLOCKING\n\n### F1: missing owner check\n- kind: blocking\n- confidence: high\n- at: server.js:88\n\n### F2: R2 not met\n- kind: note\n- confidence: medium\n- requirement: R2\n`;
  const ux = `VERDICT: PASS\n\n### F1: owner column visible\n- kind: note\n- confidence: high\n- requirement: R2\n- evidence: e14\n`;
  const j = judge([...parseFindings(CODE, "code", 1), ...parseFindings(sec, "security", 1), ...parseFindings(ux, "ux", 1)], anchors);
  const m = dedupe(j);
  const line88 = m.find((x) => x.at?.line === 88);
  assert.ok(line88?.blocks);
  assert.deepEqual(line88?.lenses, ["code", "security"]);
  assert.deepEqual(line88?.also, ["security-1-1"]);
  const r2 = m.find((x) => x.requirement === "R2" && !x.at);
  assert.deepEqual(r2?.lenses, ["security", "ux"]);
  assert.deepEqual(r2?.evidence, ["e14"]);
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
    duplicates: 1,
  });
  const md = renderReview({ round: 1, head: "abc", lenses: ["code", "security", "ux"], merged: m, stats: [s] });
  assert.match(md, /^REVIEW: BLOCKING/);
  assert.match(md, /\| code-1-1 \(\+security-1-1\) \| code, security \| BLOCKS \|/);
});

test("VIEW lines", () => {
  assert.deepEqual(viewsOf("VERDICT: PASS\nVIEW: /settings --as alice\nVIEW: `settings.toggle-dark --user alice`\nVIEW: none\n"), [
    "/settings --as alice",
    "settings.toggle-dark --user alice",
  ]);
});
