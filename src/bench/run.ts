// `kitchen bench smoke|full|tuned|heldout [--tool claude|codex] [--runs n] [--only a,b]
//   [--concurrency n] [--max-usd x] [--out dir]` (PLAN §8).
//
// Each ticket × run gets its own fixture repo (repo.ts) and its own `kitchen run --once`
// passes until the job ends: done, needs-info, rejected, needs-human, or paused on a
// Toolkit ticket. A job paused on a Toolkit PR has the PR merged by the bench (the human's
// part), then runs on. A `done` job is then judged by its hidden oracle (oracle.ts).
// Scored against bench/set.yaml; one ledger line per run (event "bench") in the repo
// `kitchen bench` runs in, and bench/results/<date>.md + .json.
//
// The laptop: at most `concurrency` jobs at once and at most one Docker fixture (A, C)
// at a time. `--max-usd` stops starting new tickets once the spent total reaches it.
// A failing ticket is recorded as a result, never retried in a loop; only infrastructure
// gets one more try, recorded and counted apart: an oracle's (app startup, an unwell app),
// and an agent adapter's (the job escalated `adapter-error` because the agent tool could
// not run: not in PATH, spawn failed, the network dropped), which runs the ticket again.
// Every result names the Kitchen commit it ran on, and tallies Verify INCONCLUSIVEs and
// flakes per drive from the jobs' Verify proof lines (tally.ts, measures.ts).
// The §0.2 lines are judged by code (section02).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Job } from "../engine/machine.ts";
import { readLocalForge } from "../forge/forge.ts";
import { appendLedger, readLedger } from "../ledger/append.ts";
import { measures } from "../ledger/measures.ts";
import { runOracleRetrying } from "./oracle.ts";
import { agentYaml, FIXTURES, makeBenchRepo, mergeToolkitBranch } from "./repo.ts";
import { type BenchTicket, loadSet, pick, type Tier } from "./set.ts";
import { type DriveSummary, type DriveTally, jobDriveTally, sumDrives } from "./tally.ts";

export type BenchOpts = {
  kitchenRoot: string;
  tier: Tier;
  tool: "claude" | "codex";
  runs: number;
  only?: string[];
  concurrency: number;
  maxUsd: number;
  out: string;
  /** Where the ledger lines go (the repo `kitchen bench` runs in). */
  ledgerRepo: string;
  print: (l: string) => void;
  claudeBin?: string;
  /** Per-ticket wall clock cap. */
  ticketMinutes?: number;
};

export type RunResult = {
  ticket: string;
  fixture: string;
  set: string;
  kind: string;
  trap: boolean;
  control: boolean;
  run: number;
  expected: string[];
  outcome: string;
  reason?: string;
  oracle: "pass" | "fail" | "n/a" | "error";
  oracleDetail?: string;
  /** The oracle hit an infrastructure error and ran once more; this was the first error. */
  oracleRetried?: string;
  /** The first run of this ticket ended on an agent adapter's infrastructure error; this is the rerun, and this was that error. */
  agentInfraRetried?: string;
  toolkitPr: boolean;
  correct: boolean;
  /** Why the run is not correct (expectationMet). */
  miss?: string;
  /** Per-drive Verify INCONCLUSIVEs and flakes in this job (tally.ts). */
  drives?: DriveTally[];
  rounds: number;
  verifyFails: number;
  /** Verify proof runs (W5 `proof` ledger lines), how many were INCONCLUSIVE, and the (HEAD, criterion) groups that both passed and failed: a flaky drive. */
  proofRuns?: number;
  inconclusive?: number;
  flaky?: number;
  secs: number;
  usd: number;
  path: string;
  job?: string;
  note?: string;
};

const TERMINAL = ["done", "needs-info", "rejected", "needs-human"];

function kitchenPass(kitchenRoot: string, repo: string, env: NodeJS.ProcessEnv, id: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(kitchenRoot, "src", "cli.ts"), "run", "--once", id, "--repo", repo], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      out += d;
    });
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.on("close", () => {
      clearTimeout(t);
      resolve(out);
    });
  });
}

const readJson = <T>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
};

function jobIdOf(repo: string): string | null {
  const d = path.join(repo, ".kitchen", "jobs");
  return fs.existsSync(d) ? (fs.readdirSync(d).find((x) => /^\d{3,}-/.test(x)) ?? null) : null;
}

/** Pure: is a run what its ticket expects? The outcome, the oracle, the Toolkit PR, and no stage it must never enter. */
export function expectationMet(
  expect: BenchTicket["expect"],
  r: { outcome: string; oracle: RunResult["oracle"]; toolkitPr: boolean; stages: string[] },
): { correct: boolean; miss?: string } {
  const miss = [
    ...(expect.outcome.includes(r.outcome as never) ? [] : [`ended ${r.outcome}, expected ${expect.outcome.join(" / ")}`]),
    ...(r.oracle === "pass" || r.oracle === "n/a" ? [] : [`oracle ${r.oracle}`]),
    ...(expect.toolkit_pr && !r.toolkitPr ? ["no Toolkit PR"] : []),
    ...(expect.never ?? []).filter((s) => r.stages.includes(s)).map((s) => `went through ${s}`),
  ];
  return miss.length ? { correct: false, miss: miss.join("; ") } : { correct: true };
}

/** The Kitchen commit the bench runs on (its own repo, read plainly): the sha, and whether the tree has changes. */
export function kitchenRev(kitchenRoot: string): { sha: string; dirty: boolean } {
  const git = (...a: string[]) => execFileSync("git", ["-C", kitchenRoot, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0 };
  } catch {
    return { sha: "unknown", dirty: true };
  }
}

/** Ledger facts of one job: cost, the stage path, verify FAILs, INCONCLUSIVE and flaky proofs. */
function jobFacts(
  repo: string,
  id: string,
): {
  usd: number;
  path: string;
  stages: string[];
  verifyFails: number;
  proofRuns: number;
  inconclusive: number;
  flaky: number;
  drives: DriveTally[];
} {
  const lines = readLedger(repo).filter((l) => l.job === id);
  const m = measures(lines);
  const usd = lines.filter((l) => l.event === "agent").reduce((n, l) => n + (l.usd ?? 0), 0);
  const moves = lines.filter((l) => l.event === "move");
  const stages = moves.length ? [moves[0].stage, ...moves.map((m) => String(m.result))] : [];
  const rounds = path.join(repo, ".kitchen", "jobs", id, "rounds");
  let verifyFails = 0;
  if (fs.existsSync(rounds))
    for (const r of fs.readdirSync(rounds))
      for (const f of fs.readdirSync(path.join(rounds, r)).filter((x) => /^verdict-m\d+\.md$/.test(x)))
        if (/^VERDICT:\s*FAIL/m.test(fs.readFileSync(path.join(rounds, r, f), "utf8"))) verifyFails++;
  return {
    usd,
    path: stages.join(" → "),
    stages,
    verifyFails,
    proofRuns: m.proofs.runs,
    inconclusive: m.proofs.inconclusive,
    flaky: m.proofs.flakyGroups,
    drives: jobDriveTally(m.drives),
  };
}

/** An agent adapter's infrastructure error (the tool could not run), not a judgment: from the job's escalation. Pure. */
export function agentInfraError(r: Pick<RunResult, "outcome" | "reason">): boolean {
  return (
    r.outcome === "needs-human" &&
    /adapter-error/.test(r.reason ?? "") &&
    /not found in PATH|ENOENT|EACCES|spawn|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|fetch failed/i.test(r.reason ?? "")
  );
}

async function runOne(o: BenchOpts, t: BenchTicket, n: number, home: string, suffix = ""): Promise<RunResult> {
  const t0 = Date.now();
  const dir = path.join(o.out, "repos", `${t.id}-${n}${suffix}`);
  const log = path.join(o.out, "logs", `${t.id}-${n}${suffix}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const say = (m: string) => fs.appendFileSync(log, `${m}\n`);
  const base: Omit<RunResult, "outcome" | "oracle" | "correct" | "secs" | "usd" | "path" | "rounds" | "verifyFails" | "toolkitPr"> = {
    ticket: t.id,
    fixture: t.fixture,
    set: t.set,
    kind: t.kind,
    trap: !!t.trap,
    control: t.kind === "control",
    run: n,
    expected: t.expect.outcome,
  };
  const repo = makeBenchRepo(o.kitchenRoot, t, dir, agentYaml(o.tool, o.claudeBin ?? process.env.KITCHEN_CLAUDE_BIN ?? "claude"));
  const env = { ...process.env, KITCHEN_HOME: home, KITCHEN_TICK_MS: "200" };
  // the ticket
  await new Promise<void>((res) => {
    const p = spawn(process.execPath, [path.join(o.kitchenRoot, "src", "cli.ts"), "ticket", t.text, "--repo", repo], { env, stdio: "ignore" });
    p.on("close", () => res());
  });
  const id = jobIdOf(repo);
  if (!id)
    return {
      ...base,
      outcome: "error",
      reason: "no job created",
      oracle: "n/a",
      correct: false,
      secs: 0,
      usd: 0,
      path: "",
      rounds: 0,
      verifyFails: 0,
      toolkitPr: false,
    };
  const deadline = t0 + (o.ticketMinutes ?? 50) * 60_000;
  let job = readJson<Job>(path.join(repo, ".kitchen", "jobs", id, "job.json")) as Job;
  let note = "";
  let merged = false;
  for (let pass = 0; pass < 80; pass++) {
    if (TERMINAL.includes(job.stage)) break;
    if (Date.now() > deadline) {
      note = `wall-clock cap (${o.ticketMinutes ?? 50} min) at ${job.stage}`;
      break;
    }
    if (job.stage === "paused") {
      if (job.waitFor === "toolkit-pr") {
        const prs = readLocalForge(repo)
          .filter((x) => x.kind === "toolkit-pr")
          .map((x) => ({ n: Number(x.n), branch: String(x.branch) }));
        const pr = prs.find((p) => p.n === job.smith.toolkitPr);
        if (!pr || merged) {
          note = "paused on a Toolkit PR the bench can't find";
          break;
        }
        say(`bench: merging Toolkit PR ${pr.n} (${pr.branch}) as the human`);
        mergeToolkitBranch(repo, pr.branch);
        merged = true;
      } else if (job.waitFor === "backoff") {
        const wait = Math.max(0, Date.parse(job.until ?? "") - Date.now());
        say(`bench: backoff ${Math.round(wait / 1000)} s`);
        await new Promise((r) => setTimeout(r, Math.min(wait + 500, 10 * 60_000)));
      } else {
        note = `paused on ${job.waitFor}`;
        break;
      }
    }
    say(await kitchenPass(o.kitchenRoot, repo, env, id, Math.max(60_000, deadline - Date.now())));
    job = readJson<Job>(path.join(repo, ".kitchen", "jobs", id, "job.json")) ?? job;
  }
  const outcome = job.stage === "paused" ? `paused(${job.waitFor})` : job.stage;
  const facts = jobFacts(repo, id);
  let oracle: RunResult["oracle"] = "n/a";
  let oracleDetail: string | undefined;
  let oracleRetried: string | undefined;
  if (outcome === "done" && t.oracle) {
    const r = await runOracleRetrying({ kitchenRoot: o.kitchenRoot, repo, branch: job.branch, ticket: t, testCmd: FIXTURES[t.fixture].testCmd, log: say });
    oracle = r.error ? "error" : r.pass ? "pass" : "fail";
    oracleDetail = r.error ?? r.results.map((x) => `${x.id} ${x.status}${x.why ? `: ${x.why}` : ""}`).join("; ");
    oracleRetried = r.retried;
  }
  const toolkitPr = job.smith.toolkitPr !== null;
  const { correct, miss } = expectationMet(t.expect, { outcome, oracle, toolkitPr, stages: facts.stages });
  return {
    ...base,
    job: id,
    outcome,
    reason: job.pausedReason,
    oracle,
    oracleDetail,
    oracleRetried,
    toolkitPr,
    correct,
    miss,
    drives: facts.drives,
    rounds: job.round,
    verifyFails: facts.verifyFails,
    proofRuns: facts.proofRuns,
    inconclusive: facts.inconclusive,
    flaky: facts.flaky,
    secs: Math.round((Date.now() - t0) / 1000),
    usd: Math.round(facts.usd * 1000) / 1000,
    path: facts.path,
    note: note || undefined,
  };
}

export type Summary = {
  runs: number;
  correct: number;
  rate: number;
  traps: { runs: number; caught: number };
  controls: { runs: number; falseFails: number };
  tuned: { runs: number; correct: number };
  heldout: { runs: number; correct: number };
  usd: number;
  secs: number;
  /** Over the runs that recorded proof lines (W5 on); null when none did. */
  proofs: { runs: number; inconclusive: number; flaky: number } | null;
  /** Oracles run a second time after an infrastructure error. */
  oracleRetries: number;
  /** Tickets run a second time after an agent adapter's infrastructure error. */
  agentInfraRetries: number;
  /** Per fixture and drive, across every run: Verify INCONCLUSIVEs and jobs where it flaked. */
  drives: DriveSummary[];
};

/** Pure: the §0.2 numbers from the results. */
export function summarize(rs: RunResult[]): Summary {
  const rate = (xs: RunResult[]) => ({ runs: xs.length, correct: xs.filter((r) => r.correct).length });
  const traps = rs.filter((r) => r.trap);
  const controls = rs.filter((r) => r.control);
  return {
    runs: rs.length,
    correct: rs.filter((r) => r.correct).length,
    rate: rs.length ? rs.filter((r) => r.correct).length / rs.length : 0,
    traps: { runs: traps.length, caught: traps.filter((r) => r.correct).length },
    controls: { runs: controls.length, falseFails: controls.reduce((n, r) => n + r.verifyFails, 0) },
    tuned: rate(rs.filter((r) => r.set === "tuned")),
    heldout: rate(rs.filter((r) => r.set === "heldout")),
    usd: Math.round(rs.reduce((n, r) => n + r.usd, 0) * 1000) / 1000,
    secs: rs.reduce((n, r) => n + r.secs, 0),
    proofs: rs.some((r) => r.proofRuns !== undefined)
      ? {
          runs: rs.reduce((n, r) => n + (r.proofRuns ?? 0), 0),
          inconclusive: rs.reduce((n, r) => n + (r.inconclusive ?? 0), 0),
          flaky: rs.reduce((n, r) => n + (r.flaky ?? 0), 0),
        }
      : null,
    oracleRetries: rs.filter((r) => r.oracleRetried).length,
    agentInfraRetries: rs.filter((r) => r.agentInfraRetried).length,
    drives: sumDrives(rs),
  };
}

export type Section02Line = { line: string; pass: boolean | null; detail: string };
/**
 * PLAN §0.2, judged by code, one line each (pass null: not measurable in this run):
 *  - at least 85% of runs end in the correct outcome (every run of the tier);
 *  - every planted trap is caught in every run;
 *  - at most 1 false FAIL (a `VERDICT: FAIL` in a control's verdicts) across the tuned set's planted-correct
 *    controls × runs; the controls are named, and the held-out controls are counted beside it;
 *  - the held-out set is no more than 15 points below the tuned set. Pure.
 */
export function section02(rs: RunResult[]): Section02Line[] {
  const pc = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
  const ids = (xs: RunResult[]) => [...new Set(xs.map((r) => r.ticket))].join(", ") || "none";
  const correct = rs.filter((r) => r.correct).length;
  const traps = rs.filter((r) => r.trap);
  const caught = traps.filter((r) => r.correct).length;
  const tunedControls = rs.filter((r) => r.control && r.set === "tuned");
  const heldControls = rs.filter((r) => r.control && r.set === "heldout");
  const ff = (xs: RunResult[]) => xs.reduce((n, r) => n + r.verifyFails, 0);
  const tuned = rs.filter((r) => r.set === "tuned");
  const held = rs.filter((r) => r.set === "heldout");
  const rate = (xs: RunResult[]) => (xs.length ? xs.filter((r) => r.correct).length / xs.length : 0);
  const gap = Math.round(100 * (rate(tuned) - rate(held)));
  return [
    {
      line: "≥85% of runs correct",
      pass: rs.length ? correct / rs.length >= 0.85 : null,
      detail: `${correct}/${rs.length} (${pc(correct, rs.length)})`,
    },
    {
      line: "every trap caught in every run",
      pass: traps.length ? caught === traps.length : null,
      detail: `${caught}/${traps.length} trap runs (${ids(traps)})${
        traps.length > caught
          ? `; missed: ${traps
              .filter((r) => !r.correct)
              .map((r) => `${r.ticket} #${r.run}`)
              .join(", ")}`
          : ""
      }`,
    },
    {
      line: "≤1 false FAIL across the tuned controls × runs",
      pass: tunedControls.length ? ff(tunedControls) <= 1 : null,
      detail: `${ff(tunedControls)} over ${tunedControls.length} runs of ${ids(tunedControls)}; held-out controls (not in this line): ${ff(heldControls)} over ${heldControls.length} runs of ${ids(heldControls)}`,
    },
    {
      line: "held-out within 15 points of tuned",
      pass: tuned.length && held.length ? gap <= 15 : null,
      detail: `tuned ${pc(tuned.filter((r) => r.correct).length, tuned.length)} (${tuned.filter((r) => r.correct).length}/${tuned.length}), held-out ${pc(held.filter((r) => r.correct).length, held.length)} (${held.filter((r) => r.correct).length}/${held.length}), gap ${gap} points`,
    },
  ];
}
/** Pure: the §0.2 lines as text, one per line. */
export const section02Lines = (rs: RunResult[]): string[] =>
  section02(rs).map((l) => `§0.2 ${l.pass === null ? "n/a " : l.pass ? "PASS" : "FAIL"}  ${l.line}: ${l.detail}`);

/** Pure: "INCONCLUSIVE 1/40 (3%), flaky 0" or why there is no count. */
export function proofsLine(p: Summary["proofs"]): string {
  if (!p) return "INCONCLUSIVE and flake: not counted (run before W5's proof ledger lines)";
  const pc = (a: number) => (p.runs ? `${Math.round((100 * a) / p.runs)}%` : "n/a");
  return `INCONCLUSIVE ${p.inconclusive}/${p.runs} proof runs (${pc(p.inconclusive)}), flaky ${p.flaky} (${pc(p.flaky)})`;
}

export const revLabel = (k: { sha: string; dirty: boolean }) => `${k.sha}${k.dirty ? " (dirty: uncommitted changes)" : ""}`;

/** Pure: the results page. */
export function resultsMarkdown(o: {
  tier: string;
  tool: string;
  date: string;
  kitchen: { sha: string; dirty: boolean };
  results: RunResult[];
  skipped: string[];
  wallSecs: number;
}): string {
  const s = summarize(o.results);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
  const cell = (x: string, n: number) => x.replace(/\|/g, "/").slice(0, n);
  return [
    `# Bench ${o.tier} on ${o.tool}, ${o.date}`,
    "",
    `Kitchen ${revLabel(o.kitchen)}`,
    "",
    `${s.correct}/${s.runs} runs correct (${pct(s.correct, s.runs)}). Traps caught ${s.traps.caught}/${s.traps.runs}. False FAILs on controls: ${s.controls.falseFails} over ${s.controls.runs} runs. Tuned ${pct(s.tuned.correct, s.tuned.runs)} (${s.tuned.correct}/${s.tuned.runs}), held-out ${pct(s.heldout.correct, s.heldout.runs)} (${s.heldout.correct}/${s.heldout.runs}). ${proofsLine(s.proofs)}. Agent cost $${s.usd.toFixed(2)}; ticket time ${Math.round(s.secs / 60)} min; wall clock ${Math.round(o.wallSecs / 60)} min.`,
    "",
    "## §0.2",
    "",
    "| line | result | detail |",
    "|---|---|---|",
    ...section02(o.results).map((l) => `| ${l.line} | ${l.pass === null ? "n/a" : l.pass ? "**PASS**" : "**FAIL**"} | ${cell(l.detail, 400)} |`),
    "",
    "## Runs",
    "",
    "| ticket | set | kind | expected | actual | oracle | correct | rounds | verify FAILs | time | cost | path |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...o.results.map(
      (r) =>
        `| ${r.ticket}${r.run > 1 ? ` #${r.run}` : ""} | ${r.set} | ${r.kind}${r.trap ? " (trap)" : ""} | ${r.expected.join(" / ")} | ${r.outcome}${r.reason ? ` (${cell(r.reason, 80)})` : ""}${r.note ? ` [${r.note}]` : ""} | ${r.oracle}${r.oracle === "fail" || r.oracle === "error" ? `: ${cell(r.oracleDetail ?? "", 120)}` : ""}${r.oracleRetried ? ` (retried after: ${cell(r.oracleRetried, 80)})` : ""}${r.agentInfraRetried ? ` [rerun after an agent infrastructure error: ${cell(r.agentInfraRetried, 80)}]` : ""} | ${r.correct ? "yes" : `**no**${r.miss ? ` (${cell(r.miss, 80)})` : ""}`} | ${r.rounds} | ${r.verifyFails} | ${Math.round(r.secs)} s | $${r.usd.toFixed(3)} | ${r.path} |`,
    ),
    ...(o.skipped.length ? ["", `Not run (budget or --only): ${o.skipped.join(", ")}`] : []),
    "",
    "## Drives",
    "",
    "Per drive, across every run, from Verify's proof lines only (the same definition as `kitchen report`): how often a Verify proof run that drove it was INCONCLUSIVE, and in how many jobs it flaked (for one HEAD and criterion, Verify got a PASS and a non-PASS).",
    "",
    ...(s.drives.length
      ? [
          "| fixture | drive | jobs | runs | Verify rows | INCONCLUSIVE | flaky jobs |",
          "|---|---|---|---|---|---|---|",
          ...s.drives.map(
            (d) =>
              `| ${d.fixture} | ${d.drive} | ${d.jobs} | ${d.runs} | ${d.verifies} | ${d.inconclusive} (${pct(d.inconclusive, d.verifies)}) | ${d.flakyJobs} (${pct(d.flakyJobs, d.jobs)}) |`,
          ),
        ]
      : ["No drive ran."]),
    "",
    `Oracles retried after an infrastructure error: ${s.oracleRetries}. Tickets rerun after an agent adapter's infrastructure error: ${s.agentInfraRetries}.`,
    "",
  ].join("\n");
}

export async function runBench(o: BenchOpts): Promise<{ results: RunResult[]; skipped: string[]; file: string }> {
  const all = pick(loadSet(o.kitchenRoot), o.tier, o.only);
  const queue: { t: BenchTicket; n: number }[] = [];
  for (let n = 1; n <= o.runs; n++) for (const t of all) queue.push({ t, n });
  const date = new Date().toISOString().slice(0, 10);
  const runId = `${date}-${o.tier}-${o.tool}-${process.pid}`;
  // Read once, before anything runs: every result says which Kitchen it measured.
  const kitchen = kitchenRev(o.kitchenRoot);
  fs.mkdirSync(o.out, { recursive: true });
  const home = path.join(o.out, "kitchen-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const results: RunResult[] = [];
  const skipped: string[] = [];
  const t0 = Date.now();
  let spent = 0;
  let dockerBusy = 0;
  const inFlight = new Set<Promise<void>>();
  o.print(`bench ${o.tier}: Kitchen ${revLabel(kitchen)}`);
  o.print(`bench ${o.tier}: ${queue.length} runs on ${o.tool}, concurrency ${o.concurrency} (≤1 Docker fixture at a time), budget $${o.maxUsd}`);
  const start = (q: { t: BenchTicket; n: number }) => {
    const docker = FIXTURES[q.t.fixture].docker;
    if (docker) dockerBusy++;
    o.print(`  start ${q.t.id}${o.runs > 1 ? ` #${q.n}` : ""} (${q.t.fixture})`);
    const once = (suffix: string) => runOne(o, q.t, q.n, home, suffix);
    const p = once("")
      .then(async (r) => {
        if (!agentInfraError(r)) return r;
        o.print(`  rerun ${q.t.id}${o.runs > 1 ? ` #${q.n}` : ""}: agent infrastructure error (${(r.reason ?? "").slice(0, 120)})`);
        const again = await once("-rerun");
        return { ...again, usd: Math.round((again.usd + r.usd) * 1000) / 1000, agentInfraRetried: r.reason ?? "adapter-error" };
      })
      .catch(
        (e): RunResult => ({
          ticket: q.t.id,
          fixture: q.t.fixture,
          set: q.t.set,
          kind: q.t.kind,
          trap: !!q.t.trap,
          control: q.t.kind === "control",
          run: q.n,
          expected: q.t.expect.outcome,
          outcome: "error",
          reason: (e as Error).message,
          oracle: "n/a",
          toolkitPr: false,
          correct: false,
          rounds: 0,
          verifyFails: 0,
          secs: 0,
          usd: 0,
          path: "",
        }),
      )
      .then((r) => {
        results.push(r);
        spent += r.usd;
        if (docker) dockerBusy--;
        o.print(
          `  ${r.correct ? "OK  " : "MISS"} ${r.ticket}${o.runs > 1 ? ` #${r.run}` : ""}: expected ${r.expected.join("/")}, got ${r.outcome}, oracle ${r.oracle}, ${r.secs} s, $${r.usd.toFixed(3)} (spent $${spent.toFixed(2)})`,
        );
        appendLedger(o.ledgerRepo, {
          job: `bench:${r.ticket}`,
          stage: "bench",
          round: r.run,
          event: "bench",
          key: `bench/${runId}/${r.ticket}/${r.run}`,
          result: r.correct ? "correct" : "wrong",
          agent: o.tool,
          secs: r.secs,
          usd: r.usd,
          detail: { ...r, tier: o.tier, runId, kitchen },
        });
      });
    const w = p.finally(() => inFlight.delete(w));
    inFlight.add(w);
  };
  while (queue.length || inFlight.size) {
    let progressed = false;
    while (inFlight.size < o.concurrency && queue.length) {
      if (spent >= o.maxUsd) {
        for (const q of queue.splice(0)) skipped.push(`${q.t.id}${o.runs > 1 ? ` #${q.n}` : ""}`);
        break;
      }
      const i = queue.findIndex((q) => !FIXTURES[q.t.fixture].docker || dockerBusy === 0);
      if (i < 0) break;
      start(queue.splice(i, 1)[0]);
      progressed = true;
    }
    if (!inFlight.size) break;
    if (!progressed || inFlight.size >= o.concurrency || !queue.length) await Promise.race(inFlight);
  }
  const order = new Map(all.map((t, i) => [t.id, i]));
  results.sort((a, b) => (order.get(a.ticket) ?? 0) - (order.get(b.ticket) ?? 0) || a.run - b.run);
  const resultsDir = path.join(o.kitchenRoot, "bench", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `${date}-${o.tier}-${o.tool}.md`);
  fs.writeFileSync(file, resultsMarkdown({ tier: o.tier, tool: o.tool, date, kitchen, results, skipped, wallSecs: (Date.now() - t0) / 1000 }));
  fs.writeFileSync(
    file.replace(/\.md$/, ".json"),
    `${JSON.stringify({ runId, kitchen, tier: o.tier, tool: o.tool, results, skipped, summary: summarize(results) }, null, 2)}\n`,
  );
  for (const l of section02Lines(results)) o.print(l);
  o.print(`bench: ${file}`);
  return { results, skipped, file };
}

/** `kitchen report --bench`: the bench runs in the ledger, newest first. */
export function benchReport(repo: string): string[] {
  const lines = readLedger(repo).filter((l) => l.event === "bench");
  const byRun = new Map<string, RunResult[]>();
  const revOf = new Map<string, string>();
  for (const l of lines) {
    const d = l.detail as unknown as RunResult & { runId: string; tier: string; kitchen?: { sha: string; dirty: boolean } };
    const k = `${d.runId}`;
    byRun.set(k, [...(byRun.get(k) ?? []), d]);
    if (d.kitchen) revOf.set(k, `${d.kitchen.sha.slice(0, 12)}${d.kitchen.dirty ? "+dirty" : ""}`);
  }
  if (!byRun.size) return ["no bench runs in the ledger (kitchen bench smoke|full)"];
  const out: string[] = [];
  for (const [runId, rs] of [...byRun.entries()].reverse()) {
    const s = summarize(rs);
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
    out.push(
      `${runId}${revOf.has(runId) ? ` (Kitchen ${revOf.get(runId)})` : ""}: ${s.correct}/${s.runs} correct, traps ${s.traps.caught}/${s.traps.runs}, control false FAILs ${s.controls.falseFails}, tuned ${s.tuned.correct}/${s.tuned.runs}, held-out ${s.heldout.correct}/${s.heldout.runs}, $${s.usd.toFixed(2)} total, median ${med(rs.map((r) => r.secs))} s and $${med(rs.map((r) => r.usd)).toFixed(3)} per ticket; ${proofsLine(s.proofs)}; agent infrastructure reruns ${s.agentInfraRetries}`,
    );
    out.push(...section02Lines(rs).map((l) => `  ${l}`));
    for (const r of rs)
      out.push(
        `  ${r.correct ? "ok  " : "MISS"} ${r.ticket.padEnd(22)} ${r.outcome.padEnd(16)} oracle ${r.oracle.padEnd(5)} ${String(r.secs).padStart(5)} s  $${r.usd.toFixed(3)}`,
      );
  }
  return out;
}
