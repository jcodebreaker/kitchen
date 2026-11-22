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
// A failing ticket is recorded as a result, never retried in a loop.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Job } from "../engine/machine.ts";
import { appendLedger, readLedger } from "../ledger/append.ts";
import { runOracle } from "./oracle.ts";
import { agentYaml, FIXTURES, makeBenchRepo, mergeToolkitBranch } from "./repo.ts";
import { type BenchTicket, loadSet, pick, type Tier } from "./set.ts";

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
  toolkitPr: boolean;
  correct: boolean;
  rounds: number;
  verifyFails: number;
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

/** Ledger facts of one job: cost, the stage path, verify FAILs. */
function jobFacts(repo: string, id: string): { usd: number; path: string; verifyFails: number } {
  const lines = readLedger(repo).filter((l) => l.job === id);
  const usd = lines.filter((l) => l.event === "agent").reduce((n, l) => n + (l.usd ?? 0), 0);
  const moves = lines.filter((l) => l.event === "move");
  const stages = moves.length ? [moves[0].stage, ...moves.map((m) => String(m.result))] : [];
  const rounds = path.join(repo, ".kitchen", "jobs", id, "rounds");
  let verifyFails = 0;
  if (fs.existsSync(rounds))
    for (const r of fs.readdirSync(rounds))
      for (const f of fs.readdirSync(path.join(rounds, r)).filter((x) => /^verdict-m\d+\.md$/.test(x)))
        if (/^VERDICT:\s*FAIL/m.test(fs.readFileSync(path.join(rounds, r, f), "utf8"))) verifyFails++;
  return { usd, path: stages.join(" → "), verifyFails };
}

async function runOne(o: BenchOpts, t: BenchTicket, n: number, home: string): Promise<RunResult> {
  const t0 = Date.now();
  const dir = path.join(o.out, "repos", `${t.id}-${n}`);
  const log = path.join(o.out, "logs", `${t.id}-${n}.log`);
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
        const prs = readJson<{ n: number; branch: string }[]>(path.join(repo, ".kitchen", "toolkit-prs.json")) ?? [];
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
  if (outcome === "done" && t.oracle) {
    const r = await runOracle({ kitchenRoot: o.kitchenRoot, repo, branch: job.branch, ticket: t, testCmd: FIXTURES[t.fixture].testCmd, log: say });
    oracle = r.error ? "error" : r.pass ? "pass" : "fail";
    oracleDetail = r.error ?? r.results.map((x) => `${x.id} ${x.status}${x.why ? `: ${x.why}` : ""}`).join("; ");
  }
  const toolkitPr = job.smith.toolkitPr !== null;
  const correct = t.expect.outcome.includes(outcome as never) && (oracle === "pass" || oracle === "n/a") && (!t.expect.toolkit_pr || toolkitPr);
  return {
    ...base,
    job: id,
    outcome,
    reason: job.pausedReason,
    oracle,
    oracleDetail,
    toolkitPr,
    correct,
    rounds: job.round,
    verifyFails: facts.verifyFails,
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
  };
}

/** Pure: the results page. */
export function resultsMarkdown(o: { tier: string; tool: string; date: string; results: RunResult[]; skipped: string[]; wallSecs: number }): string {
  const s = summarize(o.results);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
  return [
    `# Bench ${o.tier} on ${o.tool}, ${o.date}`,
    "",
    `${s.correct}/${s.runs} runs correct (${pct(s.correct, s.runs)}). Traps caught ${s.traps.caught}/${s.traps.runs}. False FAILs on controls: ${s.controls.falseFails} over ${s.controls.runs} runs. Tuned ${pct(s.tuned.correct, s.tuned.runs)} (${s.tuned.correct}/${s.tuned.runs}), held-out ${pct(s.heldout.correct, s.heldout.runs)} (${s.heldout.correct}/${s.heldout.runs}). Agent cost $${s.usd.toFixed(2)}; ticket time ${Math.round(s.secs / 60)} min; wall clock ${Math.round(o.wallSecs / 60)} min.`,
    "",
    "| ticket | set | kind | expected | actual | oracle | correct | rounds | verify FAILs | time | cost | path |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...o.results.map(
      (r) =>
        `| ${r.ticket}${r.run > 1 ? ` #${r.run}` : ""} | ${r.set} | ${r.kind}${r.trap ? " (trap)" : ""} | ${r.expected.join(" / ")} | ${r.outcome}${r.reason ? ` (${r.reason.replace(/\|/g, "/").slice(0, 80)})` : ""}${r.note ? ` [${r.note}]` : ""} | ${r.oracle}${r.oracle === "fail" || r.oracle === "error" ? `: ${(r.oracleDetail ?? "").replace(/\|/g, "/").slice(0, 120)}` : ""} | ${r.correct ? "yes" : "**no**"} | ${r.rounds} | ${r.verifyFails} | ${Math.round(r.secs)} s | $${r.usd.toFixed(3)} | ${r.path} |`,
    ),
    ...(o.skipped.length ? ["", `Not run (budget or --only): ${o.skipped.join(", ")}`] : []),
    "",
  ].join("\n");
}

export async function runBench(o: BenchOpts): Promise<{ results: RunResult[]; skipped: string[]; file: string }> {
  const all = pick(loadSet(o.kitchenRoot), o.tier, o.only);
  const queue: { t: BenchTicket; n: number }[] = [];
  for (let n = 1; n <= o.runs; n++) for (const t of all) queue.push({ t, n });
  const date = new Date().toISOString().slice(0, 10);
  const runId = `${date}-${o.tier}-${o.tool}-${process.pid}`;
  fs.mkdirSync(o.out, { recursive: true });
  const home = path.join(o.out, "kitchen-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const results: RunResult[] = [];
  const skipped: string[] = [];
  const t0 = Date.now();
  let spent = 0;
  let dockerBusy = 0;
  const inFlight = new Set<Promise<void>>();
  o.print(`bench ${o.tier}: ${queue.length} runs on ${o.tool}, concurrency ${o.concurrency} (≤1 Docker fixture at a time), budget $${o.maxUsd}`);
  const start = (q: { t: BenchTicket; n: number }) => {
    const docker = FIXTURES[q.t.fixture].docker;
    if (docker) dockerBusy++;
    o.print(`  start ${q.t.id}${o.runs > 1 ? ` #${q.n}` : ""} (${q.t.fixture})`);
    const p = runOne(o, q.t, q.n, home)
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
          detail: { ...r, tier: o.tier, runId },
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
  fs.writeFileSync(file, resultsMarkdown({ tier: o.tier, tool: o.tool, date, results, skipped, wallSecs: (Date.now() - t0) / 1000 }));
  fs.writeFileSync(
    file.replace(/\.md$/, ".json"),
    `${JSON.stringify({ runId, tier: o.tier, tool: o.tool, results, skipped, summary: summarize(results) }, null, 2)}\n`,
  );
  o.print(`bench: ${file}`);
  return { results, skipped, file };
}

/** `kitchen report --bench`: the bench runs in the ledger, newest first. */
export function benchReport(repo: string): string[] {
  const lines = readLedger(repo).filter((l) => l.event === "bench");
  const byRun = new Map<string, RunResult[]>();
  for (const l of lines) {
    const d = l.detail as unknown as RunResult & { runId: string; tier: string };
    const k = `${d.runId}`;
    byRun.set(k, [...(byRun.get(k) ?? []), d]);
  }
  if (!byRun.size) return ["no bench runs in the ledger (kitchen bench smoke|full)"];
  const out: string[] = [];
  for (const [runId, rs] of [...byRun.entries()].reverse()) {
    const s = summarize(rs);
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
    out.push(
      `${runId}: ${s.correct}/${s.runs} correct, traps ${s.traps.caught}/${s.traps.runs}, control false FAILs ${s.controls.falseFails}, tuned ${s.tuned.correct}/${s.tuned.runs}, held-out ${s.heldout.correct}/${s.heldout.runs}, $${s.usd.toFixed(2)} total, median ${med(rs.map((r) => r.secs))} s and $${med(rs.map((r) => r.usd)).toFixed(3)} per ticket`,
    );
    for (const r of rs)
      out.push(
        `  ${r.correct ? "ok  " : "MISS"} ${r.ticket.padEnd(22)} ${r.outcome.padEnd(16)} oracle ${r.oracle.padEnd(5)} ${String(r.secs).padStart(5)} s  $${r.usd.toFixed(3)}`,
      );
  }
  return out;
}
