import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseFindings } from "../checks/findings.ts";
import type { LedgerLine } from "../ledger/append.ts";
import { measures } from "../ledger/measures.ts";
import { categoryOf, needsReason, securityVeto } from "./categories.ts";
import { type Dismissal, dismissalsIn, dismissalsOf, dismissedIn, emptyState, muteDecisions, parseLessons, pickSignals, signalsOf } from "./signals.ts";
import { mutedFinding } from "./state.ts";

const dis = (job: string, finding: string, lens: string, title: string): LedgerLine => ({
  t: "2026-11-22T10:00:00Z",
  job,
  stage: "done",
  round: 1,
  event: "finding-dismissed",
  key: `${job}/dismiss/${finding}`,
  detail: { finding, lens, title },
});

test("categoryOf: the declared category when valid, else first keyword match on the title, then the why, else other", () => {
  assert.equal(categoryOf("Rename `cnt` to `count`"), "naming");
  assert.equal(categoryOf("Missing unit test for the reducer"), "tests");
  assert.equal(categoryOf("Button overflows at 390 px width"), "ui");
  assert.equal(categoryOf("Something odd", "the error is swallowed"), "correctness");
  assert.equal(categoryOf("Something odd"), "other");
  assert.equal(categoryOf("Rename `cnt`", "", "Performance"), "performance", "declared wins over keywords");
  assert.equal(categoryOf("Rename `cnt`", "", "nonsense"), "naming", "an unknown declared value falls back");
  assert.equal(categoryOf("Missing test for the session check"), "security", "security terms first in the fallback");
});

// The review's three examples of keyword muting silencing security-relevant code findings (W5 review M2).
test("security veto: a finding with a security term is never muted, whatever its lens or declared category", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-veto-"));
  fs.mkdirSync(path.join(dir, ".kitchen", "retro"), { recursive: true });
  const mute = (lens: string, category: string) => ({ lens, category, at: "t", dismissals: 3, findings: [] });
  fs.writeFileSync(
    path.join(dir, ".kitchen", "retro", "state.json"),
    JSON.stringify({ ...emptyState(), mutes: [mute("code", "tests"), mute("code", "naming"), mute("ux", "ux")] }),
  );
  const review = (lens: string, block: string) => parseFindings(`VERDICT: BLOCKING\n\n### F1: ${block}`, lens, 1)[0];
  // 1. code lens, declared tests, about the session check
  const f1 = review(
    "code",
    "Missing test for the session expiry check\n- kind: blocking\n- confidence: high\n- category: tests\n- at: server.js:40\n- why: nothing asserts an expired session is refused",
  );
  assert.equal(f1.category, "tests");
  assert.equal(categoryOf(f1.title, f1.why, f1.category), "tests");
  assert.match(String(securityVeto(f1)), /session/);
  assert.equal(mutedFinding(dir, f1), null);
  // 2. code lens, no category line: the title reads as naming, the why is about the auth token
  const f2 = review(
    "code",
    "Rename `tok` to something clearer\n- kind: blocking\n- confidence: high\n- at: api.js:12\n- why: `tok` holds the auth token; it is logged on line 14 where a reader can't tell it is a secret",
  );
  assert.equal(f2.category, undefined);
  assert.equal(categoryOf(f2.title, f2.why), "naming");
  assert.ok(securityVeto(f2));
  assert.equal(mutedFinding(dir, f2), null);
  // 3. ux lens, declared ux: a member can delete another user's project
  const f3 = review(
    "ux",
    "The delete button shows for every project\n- kind: blocking\n- confidence: high\n- category: ux\n- evidence: e4\n- why: as bob I can delete another user's project from the list",
  );
  assert.ok(securityVeto(f3));
  assert.equal(mutedFinding(dir, f3), null);
  // Controls: the same mutes do silence plain findings.
  const n = review("code", "Rename `cnt` to `count`\n- kind: blocking\n- confidence: high\n- category: naming\n- at: a.js:3");
  assert.equal(securityVeto(n), null);
  assert.match(String(mutedFinding(dir, n)), /muted by the retro: code\/naming/);
  const u = review("ux", "The empty list says nothing\n- kind: blocking\n- confidence: high\n- category: ux\n- evidence: e5");
  assert.match(String(mutedFinding(dir, u)), /ux\/ux/);
  // A dismissed vetoed finding doesn't count toward a mute either.
  const ds = ["a", "b", "c"].map((j) => dis(j, "code-1-1", "code", "Missing test for the session expiry check"));
  for (const l of ds) (l.detail as Record<string, unknown>).category = "tests";
  assert.deepEqual(muteDecisions(dismissalsOf(ds), emptyState(), { muteAfter: 3, neverMute: ["security"], now: "n" }), []);
  // A declared `category: security` in another lens is never muted (never_mute names categories too).
  const sec = ["a", "b", "c"].map((j) => dis(j, "ux-1-1", "ux", "Odd page"));
  for (const l of sec) (l.detail as Record<string, unknown>).category = "security";
  assert.deepEqual(muteDecisions(dismissalsOf(sec), emptyState(), { muteAfter: 3, neverMute: ["security"], now: "n" }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mutes: N dismissals of one lens/category mute it; other, security and fewer never do; unmute needs N new ones", () => {
  const lines = [
    dis("a", "code-1-1", "code", "Rename x to y"),
    dis("b", "code-1-1", "code", "Variable naming is unclear"),
    dis("c", "code-1-2", "code", "Rename helper"),
    dis("c", "code-1-2", "code", "Rename helper"), // the same finding twice counts once
    dis("a", "security-1-1", "security", "Rename token var"),
    dis("b", "security-1-1", "security", "Rename secret"),
    dis("c", "security-1-1", "security", "Rename key"),
    dis("a", "ux-1-1", "ux", "Feels odd"),
    dis("b", "ux-1-1", "ux", "Feels odd"),
    dis("c", "ux-1-1", "ux", "Feels odd"),
    dis("a", "code-1-3", "code", "Missing test"),
  ];
  const ds = dismissalsOf(lines);
  assert.equal(ds.length, 10);
  const o = { muteAfter: 3, neverMute: ["security"], now: "now" };
  const m = muteDecisions(ds, emptyState(), o);
  assert.deepEqual(
    m.map((x) => [x.lens, x.category, x.dismissals]),
    [["code", "naming", 3]],
  );
  const st = { ...emptyState(), mutes: m };
  assert.deepEqual(muteDecisions(ds, st, o), [], "already muted: nothing new");
  const lifted = { ...emptyState(), unmuted: [{ lens: "code", category: "naming" as const, at: "t", dismissals: 3 }] };
  assert.deepEqual(muteDecisions(ds, lifted, o), [], "unmuted at 3: needs 3 more");
  const more = [
    ...ds,
    ...["d", "e", "f"].map((j): Dismissal => ({ job: j, finding: "code-1-1", lens: "code", category: "naming", title: "Rename", source: "cli" })),
  ];
  assert.equal(muteDecisions(more, lifted, o).length, 1);
});

test("dismissedIn: a 'not useful' reply or a thumbs-down names finding ids", () => {
  assert.deepEqual(dismissedIn("code-1-2 is not useful, and ux-2-1 too"), ["code-1-2", "ux-2-1"]);
  assert.deepEqual(dismissedIn("👎 code-1-3"), ["code-1-3"]);
  assert.deepEqual(dismissedIn("please fix code-1-2"), []);
});

// The review's examples of dismissedIn taking every id in the comment (W5 review M3).
test("dismissalsIn: only ids in the trigger's sentence; the rest of the comment is still feedback", () => {
  // 1. Two sentences: one dismisses, the other asks for a fix of another finding.
  const a = dismissalsIn("code-1-2 is not useful. But code-1-3 is right, please fix it.");
  assert.deepEqual(
    a.dismissed.map((d) => d.id),
    ["code-1-2"],
  );
  assert.equal(a.rest, "But code-1-3 is right, please fix it.");
  assert.equal(a.pure, false);
  // 2. Lines: a dismissal line and a feature request.
  const b = dismissalsIn("Not useful: code-1-1, the naming is fine as it is.\n\nAlso the empty state on /projects needs a message.");
  assert.deepEqual(
    b.dismissed.map((d) => d.id),
    ["code-1-1"],
  );
  assert.equal(b.rest, "Also the empty state on /projects needs a message.");
  assert.equal(b.pure, false);
  // 3. A security finding: a reason after "because" is kept; a bare thumbs-down has none, so it can't dismiss it.
  const c = dismissalsIn("security-1-1 is not useful because the endpoint is admin-only by design.");
  assert.deepEqual(c.dismissed, [{ id: "security-1-1", reason: "the endpoint is admin-only by design" }]);
  assert.equal(c.pure, true);
  const d = dismissalsIn("👎 security-1-2");
  assert.deepEqual(d.dismissed, [{ id: "security-1-2", reason: null }]);
  assert.ok(needsReason({ lens: "security" }) && needsReason({ lens: "code", category: "security" }) && !needsReason({ lens: "code", category: "tests" }));
  // Pure: only dismissals (and a thank-you) are not feedback; ids without a trigger in their sentence are not dismissed.
  assert.equal(dismissalsIn("code-1-2 is not useful.\nThanks!").pure, true);
  assert.deepEqual(dismissalsIn("code-1-2: please fix. ux-1-1 too.").dismissed, []);
});

test("signals: gaps, unreliable drives, repeated escalations and blocking categories; each proposed once", () => {
  const L = (job: string, event: string, o: Partial<LedgerLine>): LedgerLine => ({
    t: "2026-11-22T10:00:00Z",
    job,
    stage: "verify",
    round: 1,
    event,
    key: `${job}${event}${Math.random()}`,
    ...o,
  });
  const lines: LedgerLine[] = [
    ...["a", "b"].flatMap((j) => [
      L(j, "proof", { result: "INCONCLUSIVE", detail: { criterion: "C1", drives: ["login"], head: "h" } }),
      L(j, "move", { stage: "review", result: "needs-human", detail: { note: "round-limit: 3 of 3" } }),
    ]),
  ];
  const s = signalsOf({
    m: measures(lines),
    blocked: [
      { job: "a", lens: "code", id: "code-1-1", title: "Rename foo" },
      { job: "b", lens: "code", id: "code-1-1", title: "Naming of bar" },
      { job: "c", lens: "code", id: "code-1-1", title: "Something" },
    ],
    dismissed: [],
    gaps: [
      { job: "a", primitive: "sql" },
      { job: "b", primitive: "sql" },
      { job: "c", primitive: "mail" },
    ],
    mutes: [],
  });
  assert.deepEqual(s.map((x) => x.id).sort(), ["drive:login", "escalation:round-limit", "findings:code/naming", "gap:sql"]);
  assert.equal(s.find((x) => x.id === "findings:code/naming")?.hint, "lint-rule");
  const st = { ...emptyState(), filed: [{ signal: "gap:sql", ref: "x", title: "t", kind: "toolkit-fix" as const, at: "t" }] };
  const picked = pickSignals(s, st, 2);
  assert.equal(picked.length, 2);
  assert.ok(!picked.some((x) => x.id === "gap:sql"));
});

test("parseLessons: only given signals, known kinds, one each, at most max", () => {
  const text = `### L1: Add a ruff rule for naming
- signal: findings:code/naming
- kind: lint-rule

Body one.

### L2: Make up a signal
- signal: nope
- kind: check

x

### L3: Wrong kind
- signal: gap:sql
- kind: rewrite-kitchen

y

### L4: Again naming
- signal: findings:code/naming
- kind: check

z
`;
  const r = parseLessons(text, ["findings:code/naming", "gap:sql"], 3);
  assert.deepEqual(
    r.lessons.map((l) => [l.signal, l.kind, l.title, l.body]),
    [["findings:code/naming", "lint-rule", "Add a ruff rule for naming", "Body one."]],
  );
  assert.equal(r.refused.length, 3);
});
