import assert from "node:assert/strict";
import { afterAll, describe, test } from "vitest";
import { type Facts, type Job, move, type Stage, TABLE } from "./machine.ts";

const NOW = "2026-11-22T10:00:00.000Z";

function baseJob(over: Partial<Job> = {}): Job {
  return {
    id: "001-x",
    title: "x",
    ticket: { source: "prompt", id: "p1" },
    stage: "intake",
    round: 1,
    roundStart: 1,
    roundLimit: 3,
    risk: null,
    riskFloor: null,
    surfaces: [],
    kind: null,
    base: "b".repeat(40),
    branch: "kitchen/001-x",
    worktree: "/w",
    pr: null,
    slot: null,
    toolkitRef: "",
    returnTo: null,
    gap: null,
    attempts: { drives: 0, render: 0, toolkitTicket: 0, repro: 0, inconclusive: 0, backoff: 0, errors: 0, refused: 0 },
    smith: { attempts: 0, toolkitPr: null },
    toolkitTicketRef: null,
    filed: [],
    agentRuns: [],
    moves: 0,
    running: null,
    startedAt: NOW,
    updatedAt: NOW,
    uid: "u",
    gitDir: "",
    toolkitBin: "",
    slotId: "001-x",
    manifestHead: { n: 0, hash: "0", mac: "" },
    ...over,
  };
}

const f = (x: Omit<Facts, "now"> = {}): Facts => ({ now: NOW, ...x });
const okLint = { ok: true };
const H = "a".repeat(40);
const gate = (result: "PASS" | "FAIL", head = H) => ({ head, currentHead: H, result });
const ready = (o: Partial<NonNullable<Facts["ready"]>> = {}): Facts["ready"] => ({
  synced: true,
  conflict: false,
  ci: "pass",
  toolkitPr: "none",
  gatePass: true,
  baseMoved: false,
  recheckFailed: false,
  ...o,
});
const verify = (verdict: NonNullable<Facts["verify"]>["verdict"], o: Partial<NonNullable<Facts["verify"]>> = {}): Facts["verify"] => ({
  verdict,
  mechanicalFirst: true,
  citationsOk: true,
  manifestOk: true,
  ...o,
});
const report = (o: Partial<NonNullable<Facts["report"]>> = {}): Facts["report"] => ({
  rendered: true,
  idsResolved: true,
  evidencePushed: true,
  commented: true,
  localForge: false,
  ...o,
});
const spent = { round: 3, roundStart: 1 }; // 3 of 3 rounds used

type Case = { row: string; job: Partial<Job>; to: Stage; facts: Facts; refused?: RegExp; code?: string; expect?: (j: Job) => void };

const cases: Case[] = [
  // intake
  {
    row: "intake>spec",
    job: {},
    to: "spec",
    facts: f({ intake: { decision: "ACCEPT", kind: "feature", risk: "medium", requirements: 2 } }),
    expect: (j) => assert.equal(j.risk, "medium"),
  },
  {
    row: "intake>spec",
    job: {},
    to: "spec",
    facts: f({ intake: { decision: "ACCEPT", kind: "feature", risk: "medium", requirements: 0 } }),
    refused: /lists no requirements/,
  },
  { row: "intake>spec", job: {}, to: "spec", facts: f({ intake: { decision: "ACCEPT", kind: "feature", risk: "low" } }), refused: /low skips spec/ },
  {
    row: "intake>build",
    job: {},
    to: "build",
    facts: f({ intake: { decision: "ACCEPT", kind: "chore", risk: "low", criteria: okLint } }),
    expect: (j) => assert.equal(j.kind, "chore"),
  },
  {
    row: "intake>build",
    job: {},
    to: "build",
    facts: f({ intake: { decision: "ACCEPT", kind: "chore", risk: "low", criteria: { ok: false, reason: "C1 has no proof" } } }),
    refused: /C1 has no proof/,
  },
  {
    row: "intake>build",
    job: {},
    to: "build",
    facts: f({ intake: { decision: "ACCEPT", kind: "bug", risk: "low", criteria: okLint } }),
    refused: /bugs go to repro/,
  },
  { row: "intake>repro", job: {}, to: "repro", facts: f({ intake: { decision: "ACCEPT", kind: "bug", risk: "low", criteria: okLint } }) },
  {
    row: "intake>repro",
    job: {},
    to: "repro",
    facts: f({ intake: { decision: "ACCEPT", kind: "bug", risk: "high", criteria: okLint } }),
    refused: /through spec first/,
  },
  {
    row: "intake>needs-info",
    job: {},
    to: "needs-info",
    facts: f({ intake: { decision: "NEEDS-INFO" }, why: "which page?" }),
    expect: (j) => assert.equal(j.pausedReason, "which page?"),
  },
  { row: "intake>needs-info", job: {}, to: "needs-info", facts: f({ intake: { decision: "ACCEPT" } }), refused: /not NEEDS-INFO/ },
  { row: "intake>rejected", job: {}, to: "rejected", facts: f({ intake: { decision: "REJECT" } }) },
  { row: "intake>rejected", job: {}, to: "rejected", facts: f({}), refused: /no intake facts/ },
  // needs-info
  { row: "needs-info>intake", job: { stage: "needs-info" }, to: "intake", facts: f({ replied: true }) },
  { row: "needs-info>intake", job: { stage: "needs-info" }, to: "intake", facts: f({}), refused: /no reply/ },
  { row: "needs-info>rejected", job: { stage: "needs-info" }, to: "rejected", facts: f({ operator: "reject" }) },
  { row: "needs-info>rejected", job: { stage: "needs-info" }, to: "rejected", facts: f({ operator: "feedback" }), refused: /kitchen reject/ },
  // spec
  { row: "spec>repro", job: { stage: "spec", kind: "bug" }, to: "repro", facts: f({ spec: okLint }) },
  { row: "spec>repro", job: { stage: "spec", kind: "feature" }, to: "repro", facts: f({ spec: okLint }), refused: /not bug/ },
  { row: "spec>build", job: { stage: "spec", kind: "feature" }, to: "build", facts: f({ spec: okLint }) },
  {
    row: "spec>build",
    job: { stage: "spec", kind: "feature" },
    to: "build",
    facts: f({ spec: { ok: false, reason: "duplicate id C2" } }),
    refused: /duplicate id C2/,
  },
  {
    row: "spec>toolkit",
    job: { stage: "spec" },
    to: "toolkit",
    facts: f({ spec: { ok: false, missingPrimitive: "sql" } }),
    expect: (j) => {
      assert.equal(j.returnTo, "spec");
      assert.equal(j.smith.attempts, 1);
      assert.equal(j.gap, "sql");
    },
  },
  {
    row: "spec>toolkit",
    job: { stage: "spec", smith: { attempts: 2, toolkitPr: null } },
    to: "toolkit",
    facts: f({ spec: { ok: false, missingPrimitive: "sql" } }),
    refused: /smith limit/,
    code: "smith-limit",
  },
  // repro
  { row: "repro>build", job: { stage: "repro" }, to: "build", facts: f({ repro: { failedAsExpected: true, onBase: true, committed: true } }) },
  {
    row: "repro>build",
    job: { stage: "repro" },
    to: "build",
    facts: f({ repro: { failedAsExpected: true, onBase: false, committed: true } }),
    refused: /base sha/,
  },
  {
    row: "repro>toolkit",
    job: { stage: "repro" },
    to: "toolkit",
    facts: f({ repro: { failedAsExpected: false, onBase: true, committed: false, missingPrimitive: "sql" } }),
    expect: (j) => assert.equal(j.returnTo, "repro"),
  },
  {
    row: "repro>toolkit",
    job: { stage: "repro" },
    to: "toolkit",
    facts: f({ repro: { failedAsExpected: false, onBase: true, committed: false } }),
    refused: /no missing primitive/,
  },
  {
    row: "repro>repro",
    job: { stage: "repro" },
    to: "repro",
    facts: f({ repro: { failedAsExpected: false, onBase: true, committed: false } }),
    expect: (j) => assert.equal(j.attempts.repro, 1),
  },
  {
    row: "repro>repro",
    job: { stage: "repro", attempts: { ...baseJob().attempts, repro: 1 } },
    to: "repro",
    facts: f({ repro: { failedAsExpected: false, onBase: true, committed: false } }),
    refused: /second try failed/,
  },
  {
    row: "repro>needs-info",
    job: { stage: "repro", attempts: { ...baseJob().attempts, repro: 1 } },
    to: "needs-info",
    facts: f({ repro: { failedAsExpected: false, onBase: true, committed: false } }),
  },
  {
    row: "repro>needs-info",
    job: { stage: "repro" },
    to: "needs-info",
    facts: f({ repro: { failedAsExpected: false, onBase: true, committed: false } }),
    refused: /only 1 try/,
  },
  // build
  {
    row: "build>gate",
    job: { stage: "build" },
    to: "gate",
    facts: f({ build: { status: "READY", committed: true, pushed: true, pr: 7, localForge: false } }),
    expect: (j) => assert.equal(j.pr, 7),
  },
  {
    row: "build>gate",
    job: { stage: "build" },
    to: "gate",
    facts: f({ build: { status: "READY", committed: true, pushed: false, pr: null, localForge: true } }),
  },
  {
    row: "build>gate",
    job: { stage: "build" },
    to: "gate",
    facts: f({ build: { status: "READY", committed: true, pushed: true, pr: null, localForge: false } }),
    refused: /no draft PR/,
  },
  {
    row: "build>gate",
    job: { stage: "build" },
    to: "gate",
    facts: f({ build: { status: "READY", committed: false, pushed: false, pr: null, localForge: true } }),
    refused: /nothing committed/,
  },
  {
    row: "build>needs-human",
    job: { stage: "build" },
    to: "needs-human",
    facts: f({ build: { status: "BLOCKED", committed: false, pushed: false, pr: null, localForge: true } }),
  },
  {
    row: "build>needs-human",
    job: { stage: "build" },
    to: "needs-human",
    facts: f({ build: { status: "READY", committed: true, pushed: false, pr: null, localForge: true } }),
    refused: /not BLOCKED/,
  },
  // gate
  {
    row: "gate>drives",
    job: { stage: "gate", risk: "low" },
    to: "drives",
    facts: f({ gate: { ...gate("PASS"), riskFloor: "high" } }),
    expect: (j) => assert.equal(j.riskFloor, "high"),
  },
  {
    row: "gate>drives",
    job: { stage: "gate", riskFloor: "high" },
    to: "drives",
    facts: f({ gate: { ...gate("PASS"), riskFloor: "low" } }),
    expect: (j) => assert.equal(j.riskFloor, "high"),
  },
  { row: "gate>drives", job: { stage: "gate" }, to: "drives", facts: f({ gate: gate("PASS", "c".repeat(40)) }), refused: /gate.md is for cccccccc/ },
  { row: "gate>build", job: { stage: "gate" }, to: "build", facts: f({ gate: gate("FAIL") }), expect: (j) => assert.equal(j.round, 2) },
  { row: "gate>build", job: { stage: "gate", ...spent }, to: "build", facts: f({ gate: gate("FAIL") }), refused: /round limit: 3 of 3/, code: "round-limit" },
  // drives
  { row: "drives>verify", job: { stage: "drives" }, to: "verify", facts: f({ drives: { gateValid: true, resolved: true, featureChecks: true } }) },
  {
    row: "drives>verify",
    job: { stage: "drives" },
    to: "verify",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: true } }),
    refused: /does not resolve/,
  },
  { row: "drives>gate", job: { stage: "drives" }, to: "gate", facts: f({ drives: { gateValid: false, resolved: true, featureChecks: true } }) },
  {
    row: "drives>gate",
    job: { stage: "drives" },
    to: "gate",
    facts: f({ drives: { gateValid: true, resolved: true, featureChecks: true } }),
    refused: /still valid/,
  },
  {
    row: "drives>toolkit",
    job: { stage: "drives" },
    to: "toolkit",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: false, missingPrimitive: "drag" } }),
    expect: (j) => assert.equal(j.returnTo, "drives"),
  },
  {
    row: "drives>toolkit",
    job: { stage: "drives", smith: { attempts: 2, toolkitPr: 4 } },
    to: "toolkit",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: false, missingPrimitive: "drag" } }),
    refused: /smith limit/,
    code: "smith-limit",
  },
  {
    row: "drives>build",
    job: { stage: "drives" },
    to: "build",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: false, unreachable: true } }),
    expect: (j) => assert.equal(j.round, 2),
  },
  {
    row: "drives>build",
    job: { stage: "drives", ...spent },
    to: "build",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: false, unreachable: true } }),
    refused: /round limit/,
    code: "round-limit",
  },
  {
    row: "drives>drives",
    job: { stage: "drives" },
    to: "drives",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: false, writeFailed: true } }),
    expect: (j) => assert.equal(j.attempts.drives, 1),
  },
  {
    row: "drives>drives",
    job: { stage: "drives", attempts: { ...baseJob().attempts, drives: 1 } },
    to: "drives",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: false, writeFailed: true } }),
    refused: /second drive attempt/,
  },
  {
    row: "drives>needs-human",
    job: { stage: "drives", attempts: { ...baseJob().attempts, drives: 1 } },
    to: "needs-human",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: false, writeFailed: true } }),
  },
  {
    row: "drives>needs-human",
    job: { stage: "drives" },
    to: "needs-human",
    facts: f({ drives: { gateValid: true, resolved: false, featureChecks: false, writeFailed: true } }),
    refused: /only 1 failed attempt/,
  },
  // verify
  {
    row: "verify>review",
    job: { stage: "verify", attempts: { ...baseJob().attempts, inconclusive: 1 } },
    to: "review",
    facts: f({ verify: verify("PASS") }),
    expect: (j) => assert.equal(j.attempts.inconclusive, 0),
  },
  {
    row: "verify>review",
    job: { stage: "verify" },
    to: "review",
    facts: f({ verify: verify("PASS", { citationsOk: false }) }),
    refused: /cited id is not stamped/,
  },
  { row: "verify>build", job: { stage: "verify" }, to: "build", facts: f({ verify: verify("FAIL") }), expect: (j) => assert.equal(j.round, 2) },
  { row: "verify>build", job: { stage: "verify", ...spent }, to: "build", facts: f({ verify: verify("FAIL") }), refused: /round limit/, code: "round-limit" },
  { row: "verify>verify", job: { stage: "verify" }, to: "verify", facts: f({ verify: verify("INCONCLUSIVE") }), expect: (j) => assert.equal(j.round, 1) },
  {
    row: "verify>verify",
    job: { stage: "verify", attempts: { ...baseJob().attempts, inconclusive: 1 } },
    to: "verify",
    facts: f({ verify: verify("INCONCLUSIVE") }),
    refused: /free retry is used/,
  },
  {
    row: "verify>paused",
    job: { stage: "verify", attempts: { ...baseJob().attempts, inconclusive: 1 } },
    to: "paused",
    facts: f({ verify: verify("INCONCLUSIVE", { ticket: "T1" }) }),
    expect: (j) => {
      assert.equal(j.waitFor, "toolkit-ticket");
      assert.equal(j.pausedFrom, "verify");
      assert.equal(j.toolkitTicketRef, "T1");
      assert.equal(j.attempts.toolkitTicket, 1);
      assert.equal(j.round, 1);
    },
  },
  {
    row: "verify>paused",
    job: { stage: "verify", attempts: { ...baseJob().attempts, inconclusive: 1 } },
    to: "paused",
    facts: f({ verify: verify("INCONCLUSIVE") }),
    refused: /no Toolkit ticket filed/,
  },
  {
    row: "verify>needs-human",
    job: { stage: "verify", attempts: { ...baseJob().attempts, inconclusive: 1, toolkitTicket: 1 } },
    to: "needs-human",
    facts: f({ verify: verify("INCONCLUSIVE") }),
  },
  {
    row: "verify>needs-human",
    job: { stage: "verify", attempts: { ...baseJob().attempts, inconclusive: 1 } },
    to: "needs-human",
    facts: f({ verify: verify("INCONCLUSIVE") }),
    refused: /pause first/,
  },
  {
    row: "verify>toolkit",
    job: { stage: "verify" },
    to: "toolkit",
    facts: f({ verify: verify("TOOLKIT-GAP", { doctorOk: true, gapPrimitive: "drag" }) }),
    expect: (j) => assert.equal(j.returnTo, "drives"),
  },
  {
    row: "verify>toolkit",
    job: { stage: "verify" },
    to: "toolkit",
    facts: f({ verify: verify("TOOLKIT-GAP", { doctorOk: false, gapPrimitive: "drag" }) }),
    refused: /doctor is not ok/,
  },
  // toolkit
  ...(["spec", "repro", "drives"] as const).flatMap((to): Case[] => [
    {
      row: `toolkit>${to}`,
      job: { stage: "toolkit", returnTo: to, gap: "sql" },
      to,
      facts: f({ toolkit: { checkPassed: true, sha: "t1", pr: 9 } }),
      expect: (j) => {
        assert.equal(j.toolkitRef, "t1");
        assert.equal(j.smith.toolkitPr, 9);
        assert.equal(j.returnTo, null);
      },
    },
    {
      row: `toolkit>${to}`,
      job: { stage: "toolkit", returnTo: to },
      to,
      facts: f({ toolkit: { checkPassed: false, sha: "t1", pr: 9 } }),
      refused: /toolkit check fails/,
    },
  ]),
  {
    row: "toolkit>spec",
    job: { stage: "toolkit", returnTo: "drives" },
    to: "spec",
    facts: f({ toolkit: { checkPassed: true, sha: "t1", pr: 9 } }),
    refused: /returnTo is drives/,
  },
  // review
  { row: "review>ready", job: { stage: "review" }, to: "ready", facts: f({ review: { pass: true } }) },
  { row: "review>ready", job: { stage: "review" }, to: "ready", facts: f({ review: { pass: false, blocking: "x" } }), refused: /did not PASS/ },
  {
    row: "review>build",
    job: { stage: "review" },
    to: "build",
    facts: f({ review: { pass: false, blocking: "sql injection" } }),
    expect: (j) => assert.equal(j.round, 2),
  },
  {
    row: "review>build",
    job: { stage: "review", ...spent },
    to: "build",
    facts: f({ review: { pass: false, blocking: "x" } }),
    refused: /round limit/,
    code: "round-limit",
  },
  // ready
  { row: "ready>report", job: { stage: "ready" }, to: "report", facts: f({ ready: ready() }) },
  { row: "ready>report", job: { stage: "ready" }, to: "report", facts: f({ ready: ready({ ci: "pending" }) }), refused: /CI is pending/ },
  { row: "ready>drives", job: { stage: "ready" }, to: "drives", facts: f({ ready: ready({ baseMoved: true }) }) },
  { row: "ready>drives", job: { stage: "ready" }, to: "drives", facts: f({ ready: ready() }), refused: /base did not move/ },
  { row: "ready>paused", job: { stage: "ready" }, to: "paused", facts: f({ ready: ready({ ci: "pending" }) }), expect: (j) => assert.equal(j.waitFor, "ci") },
  {
    row: "ready>paused",
    job: { stage: "ready" },
    to: "paused",
    facts: f({ ready: ready({ toolkitPr: "open" }) }),
    expect: (j) => assert.equal(j.waitFor, "toolkit-pr"),
  },
  { row: "ready>paused", job: { stage: "ready" }, to: "paused", facts: f({ ready: ready() }), refused: /neither CI pending/ },
  { row: "ready>build", job: { stage: "ready" }, to: "build", facts: f({ ready: ready({ ci: "fail" }) }), expect: (j) => assert.equal(j.round, 2) },
  { row: "ready>build", job: { stage: "ready" }, to: "build", facts: f({ ready: ready() }), refused: /no conflict, red CI/ },
  { row: "ready>gate", job: { stage: "ready" }, to: "gate", facts: f({ ready: ready({ gatePass: false }) }) },
  { row: "ready>gate", job: { stage: "ready" }, to: "gate", facts: f({ ready: ready() }), refused: /gate is PASS on this HEAD/ },
  // paused
  ...(["intake", "spec", "repro", "build", "gate", "drives", "verify", "toolkit", "review", "ready", "report"] as const).flatMap((to): Case[] => [
    {
      row: `paused>${to}`,
      job: { stage: "paused", pausedFrom: to, waitFor: "backoff", until: NOW, pausedReason: "rate limited" },
      to,
      facts: f({ waitCleared: true }),
      expect: (j) => {
        assert.equal(j.waitFor, undefined);
        assert.equal(j.pausedReason, undefined);
      },
    },
    { row: `paused>${to}`, job: { stage: "paused", pausedFrom: to, waitFor: "ci" }, to, facts: f({}), refused: /still waiting for ci/ },
  ]),
  {
    row: "paused>verify",
    job: { stage: "paused", pausedFrom: "build", waitFor: "backoff" },
    to: "verify",
    facts: f({ waitCleared: true }),
    refused: /paused from build/,
  },
  { row: "paused>ready", job: { stage: "paused", pausedFrom: "ready", waitFor: "toolkit-pr" }, to: "ready", facts: f({ operator: "resume" }) },
  // report
  { row: "report>done", job: { stage: "report" }, to: "done", facts: f({ report: report() }) },
  { row: "report>done", job: { stage: "report" }, to: "done", facts: f({ report: report({ localForge: true, evidencePushed: false, commented: false }) }) },
  { row: "report>done", job: { stage: "report" }, to: "done", facts: f({ report: report({ commented: false }) }), refused: /PR comment not posted/ },
  {
    row: "report>report",
    job: { stage: "report" },
    to: "report",
    facts: f({ report: report({ rendered: false, refusal: "unknown id e99" }) }),
    expect: (j) => assert.equal(j.attempts.render, 1),
  },
  {
    row: "report>report",
    job: { stage: "report", attempts: { ...baseJob().attempts, render: 1 } },
    to: "report",
    facts: f({ report: report({ rendered: false, refusal: "e99" }) }),
    refused: /refused twice/,
  },
  {
    row: "report>needs-human",
    job: { stage: "report", attempts: { ...baseJob().attempts, render: 1 } },
    to: "needs-human",
    facts: f({ report: report({ rendered: false, refusal: "e99" }) }),
  },
  {
    row: "report>needs-human",
    job: { stage: "report" },
    to: "needs-human",
    facts: f({ report: report({ rendered: false, refusal: "e99" }) }),
    refused: /first refusal/,
  },
  // done
  {
    row: "done>build",
    job: { stage: "done", round: 3, roundStart: 1 },
    to: "build",
    facts: f({ operator: "feedback" }),
    expect: (j) => {
      assert.equal(j.round, 4);
      assert.equal(j.roundStart, 4);
    },
  },
  { row: "done>build", job: { stage: "done" }, to: "build", facts: f({}), refused: /kitchen feedback/ },
  // any active stage
  {
    row: "*>paused",
    job: { stage: "build" },
    to: "paused",
    facts: f({ adapter: { rateLimited: true, until: "2026-11-22T10:05:00.000Z" } }),
    expect: (j) => {
      assert.equal(j.pausedFrom, "build");
      assert.equal(j.waitFor, "backoff");
      assert.equal(j.until, "2026-11-22T10:05:00.000Z");
      assert.equal(j.attempts.backoff, 1);
    },
  },
  {
    row: "*>paused",
    job: { stage: "verify" },
    to: "paused",
    facts: f({ adapter: { authFailure: true, until: NOW } }),
    expect: (j) => assert.equal(j.pausedFrom, "verify"),
  },
  { row: "*>paused", job: { stage: "build" }, to: "paused", facts: f({ adapter: { error: "boom" } }), refused: /no rate limit/ },
  { row: "*>paused", job: { stage: "needs-human" }, to: "paused", facts: f({ adapter: { rateLimited: true, until: NOW } }), refused: /runs no agent/ },
  {
    row: "*>needs-human",
    job: { stage: "gate", ...spent },
    to: "needs-human",
    facts: f({ escalate: "round-limit" }),
    expect: (j) => assert.match(j.pausedReason ?? "", /round-limit/),
  },
  { row: "*>needs-human", job: { stage: "gate" }, to: "needs-human", facts: f({ escalate: "round-limit" }), refused: /round budget left/ },
  { row: "*>needs-human", job: { stage: "spec", smith: { attempts: 2, toolkitPr: null } }, to: "needs-human", facts: f({ escalate: "smith-limit" }) },
  { row: "*>needs-human", job: { stage: "build", attempts: { ...baseJob().attempts, errors: 1 } }, to: "needs-human", facts: f({ escalate: "adapter-error" }) },
  { row: "*>needs-human", job: { stage: "build" }, to: "needs-human", facts: f({ escalate: "adapter-error" }), refused: /first adapter-error/ },
  {
    row: "*>needs-human",
    job: { stage: "spec", attempts: { ...baseJob().attempts, errors: 1 } },
    to: "needs-human",
    facts: f({ escalate: "engine-error", why: "worktree" }),
    expect: (j) => {
      assert.match(j.pausedReason ?? "", /^engine-error: worktree/);
      assert.equal(j.escalatedFrom, "spec");
    },
  },
  { row: "*>needs-human", job: { stage: "spec" }, to: "needs-human", facts: f({ escalate: "engine-error" }), refused: /first engine-error/ },
  { row: "*>needs-human", job: { stage: "drives", attempts: { ...baseJob().attempts, refused: 1 } }, to: "needs-human", facts: f({ escalate: "refused" }) },
  { row: "*>needs-human", job: { stage: "done" }, to: "needs-human", facts: f({ escalate: "round-limit" }), refused: /done is not an active stage/ },
  // needs-human
  {
    row: "needs-human>build",
    job: { stage: "needs-human", round: 3 },
    to: "build",
    facts: f({ operator: "feedback" }),
    expect: (j) => assert.equal(j.roundStart, 4),
  },
  { row: "needs-human>build", job: { stage: "needs-human" }, to: "build", facts: f({ operator: "reject" }), refused: /kitchen feedback/ },
  // feedback returns to the stage the job escalated from; `--to` overrides it (ADR 0007)
  ...(["intake", "spec", "repro", "build", "gate", "drives", "verify", "toolkit", "review", "ready", "report"] as const).flatMap((to): Case[] => [
    {
      row: `needs-human>${to}`,
      job: { stage: "needs-human", escalatedFrom: to, round: 2 },
      to,
      facts: f({ operator: "feedback" }),
      expect: (j) => {
        assert.equal(j.round, 3);
        assert.equal(j.escalatedFrom, undefined);
      },
    },
    {
      row: `needs-human>${to}`,
      job: { stage: "needs-human", escalatedFrom: to === "spec" ? "repro" : "spec" },
      to,
      facts: f({ operator: "feedback" }),
      refused: /feedback goes to (spec|repro) \(where it escalated from\)/,
    },
  ]),
  { row: "needs-human>build", job: { stage: "needs-human", escalatedFrom: "verify" }, to: "build", facts: f({ operator: "feedback", feedbackTo: "build" }) },
  { row: "needs-human>build", job: { stage: "needs-human" }, to: "build", facts: f({ operator: "feedback", feedbackTo: "build" }) },
  { row: "needs-human>drives", job: { stage: "needs-human", escalatedFrom: "report" }, to: "drives", facts: f({ operator: "feedback", feedbackTo: "drives" }) },
  { row: "needs-human>verify", job: { stage: "needs-human", escalatedFrom: "verify" }, to: "verify", facts: f({ operator: "feedback", feedbackTo: "verify" }) },
  { row: "needs-human>intake", job: { stage: "needs-human", escalatedFrom: "gate" }, to: "intake", facts: f({ operator: "feedback", feedbackTo: "intake" }) },
  {
    row: "needs-human>spec",
    job: { stage: "needs-human", escalatedFrom: "verify" },
    to: "spec",
    facts: f({ operator: "feedback", feedbackTo: "build" }),
    refused: /feedback goes to build \(--to\)/,
  },
  // --to never skips a stage: not past the stage it escalated from, never past verify
  {
    row: "needs-human>build",
    job: { stage: "needs-human", escalatedFrom: "spec" },
    to: "build",
    facts: f({ operator: "feedback", feedbackTo: "build" }),
    refused: /--to build: it is past spec/,
  },
  {
    row: "needs-human>drives",
    job: { stage: "needs-human" },
    to: "drives",
    facts: f({ operator: "feedback", feedbackTo: "drives" }),
    refused: /--to drives: it is past build/,
  },
  ...(["gate", "toolkit", "review", "ready", "report"] as const).map(
    (to): Case => ({
      row: `needs-human>${to}`,
      job: { stage: "needs-human", escalatedFrom: "report" },
      to,
      facts: f({ operator: "feedback", feedbackTo: to }),
      refused: new RegExp(`--to ${to}: feedback goes to one of intake, spec, repro, build, drives, verify`),
    }),
  ),
  { row: "needs-human>rejected", job: { stage: "needs-human" }, to: "rejected", facts: f({ operator: "reject" }) },
  { row: "needs-human>rejected", job: { stage: "needs-human" }, to: "rejected", facts: f({}), refused: /kitchen reject/ },
];

const legal = new Set<string>();
const refused = new Set<string>();

describe("every row of the transition table", () => {
  for (const c of cases) {
    const name = `${c.row}: ${c.refused ? `refused ${c.refused}` : "legal"} (${JSON.stringify(c.facts).slice(0, 90)})`;
    test(name, () => {
      const job = baseJob(c.job);
      const r = move(job, c.to, c.facts);
      if (c.refused) {
        assert.ok("refused" in r, `expected a refusal, moved by ${"row" in r ? r.row : ""}`);
        assert.match(r.refused, c.refused);
        if (c.code) assert.equal(r.code, c.code);
        refused.add(c.row);
      } else {
        assert.ok("job" in r, `refused: ${"refused" in r ? r.refused : ""}`);
        assert.equal(r.row, c.row);
        assert.equal(r.job.stage, c.to);
        assert.equal(r.job.moves, job.moves + 1);
        assert.equal(job.stage, c.job.stage ?? "intake", "move is pure: the input job is unchanged");
        c.expect?.(r.job);
        legal.add(c.row);
      }
    });
  }
  afterAll(() => {
    const ids = TABLE.map((r) => r.id);
    assert.deepEqual(
      ids.filter((id) => !legal.has(id)),
      [],
      "rows without a legal case",
    );
    assert.deepEqual(
      ids.filter((id) => !refused.has(id)),
      [],
      "rows without a refused case",
    );
  });
});

test("a move the table doesn't have is refused with a reason", () => {
  const r = move(baseJob({ stage: "intake" }), "done", f({}));
  assert.deepEqual(r, { refused: "no move intake → done" });
  const r2 = move(baseJob({ stage: "rejected" }), "build", f({ operator: "feedback" }));
  assert.ok("refused" in r2);
});

test("INCONCLUSIVE path: free retry, then paused with a ticket, then needs-human after the ticket", () => {
  let j = baseJob({ stage: "verify" });
  const step = (to: Stage, facts: Facts) => {
    const r = move(j, to, facts);
    assert.ok("job" in r, "refused" in r ? r.refused : "");
    j = r.job;
  };
  step("verify", f({ verify: verify("INCONCLUSIVE") }));
  assert.ok("refused" in move(j, "verify", f({ verify: verify("INCONCLUSIVE") })));
  step("paused", f({ verify: verify("INCONCLUSIVE", { ticket: "T1" }) }));
  step("verify", f({ waitCleared: true }));
  step("verify", f({ verify: verify("INCONCLUSIVE") })); // free retry again after the ticket
  assert.ok("refused" in move(j, "paused", f({ verify: verify("INCONCLUSIVE", { ticket: "T2" }) })));
  step("needs-human", f({ verify: verify("INCONCLUSIVE") }));
  assert.equal(j.round, 1, "INCONCLUSIVE never costs a round");
});

test("round budget: three rounds, then the →build move refuses with round-limit and needs-human takes it", () => {
  let j = baseJob({ stage: "verify" });
  for (let i = 0; i < 2; i++) {
    const r = move(j, "build", f({ verify: verify("FAIL") }));
    assert.ok("job" in r);
    j = { ...r.job, stage: "verify" };
  }
  const r = move(j, "build", f({ verify: verify("FAIL") }));
  assert.ok("refused" in r && r.code === "round-limit");
  const h = move(j, "needs-human", f({ escalate: "round-limit" }));
  assert.ok("job" in h);
  assert.equal(h.job.escalatedFrom, "verify");
  const back = move(h.job, "build", f({ operator: "feedback", feedbackTo: "build" }));
  assert.ok("job" in back);
  assert.equal(back.job.round, 4);
  assert.ok("job" in move({ ...back.job, stage: "verify" }, "build", f({ verify: verify("FAIL") })), "the budget restarted");
});

test("backoff grows across rate limits: kept through paused and its resume, reset by the next other move", () => {
  let j = baseJob({ stage: "build" });
  const step = (to: Stage, facts: Facts) => {
    const r = move(j, to, facts);
    assert.ok("job" in r, "refused" in r ? r.refused : "");
    j = r.job;
  };
  const limited = f({ adapter: { rateLimited: true, until: NOW } });
  for (const n of [1, 2, 3]) {
    step("paused", limited);
    assert.equal(j.attempts.backoff, n, "the pause counts");
    step("build", f({ waitCleared: true }));
    assert.equal(j.attempts.backoff, n, "the resume keeps it");
  }
  step("gate", f({ build: { status: "READY", committed: true, pushed: true, pr: 1, localForge: false } }));
  assert.equal(j.attempts.backoff, 0, "a real move resets it");
});

test("needs-human remembers where it escalated from; feedback goes back there", () => {
  const r = move(baseJob({ stage: "repro", attempts: { ...baseJob().attempts, errors: 1 } }), "needs-human", f({ escalate: "adapter-error" }));
  assert.ok("job" in r);
  assert.equal(r.job.escalatedFrom, "repro");
  assert.ok("refused" in move(r.job, "build", f({ operator: "feedback" })), "not build: that would skip repro");
  const back = move(r.job, "repro", f({ operator: "feedback" }));
  assert.ok("job" in back);
  assert.equal(back.job.escalatedFrom, undefined);
});
