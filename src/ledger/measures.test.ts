import assert from "node:assert/strict";
import { test } from "vitest";
import type { LedgerLine } from "./append.ts";
import { drivesOf, formatMeasures, measures, reasonCode } from "./measures.ts";

let n = 0;
const L = (job: string, event: string, o: Partial<LedgerLine> = {}): LedgerLine => ({
  t: new Date(Date.UTC(2026, 10, 22, 10, 0, n++)).toISOString(),
  job,
  stage: "intake",
  round: 1,
  event,
  key: `k${n}`,
  ...o,
});
const mv = (job: string, from: string, to: string, round = 1, note?: string) =>
  L(job, "move", { stage: from, result: to, round, detail: { row: `${from}>${to}`, ...(note ? { note } : {}) } });

const history: LedgerLine[] = [
  // a: low, first-pass PASS, done
  L("a", "agent", { role: "intake", usd: 0.1, secs: 5, detail: { line: "ACCEPT feature low: x" } }),
  mv("a", "intake", "build"),
  L("a", "agent", { stage: "build", role: "builder", usd: 0.2, secs: 40 }),
  mv("a", "build", "gate"),
  mv("a", "gate", "drives"),
  mv("a", "drives", "verify"),
  L("a", "proof", { stage: "verify", result: "PASS", detail: { criterion: "C1", drives: ["login", "settings.open"], head: "h1" } }),
  mv("a", "verify", "review"),
  mv("a", "review", "ready"),
  mv("a", "ready", "report"),
  mv("a", "report", "done"),
  // b: medium, INCONCLUSIVE then PASS on the same head (flaky), then FAIL in round 2 path → round limit
  L("b", "agent", { role: "intake", usd: 0.3, detail: { line: "ACCEPT bug medium: y" } }),
  mv("b", "intake", "spec"),
  L("b", "proof", { stage: "verify", result: "INCONCLUSIVE", detail: { criterion: "C1", drives: ["login"], head: "h2" } }),
  mv("b", "verify", "verify"),
  L("b", "proof", { stage: "verify", result: "PASS", detail: { criterion: "C1", drives: ["login"], head: "h2" } }),
  mv("b", "verify", "build"),
  mv("b", "spec", "toolkit"),
  mv("b", "toolkit", "spec"),
  mv("b", "review", "needs-human", 3, "round-limit: review → build: round limit"),
  L("b", "review-lens", { stage: "review", detail: { lens: "code", findings: 4, blocks: 1 } }),
  L("b", "finding-dismissed", { stage: "review", detail: { lens: "code" } }),
  // c: needs info, unrated
  L("c", "agent", { role: "intake", usd: 0.05, detail: { line: "NEEDS-INFO which page?" } }),
  mv("c", "intake", "needs-info", 1, "which page?"),
  // lines that are not jobs
  L("-", "run-start"),
  L("bench:x", "bench"),
];

test("measures: every §0 number from a small history", () => {
  const m = measures(history);
  assert.equal(m.takenIn, 3);
  assert.equal(m.mergeReady, 1);
  assert.deepEqual([m.verified, m.firstPass], [2, 1]); // b's first verify exit was the free retry's FAIL, not review
  assert.equal(m.rounds.max, 3);
  assert.equal(m.rounds.jobs, 2); // c never got past intake
  assert.deepEqual(
    m.escalations.map((e) => [e.to, e.code, e.n]),
    [
      ["needs-info", "needs-info", 1],
      ["needs-human", "round-limit", 1],
    ],
  );
  assert.deepEqual([m.gaps.total, m.primitivePrs.total], [1, 1]);
  const login = m.drives.find((d) => d.drive === "login");
  assert.deepEqual([login?.runs, login?.inconclusive, login?.groups, login?.flaky], [3, 1, 2, 1]);
  assert.deepEqual([m.proofs.runs, m.proofs.inconclusive, m.proofs.flakyGroups], [3, 1, 1]);
  assert.deepEqual(
    m.perPath.map((p) => [p.risk, p.jobs, p.done]),
    [
      ["low", 1, 1],
      ["medium", 1, 0],
      ["unrated", 1, 0],
    ],
  );
  assert.equal(m.jobs.find((j) => j.job === "a")?.usd, 0.3);
  assert.deepEqual(m.lenses, [{ lens: "code", findings: 4, blocked: 1, dismissed: 1 }]);
  const text = formatMeasures(m).join("\n");
  for (const h of [
    "merge-ready rate",
    "first-pass Verdict rate",
    "rounds per job",
    "escalation reasons",
    "Toolkit gaps per job",
    "INCONCLUSIVE and flake per drive",
    "time and cost per risk path",
    "time and cost per job",
    "findings dismissed per review lens",
    "primitive PRs per job",
  ])
    assert.ok(text.includes(h), h);
  assert.equal(m.jobs.find((j) => j.job === "a")?.agentSecs, 45, "agent seconds beside the wall clock");
  assert.match(text, /^Kitchen report: .* agent time, .* wall clock/);
  assert.ok(!/needs-info +needs-info/.test(text), "no repeated needs-info");
  assert.match(text, /^ +1 {2}needs-info\n/m);
});

test("drivesOf names toolkit segments, cmd and test", () => {
  assert.deepEqual(drivesOf("toolkit login --as alice ; toolkit settings.open"), ["login", "settings.open"]);
  assert.deepEqual(drivesOf("test src/a.test.ts"), ["test src/a.test.ts"]);
  assert.deepEqual(drivesOf("cmd npm run x"), ["cmd"]);
  assert.deepEqual(drivesOf(undefined), []);
});

test("reasonCode: the slug before the colon, else the note", () => {
  assert.equal(reasonCode("needs-human", "smith-limit: two tries"), "smith-limit");
  assert.equal(reasonCode("needs-human", "two drive attempts failed"), "two drive attempts failed");
  assert.equal(reasonCode("rejected", "anything"), "rejected");
});
