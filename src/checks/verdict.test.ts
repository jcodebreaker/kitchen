import assert from "node:assert/strict";
import { test } from "vitest";
import type { Entry } from "../proof/manifest.ts";
import { citationProblem, citationsOf, decideVerdict, judgementsOf, type ProofRecord } from "./verdict.ts";

const H = "a".repeat(40);
const OLD = "b".repeat(40);
const e = (id: string, o: Partial<Entry> = {}) => ({ id, sha: H, round: 2, criterion: "C2", role: "engine", dirty: false, ...o }) as unknown as Entry;
const entries = [
  e("e1", { criterion: "gate" }),
  e("e2"),
  e("e3", { sha: OLD }),
  e("e4", { round: 1 }),
  e("e5", { criterion: "C3" }),
  e("e6", { role: "builder" }),
  e("e7", { role: "verifier" }),
  e("e8", { dirty: true }),
];

test("citations are per criterion: EVIDENCE C<n>: e<N> …", () => {
  const c = citationsOf("VERDICT: PASS\nEVIDENCE C2: e2, e7\nEVIDENCE: e1\n  EVIDENCE C3: e5\nEVIDENCE C2: e9\n");
  assert.deepEqual(
    [...c.entries()],
    [
      ["C2", ["e2", "e7", "e9"]],
      ["C3", ["e5"]],
    ],
  );
  assert.deepEqual(
    [...judgementsOf("JUDGED C2: PASS\nJUDGED C3: FAIL because\nJUDGED C2: FAIL\n").entries()],
    [
      ["C2", "PASS"],
      ["C3", "FAIL"],
    ],
  );
});

test("a citation must be stamped for this HEAD (clean), round and criterion, by the engine or the verifier", () => {
  const ok = (judged: string[], text: string) => citationProblem(judged, citationsOf(text), entries, H, 2);
  assert.equal(ok([], "VERDICT: PASS\n"), null, "no judged criteria: nothing to cite");
  assert.equal(ok(["C2"], "EVIDENCE C2: e2 e7\n"), null, "engine and verifier entries");
  assert.match(ok(["C2"], "VERDICT: PASS\n") ?? "", /C2 is judged and cites no evidence/);
  assert.match(ok(["C2"], "EVIDENCE: e2\n") ?? "", /cites no evidence/, "a flat list counts for no criterion");
  assert.match(ok(["C2", "C3"], "EVIDENCE C2: e2\n") ?? "", /C3 is judged/);
  assert.match(ok(["C2"], "EVIDENCE C2: e3\n") ?? "", /not HEAD/, "stale: older HEAD");
  assert.match(ok(["C2"], "EVIDENCE C2: e4\n") ?? "", /round 1, not 2/, "stale: older round");
  assert.match(ok(["C2"], "EVIDENCE C2: e1\n") ?? "", /stamped for gate/, "another criterion");
  assert.match(ok(["C2"], "EVIDENCE C2: e5\n") ?? "", /stamped for C3/);
  assert.match(ok(["C2"], "EVIDENCE C2: e99\n") ?? "", /not in the manifest/, "forged id");
  assert.match(ok(["C2"], "EVIDENCE C2: e6\n") ?? "", /builder self-check/, "a builder's self-check is not proof");
  assert.match(ok(["C2"], "EVIDENCE C2: e8\n") ?? "", /dirty tree/);
  assert.match(ok(["C2"], "EVIDENCE C2: e2 e3\n") ?? "", /e3/, "one bad id among good ones");
});

const criteria = [
  { id: "C1", expect: '$theme == "Dark"' },
  { id: "C2", expect: "judged" },
];
const proofs: ProofRecord[] = [
  { criterion: "C1", result: "PASS", evidence: ["e1"] },
  { criterion: "C2", result: "PASS", evidence: ["e2"] },
];
const decide = (judgedText: string | null, o: { entries?: Entry[] | null; p?: typeof proofs } = {}) =>
  decideVerdict({ criteria, proofs: o.p ?? proofs, judgedText, entries: o.entries === undefined ? entries : o.entries, head: H, round: 2 });

test("verdict: mechanical by the engine, judged by the verifier with stamped citations", () => {
  assert.equal(decide("VERDICT: PASS\nJUDGED C2: PASS\nEVIDENCE C2: e2\n").verdict, "PASS");
  const forged = decide("VERDICT: PASS\nJUDGED C2: PASS\nEVIDENCE C2: e99\n");
  assert.equal(forged.verdict, "FAIL", "a forged citation counts as FAIL");
  assert.equal(forged.citationsOk, false);
  assert.match(forged.criteria[1].why ?? "", /not in the manifest/);
  assert.equal(decide("VERDICT: PASS\nJUDGED C2: PASS\nEVIDENCE C2: e3\n").verdict, "FAIL", "stale");
  assert.equal(decide("VERDICT: PASS\nJUDGED C2: PASS\nEVIDENCE C2: e6\n").verdict, "FAIL", "self-check");
  assert.equal(decide("VERDICT: PASS\n").verdict, "FAIL", "no JUDGED line");
  assert.equal(decide("VERDICT: FAIL\nJUDGED C2: FAIL\n").verdict, "FAIL");
  assert.equal(decide("VERDICT: INCONCLUSIVE\n").verdict, "INCONCLUSIVE");
  const gap = decide("VERDICT: TOOLKIT-GAP\nGAP: drag\n");
  assert.equal(gap.verdict, "TOOLKIT-GAP");
  assert.equal(gap.gap, "drag");
  assert.equal(decide(null).verdict, "INCONCLUSIVE", "a judged criterion with no judgement can't pass");
});

test("verdict: a mechanical FAIL wins; the agent can't overturn it", () => {
  const p: ProofRecord[] = [{ ...proofs[0], result: "FAIL", why: "$theme: got Light" }, proofs[1]];
  const v = decide("VERDICT: PASS\nJUDGED C1: PASS\nEVIDENCE C1: e1\nJUDGED C2: PASS\nEVIDENCE C2: e2\n", { p });
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.criteria[0].result, "FAIL");
  assert.equal(decide("VERDICT: PASS\nJUDGED C2: PASS\nEVIDENCE C2: e2\n", { p: [proofs[1]] }).criteria[0].result, "INCONCLUSIVE", "a proof that never ran");
  const order = decideVerdict({
    criteria: [
      { id: "C1", expect: "ok" },
      { id: "C3", expect: "ok" },
    ],
    proofs: [
      { criterion: "C1", result: "INCONCLUSIVE", evidence: [] },
      { criterion: "C3", result: "TOOLKIT-GAP", gap: "drag", evidence: [] },
    ],
    judgedText: null,
    entries,
    head: H,
    round: 2,
  });
  assert.equal(order.verdict, "TOOLKIT-GAP");
  assert.equal(order.gap, "drag");
});

test("verdict: a refused manifest is reported, and --args deltas are carried", () => {
  const v = decideVerdict({
    criteria,
    proofs,
    judgedText: "JUDGED C2: PASS\nEVIDENCE C2: e2\n",
    entries: null,
    head: H,
    round: 2,
    argsDeltas: [{ criterion: "C2", drive: "x.y", spec: { user: "alice" }, used: { user: "bob-admin" }, by: "verifier", at: "t" }],
  });
  assert.equal(v.manifestOk, false);
  assert.equal(v.verdict, "FAIL", "no manifest: nothing to cite");
  assert.equal(v.argsDeltas.length, 1);
  // Review: a refused manifest with only mechanical criteria was a PASS.
  const mech = decideVerdict({ criteria: [{ id: "C1", expect: "ok" }], proofs: [proofs[0]], judgedText: null, entries: null, head: H, round: 2 });
  assert.equal(mech.verdict, "INCONCLUSIVE", "evidence that doesn't verify proves nothing: never a PASS");
});

test("verdict: a TOOLKIT-GAP must name one missing primitive; free text or a known primitive is no gap", () => {
  const free = decide("VERDICT: TOOLKIT-GAP\nGAP: the `read` primitive fails on a missing selector\n");
  assert.equal(free.verdict, "INCONCLUSIVE", "free text names nothing a smith could add");
  assert.equal(free.gap, undefined);
  const known = decideVerdict({ criteria, proofs, judgedText: "VERDICT: TOOLKIT-GAP\nGAP: read\n", entries, head: H, round: 2, primitives: ["read"] });
  assert.equal(known.verdict, "INCONCLUSIVE", "describe lists it: nothing is missing");
  assert.equal(decide("VERDICT: TOOLKIT-GAP\nGAP: drag (to reorder)\n").gap, "drag");
});

test("verdict: criteria that already passed on the base are flagged non-discriminating", () => {
  const v = decideVerdict({ criteria, proofs, judgedText: "JUDGED C2: PASS\nEVIDENCE C2: e2\n", entries, head: H, round: 2, nonDiscriminating: ["C1"] });
  assert.equal(v.verdict, "PASS", "flagged, not failed");
  assert.deepEqual(v.nonDiscriminating, ["C1"]);
});
