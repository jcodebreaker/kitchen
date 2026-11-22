import path from "node:path";
import { describe, expect, it } from "vitest";
import { type RunResult, resultsMarkdown, summarize } from "./run.ts";
import { applyPlant, loadSet, pick } from "./set.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("bench set", () => {
  const set = loadSet(ROOT);
  it("has the tuned set PLAN §8 asks for, and a held-out set of 6", () => {
    const tuned = set.filter((t) => t.set === "tuned");
    const count = (k: string) => tuned.filter((t) => t.kind === k).length;
    expect(tuned.length).toBe(14);
    expect(count("feature")).toBe(4);
    expect(count("bug")).toBe(3);
    expect(tuned.filter((t) => t.kind === "bug" && t.hard).length).toBe(1);
    expect([count("chore"), count("too-big"), count("needs-info"), count("reject"), count("primitive"), count("control")]).toEqual([1, 1, 1, 1, 1, 2]);
    expect(tuned.filter((t) => t.trap).length).toBe(3);
    expect(set.filter((t) => t.set === "heldout").length).toBe(6);
  });
  it("smoke is 5 tickets: a feature, a bug, a trap, a control, a low-risk one", () => {
    const smoke = pick(set, "smoke");
    expect(smoke.length).toBe(5);
    expect(smoke.some((t) => t.kind === "bug")).toBe(true);
    expect(smoke.some((t) => t.trap)).toBe(true);
    expect(smoke.some((t) => t.kind === "control")).toBe(true);
    expect(smoke.some((t) => t.kind === "chore")).toBe(true);
  });
  it("every ticket that must end done has an oracle", () => {
    for (const t of set) if (t.expect.outcome.includes("done")) expect(t.oracle, t.id).toBeDefined();
  });
  it("plants apply or fail loudly", () => {
    expect(applyPlant("a b c", { file: "x", from: "b", to: "B" })).toBe("a B c");
    expect(applyPlant("a", { file: "x", append: "\nz" })).toBe("a\nz");
    expect(() => applyPlant("a", { file: "x", from: "q", to: "r" })).toThrow(/has no/);
  });
});

describe("bench scoring", () => {
  const r = (o: Partial<RunResult>): RunResult => ({
    ticket: "t",
    fixture: "a-web",
    set: "tuned",
    kind: "feature",
    trap: false,
    control: false,
    run: 1,
    expected: ["done"],
    outcome: "done",
    oracle: "pass",
    toolkitPr: false,
    correct: true,
    rounds: 1,
    verifyFails: 0,
    secs: 60,
    usd: 0.5,
    path: "",
    ...o,
  });
  it("counts traps caught, false FAILs on controls, tuned vs held-out", () => {
    const s = summarize([
      r({}),
      r({ trap: true, correct: false, oracle: "fail" }),
      r({ control: true, verifyFails: 1 }),
      r({ set: "heldout", correct: false }),
    ]);
    expect(s).toMatchObject({ runs: 4, correct: 2, traps: { runs: 1, caught: 0 }, controls: { runs: 1, falseFails: 1 }, tuned: { runs: 3, correct: 2 } });
    expect(s.heldout).toEqual({ runs: 1, correct: 0 });
    expect(resultsMarkdown({ tier: "smoke", tool: "claude", date: "d", results: [r({})], skipped: ["x"], wallSecs: 60 })).toContain(
      "Not run (budget or --only): x",
    );
  });
});
