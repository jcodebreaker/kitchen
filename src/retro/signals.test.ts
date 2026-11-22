import assert from "node:assert/strict";
import { test } from "vitest";
import type { LedgerLine } from "../ledger/append.ts";
import { measures } from "../ledger/measures.ts";
import { categoryOf } from "./categories.ts";
import { type Dismissal, dismissalsOf, dismissedIn, emptyState, muteDecisions, parseLessons, pickSignals, signalsOf } from "./signals.ts";

const dis = (job: string, finding: string, lens: string, title: string): LedgerLine => ({
  t: "2026-11-22T10:00:00Z",
  job,
  stage: "done",
  round: 1,
  event: "finding-dismissed",
  key: `${job}/dismiss/${finding}`,
  detail: { finding, lens, title },
});

test("categoryOf: first match on the title, then the why, else other", () => {
  assert.equal(categoryOf("Rename `cnt` to `count`"), "naming");
  assert.equal(categoryOf("Missing unit test for the reducer"), "tests");
  assert.equal(categoryOf("Button overflows at 390 px width"), "layout");
  assert.equal(categoryOf("Something odd", "the error is swallowed"), "error-handling");
  assert.equal(categoryOf("Something odd"), "other");
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
