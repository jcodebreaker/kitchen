import path from "node:path";
import { describe, expect, it } from "vitest";
import { fillPorts, retryOracle } from "./oracle.ts";
import { expectationMet, type RunResult, resultsMarkdown, summarize } from "./run.ts";
import { applyPlant, type BenchTicket, loadSet, pick } from "./set.ts";
import { driveRuns, jobDriveTally, sumDrives, type TallyEntry } from "./tally.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("bench set", () => {
  const set = loadSet(ROOT);
  it("has the tuned set PLAN §8 asks for, and a held-out set of 6 per held-out fixture (D, E)", () => {
    const tuned = set.filter((t) => t.set === "tuned");
    const count = (k: string) => tuned.filter((t) => t.kind === k).length;
    expect(tuned.length).toBe(14);
    expect(count("feature")).toBe(4);
    expect(count("bug")).toBe(3);
    expect(tuned.filter((t) => t.kind === "bug" && t.hard).length).toBe(1);
    expect([count("chore"), count("too-big"), count("needs-info"), count("reject"), count("primitive"), count("control")]).toEqual([1, 1, 1, 1, 1, 2]);
    expect(tuned.filter((t) => t.trap).length).toBe(3);
    const heldout = set.filter((t) => t.set === "heldout");
    expect(heldout.length).toBe(12);
    for (const fx of ["d-api", "e-library"]) expect(heldout.filter((t) => t.fixture === fx).length).toBe(6);
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
    const drives = [{ drive: "settings.dark", verifies: 2, inconclusive: 1, runs: 2, passed: 1, failed: 1, flaky: true }];
    const md = resultsMarkdown({
      tier: "smoke",
      tool: "claude",
      date: "d",
      kitchen: { sha: "abc123", dirty: true },
      results: [r({ oracleRetried: "up failed: app /healthz timed out", drives }), r({ correct: false, miss: "went through build" })],
      skipped: ["x"],
      wallSecs: 60,
    });
    expect(md).toContain("Not run (budget or --only): x");
    expect(md).toContain("Kitchen abc123 (dirty: uncommitted changes)");
    expect(md).toContain("retried after: up failed");
    expect(md).toContain("**no** (went through build)");
    expect(md).toContain("Oracles retried after an infrastructure error: 1.");
    expect(md).toContain("| a-web | settings.dark | 1 | 2 | 2 | 1 (50%) | 1 (100%) |");
  });
  it("judges the expectation: outcome, oracle, Toolkit PR, stages never entered", () => {
    const tooBig: BenchTicket["expect"] = { outcome: ["needs-info", "rejected"], never: ["build"] };
    expect(expectationMet(tooBig, { outcome: "needs-info", oracle: "n/a", toolkitPr: false, stages: ["intake", "needs-info"] })).toEqual({ correct: true });
    expect(expectationMet(tooBig, { outcome: "needs-human", oracle: "n/a", toolkitPr: false, stages: ["intake", "needs-human"] })).toEqual({
      correct: false,
      miss: "ended needs-human, expected needs-info / rejected",
    });
    expect(expectationMet(tooBig, { outcome: "rejected", oracle: "n/a", toolkitPr: false, stages: ["intake", "spec", "build", "gate", "rejected"] })).toEqual({
      correct: false,
      miss: "went through build",
    });
    const prim: BenchTicket["expect"] = { outcome: ["done"], toolkit_pr: true };
    expect(expectationMet(prim, { outcome: "done", oracle: "pass", toolkitPr: true, stages: ["build"] }).correct).toBe(true);
    expect(expectationMet(prim, { outcome: "done", oracle: "error", toolkitPr: false, stages: [] }).miss).toBe("oracle error; no Toolkit PR");
    expect(loadSet(ROOT).find((t) => t.id === "a-too-big")?.expect).toEqual({ outcome: ["needs-info", "rejected"], never: ["build"] });
  });
});

describe("bench oracle", () => {
  it("retries once, and only after an infrastructure error", () => {
    const infra = { pass: false, results: [], error: "up failed: app /healthz timed out", infra: true };
    expect(retryOracle(infra, 1)).toBe(true);
    expect(retryOracle(infra, 2)).toBe(false);
    expect(retryOracle({ pass: false, results: [{ id: "C1", status: "assert-fail" }] }, 1)).toBe(false);
    expect(retryOracle({ pass: false, results: [], error: "the oracle has no criteria (ids are C<n>)" }, 1)).toBe(false);
  });
  it("fills {port:<i>} from the slot, and refuses a port it doesn't have", () => {
    expect(fillPorts("cmd node o.mjs {port:1}", [4100, 4101, 4102])).toBe("cmd node o.mjs 4101");
    expect(fillPorts("toolkit login --as alice", null)).toBe("toolkit login --as alice");
    expect(() => fillPorts("cmd x {port:3}", [1, 2, 3])).toThrow(/has 3 ports/);
    expect(() => fillPorts("cmd x {port:0}", null)).toThrow(/no app is up/);
  });
  it("a-primitive's oracle is behavioural: sign-ins through the app, then its database", () => {
    const o = loadSet(ROOT).find((t) => t.id === "a-primitive")?.oracle;
    expect(o?.criteria).toContain("toolkit login --as alice");
    expect(o?.criteria).toContain("cmd node oracle_last_login.mjs {port:1}");
    expect(o?.criteria).not.toContain("grep");
    expect(o?.files).toEqual({ "oracle_last_login.mjs": "oracle/a_last_login.mjs" });
  });
});

describe("bench drive tally", () => {
  const e = (id: string, o: Partial<TallyEntry>): TallyEntry => ({ id, sha: "s1", tree: "t1", criterion: "C1", role: "engine", ok: true, ...o });
  it("groups stamped steps into drive runs (a step's retries stay in its run)", () => {
    const runs = driveRuns([
      e("e1", { drive: "settings.dark", line: 1 }),
      e("e2", { drive: "settings.dark", line: 2, ok: false }),
      e("e3", { drive: "settings.dark", line: 2, attempt: 1 }),
      e("e4", { drive: "settings.dark", line: 1 }),
      e("e5", { drive: "primitive:login", line: 0 }),
      e("e6", { drive: "primitive:login", line: 0, ok: false }),
      e("e7", {}),
      e("e8", { drive: "settings.dark", line: 1, gap: "drag", ok: false }),
    ]);
    expect(runs.map((x) => [x.drive, x.ok, x.entries.join(" ")])).toEqual([
      ["settings.dark", true, "e1 e2 e3"],
      ["settings.dark", true, "e4"],
      ["primitive:login", true, "e5"],
      ["primitive:login", false, "e6"],
    ]);
  });
  it("counts INCONCLUSIVE per drive from the verdicts, and a flake only on the same tree", () => {
    const entries = [
      e("e1", { drive: "settings.dark", line: 1 }),
      e("e2", { drive: "settings.dark", line: 2, ok: false }),
      e("e3", { drive: "settings.dark", line: 1 }),
      e("e4", { drive: "settings.dark", line: 2 }),
      e("e5", { drive: "home.count", line: 1, ok: false, criterion: "C2" }),
      e("e6", { drive: "home.count", line: 1, sha: "s2", tree: "t2", criterion: "C2" }),
    ];
    const verdict = (c1: string, ids1: string, c2: string, ids2: string) =>
      [
        `VERDICT: ${c1}`,
        "",
        "| criterion | decided by | result | evidence | why |",
        "|---|---|---|---|---|",
        `| C1 | engine | ${c1} | ${ids1} | settings.dark: step "x" failed |`,
        `| C2 | engine | ${c2} | ${ids2} |  |`,
      ].join("\n");
    const t = jobDriveTally(entries, [verdict("INCONCLUSIVE", "e1 e2", "FAIL", "e5"), verdict("PASS", "e3 e4", "PASS", "e6")]);
    expect(t).toEqual([
      { drive: "home.count", verifies: 2, inconclusive: 0, runs: 2, passed: 1, failed: 1, flaky: false },
      { drive: "settings.dark", verifies: 2, inconclusive: 1, runs: 2, passed: 1, failed: 1, flaky: true },
    ]);
    const all = sumDrives([
      { fixture: "a-web", drives: t },
      { fixture: "a-web", drives: [{ drive: "settings.dark", verifies: 1, inconclusive: 0, runs: 1, passed: 1, failed: 0, flaky: false }] },
      { fixture: "b-cli" },
    ]);
    expect(all.find((d) => d.drive === "settings.dark")).toEqual({
      fixture: "a-web",
      drive: "settings.dark",
      jobs: 2,
      verifies: 3,
      inconclusive: 1,
      runs: 3,
      flakyJobs: 1,
    });
    expect(all.length).toBe(2);
  });
});
