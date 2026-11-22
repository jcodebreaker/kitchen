import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LedgerLine } from "../ledger/append.ts";
import { measures } from "../ledger/measures.ts";
import { fillPorts, retryOracle } from "./oracle.ts";
import { agentInfraError, expectationMet, type RunResult, resultsMarkdown, section02, section02Lines, summarize } from "./run.ts";
import { applyPlant, type BenchTicket, loadSet, pick } from "./set.ts";
import { jobDriveTally, sumDrives } from "./tally.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("bench set", () => {
  const set = loadSet(ROOT);
  it("has the tuned set PLAN §8 asks for (plus D, tuned on in the regression), and 6 held-out tickets on E", () => {
    const tuned = set.filter((t) => t.set === "tuned" && t.fixture !== "d-api");
    const count = (k: string) => tuned.filter((t) => t.kind === k).length;
    expect(tuned.length).toBe(14);
    expect(count("feature")).toBe(4);
    expect(count("bug")).toBe(3);
    expect(tuned.filter((t) => t.kind === "bug" && t.hard).length).toBe(1);
    expect([count("chore"), count("too-big"), count("needs-info"), count("reject"), count("primitive"), count("control")]).toEqual([1, 1, 1, 1, 1, 2]);
    expect(tuned.filter((t) => t.trap).length).toBe(3);
    const heldout = set.filter((t) => t.set === "heldout");
    expect(heldout.length).toBe(6);
    expect(heldout.every((t) => t.fixture === "e-library")).toBe(true);
    expect(set.filter((t) => t.fixture === "d-api" && t.set === "tuned").length).toBe(6);
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
  // One flake definition (final fixes D): Verify's proof lines, as `kitchen report` reads them.
  const proof = (job: string, criterion: string, head: string, result: string, drives: string[]) =>
    ({
      job,
      stage: "verify",
      round: 1,
      event: "proof",
      key: `${job}/${criterion}/${head}/${Math.random()}`,
      result,
      detail: { criterion, head, drives },
    }) as unknown as LedgerLine;
  it("counts INCONCLUSIVE per drive and a flake only for a PASS and a non-PASS on the same HEAD and criterion", () => {
    const lines = [
      proof("j1", "C1", "h1", "INCONCLUSIVE", ["settings.dark"]),
      proof("j1", "C1", "h1", "PASS", ["settings.dark"]),
      proof("j1", "C2", "h1", "FAIL", ["home.count"]),
      proof("j1", "C2", "h2", "PASS", ["home.count"]),
    ];
    const t = jobDriveTally(measures(lines).drives);
    expect(t).toEqual([
      { drive: "home.count", verifies: 2, inconclusive: 0, runs: 2, passed: 1, failed: 1, flaky: false },
      { drive: "settings.dark", verifies: 2, inconclusive: 1, runs: 2, passed: 1, failed: 0, flaky: true },
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
  });
});

describe("§0.2 judged by code", () => {
  const r = (ticket: string, o: Partial<RunResult> = {}): RunResult =>
    ({
      ticket,
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
      secs: 1,
      usd: 0,
      path: "",
      ...o,
    }) as RunResult;
  it("prints PASS/FAIL per line, names the controls, and counts held-out controls apart", () => {
    const rs = [
      ...Array.from({ length: 17 }, (_, i) => r(`t${i}`)),
      r("trap", { trap: true }),
      r("trap", { trap: true, run: 2, correct: false }),
      r("ctl", { kind: "control", control: true, verifyFails: 1 }),
      r("ctl", { kind: "control", control: true, run: 2, verifyFails: 1 }),
      r("e-ctl", { kind: "control", control: true, set: "heldout", verifyFails: 3 }),
      r("e1", { set: "heldout", correct: false }),
      r("e2", { set: "heldout" }),
    ];
    const s = section02(rs);
    expect(s.map((l) => l.pass)).toEqual([true, false, false, false]);
    expect(s[1].detail).toContain("missed: trap #2");
    expect(s[2].detail).toMatch(/^2 over 2 runs of ctl; held-out controls \(not in this line\): 3 over 1 runs of e-ctl/);
    expect(section02Lines(rs)[0]).toMatch(/^§0.2 PASS {2}≥85% of runs correct: 22\/24/);
    expect(section02([r("x")]).map((l) => l.pass)).toEqual([true, null, null, null]);
  });
  it("an agent adapter's infrastructure error is told apart from a judgment", () => {
    expect(agentInfraError({ outcome: "needs-human", reason: "adapter-error: reviewer-code: Error: claude not found in PATH" })).toBe(true);
    expect(agentInfraError({ outcome: "needs-human", reason: "adapter-error: builder: max turns" })).toBe(false);
    expect(agentInfraError({ outcome: "needs-human", reason: "round limit" })).toBe(false);
  });
});
