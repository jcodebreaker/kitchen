// The §0 measures (PLAN §0 "What the ledger tracks from the first run"), from the
// de-duplicated ledger alone. Pure: `kitchen report`, the dashboard and the retro
// all read these numbers the same way.
//
// - taken in: every job with a ledger line (bench lines and run lines excluded)
// - merge-ready: a job that reached `done` (a ready PR with its Report)
// - first-pass Verdict: the job's first Verify exit went to review
// - rounds: the highest round a job's lines carry, for jobs that got past intake
// - escalations: moves to needs-human, needs-info and rejected, by reason code
// - Toolkit gaps: moves into the toolkit stage; primitive PRs: moves out of it to work
// - INCONCLUSIVE and flake per drive: `proof` lines (verify). A drive is flaky in a
//   group (same job, HEAD and criterion) when it gave a PASS and a non-PASS there
// - time and cost per job and per risk path: agent `usd`, first to last line; the
//   path is intake's rating (`ACCEPT <kind> <risk>`)
// - findings dismissed per lens: `finding-dismissed` over the lens's `review-lens` findings
import { type ProofLineError, parseProof } from "../proof/proof-line.ts";
import type { LedgerLine } from "./append.ts";

export type JobMeasure = {
  job: string;
  risk: string;
  kind: string;
  last: string;
  done: boolean;
  rounds: number;
  firstVerdict: string | null;
  gaps: number;
  primitivePrs: number;
  usd: number;
  secs: number;
};

export type DriveMeasure = { drive: string; runs: number; pass: number; fail: number; inconclusive: number; gap: number; groups: number; flaky: number };

export type Measures = {
  jobs: JobMeasure[];
  takenIn: number;
  mergeReady: number;
  verified: number;
  firstPass: number;
  rounds: { mean: number; median: number; max: number; jobs: number };
  escalations: { code: string; to: string; n: number; example: string }[];
  gaps: { total: number; perJob: number };
  primitivePrs: { total: number; perJob: number };
  drives: DriveMeasure[];
  proofs: { runs: number; inconclusive: number; flakyGroups: number; groups: number };
  perPath: { risk: string; jobs: number; done: number; usd: number; secs: number; medianUsd: number; medianSecs: number }[];
  usd: number;
  secs: number;
  lenses: { lens: string; findings: number; blocked: number; dismissed: number }[];
};

/** The names a proof line drives: its toolkit segments, or `cmd` / `test <file>`. Pure. */
export function drivesOf(proof: string | null | undefined): string[] {
  if (!proof) return [];
  try {
    return parseProof(proof).map((s) => (s.kind === "toolkit" ? s.name : s.kind === "test" ? `test ${s.file}` : "cmd"));
  } catch (e) {
    return [`(unparsed: ${(e as ProofLineError).message.slice(0, 40)})`];
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** The job lines: not the runner's own (`-`), not bench summaries. */
export const isJobLine = (l: LedgerLine) => l.job !== "-" && !l.job.startsWith("bench:") && l.event !== "bench";

/** `ACCEPT feature low: …` → { kind, risk }. */
export function intakeRating(line: string | undefined): { kind: string; risk: string } | null {
  const m = /^\s*ACCEPT\s+(feature|bug|chore)\s+(low|medium|high)\b/i.exec(line ?? "");
  return m ? { kind: m[1].toLowerCase(), risk: m[2].toLowerCase() } : null;
}

/** The reason code of an escalation note: `round-limit: …` → round-limit. */
export function reasonCode(to: string, note: string | undefined): string {
  if (to !== "needs-human") return to;
  const m = /^([a-z][a-z-]+):/.exec(note ?? "");
  return m ? m[1] : (note ?? "").slice(0, 60) || "unknown";
}

/** Where Verify's first exit went → the Verdict it means. */
const VERDICT_OF: Record<string, string> = { review: "PASS", build: "FAIL", toolkit: "TOOLKIT-GAP", paused: "INCONCLUSIVE", "needs-human": "escalated" };

const WORK = new Set(["spec", "repro", "drives", "build", "verify"]);

export function measures(all: LedgerLine[]): Measures {
  const lines = all.filter(isJobLine);
  const byJob = new Map<string, LedgerLine[]>();
  for (const l of lines) byJob.set(l.job, [...(byJob.get(l.job) ?? []), l]);
  const jobs: JobMeasure[] = [];
  const escal = new Map<string, { code: string; to: string; n: number; example: string }>();
  for (const [job, ls] of byJob) {
    const moves = ls.filter((l) => l.event === "move");
    const rating = intakeRating(
      ls.find((l) => l.event === "agent" && l.role === "intake" && intakeRating(String(l.detail?.line ?? "")))?.detail?.line as string,
    );
    const firstVerify = moves.find((m) => m.stage === "verify" && m.result !== "verify");
    const times = ls.map((l) => Date.parse(l.t)).filter((t) => !Number.isNaN(t));
    for (const m of moves.filter((x) => ["needs-human", "needs-info", "rejected"].includes(String(x.result)))) {
      const note = String(m.detail?.note ?? "");
      const code = reasonCode(String(m.result), note);
      const k = `${m.result}/${code}`;
      const e = escal.get(k) ?? { code, to: String(m.result), n: 0, example: code === note.slice(0, 60) ? "" : note.slice(0, 100) };
      e.n++;
      escal.set(k, e);
    }
    jobs.push({
      job,
      risk: rating?.risk ?? "unrated",
      kind: rating?.kind ?? "-",
      last: String(moves.at(-1)?.result ?? moves.at(-1)?.stage ?? "intake"),
      done: moves.some((m) => m.result === "done"),
      rounds: moves.some((m) => m.stage !== "intake" && m.stage !== "needs-info") ? Math.max(1, ...ls.map((l) => l.round ?? 1)) : 0,
      firstVerdict: firstVerify ? (VERDICT_OF[String(firstVerify.result)] ?? String(firstVerify.result)) : null,
      gaps: moves.filter((m) => m.result === "toolkit").length,
      primitivePrs: moves.filter((m) => m.stage === "toolkit" && WORK.has(String(m.result))).length,
      usd: round4(ls.filter((l) => l.event === "agent").reduce((n, l) => n + (l.usd ?? 0), 0)),
      secs: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0,
    });
  }

  // Drives: INCONCLUSIVE and flake.
  const proofLines = lines.filter((l) => l.event === "proof");
  const drives = new Map<string, DriveMeasure>();
  const groups = new Map<string, { drives: string[]; results: Set<string> }>();
  for (const p of proofLines) {
    const names = (p.detail?.drives as string[] | undefined) ?? [];
    const r = String(p.result);
    for (const d of names.length ? names : ["(none)"]) {
      const m = drives.get(d) ?? { drive: d, runs: 0, pass: 0, fail: 0, inconclusive: 0, gap: 0, groups: 0, flaky: 0 };
      m.runs++;
      if (r === "PASS") m.pass++;
      else if (r === "INCONCLUSIVE") m.inconclusive++;
      else if (r === "TOOLKIT-GAP") m.gap++;
      else m.fail++;
      drives.set(d, m);
    }
    const g = `${p.job}/${p.detail?.head ?? "?"}/${p.detail?.criterion ?? "?"}`;
    const e = groups.get(g) ?? { drives: names, results: new Set<string>() };
    e.results.add(r);
    groups.set(g, e);
  }
  let flakyGroups = 0;
  for (const g of groups.values()) {
    const flaky = g.results.has("PASS") && g.results.size > 1;
    if (flaky) flakyGroups++;
    for (const d of g.drives.length ? g.drives : ["(none)"]) {
      const m = drives.get(d);
      if (!m) continue;
      m.groups++;
      if (flaky) m.flaky++;
    }
  }

  // Lenses: findings and dismissals.
  const lensMap = new Map<string, { lens: string; findings: number; blocked: number; dismissed: number }>();
  const lensOf = (k: string) => {
    const e = lensMap.get(k) ?? { lens: k, findings: 0, blocked: 0, dismissed: 0 };
    lensMap.set(k, e);
    return e;
  };
  for (const l of lines.filter((x) => x.event === "review-lens")) {
    const d = l.detail as { lens?: string; findings?: number; blocks?: number } | undefined;
    const e = lensOf(String(d?.lens ?? l.role?.replace(/^reviewer-/, "") ?? "?"));
    e.findings += d?.findings ?? 0;
    e.blocked += d?.blocks ?? 0;
  }
  for (const l of lines.filter((x) => x.event === "finding-dismissed")) lensOf(String(l.detail?.lens ?? l.role?.replace(/^reviewer-/, "") ?? "?")).dismissed++;

  // Per risk path.
  const paths = new Map<string, JobMeasure[]>();
  for (const j of jobs) paths.set(j.risk, [...(paths.get(j.risk) ?? []), j]);
  const order = ["low", "medium", "high", "unrated"];
  const perPath = [...paths.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([risk, js]) => ({
      risk,
      jobs: js.length,
      done: js.filter((j) => j.done).length,
      usd: round4(js.reduce((n, j) => n + j.usd, 0)),
      secs: js.reduce((n, j) => n + j.secs, 0),
      medianUsd: round4(median(js.map((j) => j.usd))),
      medianSecs: Math.round(median(js.map((j) => j.secs))),
    }));

  const worked = jobs.filter((j) => j.rounds > 0);
  const verified = jobs.filter((j) => j.firstVerdict !== null);
  const gapsTotal = jobs.reduce((n, j) => n + j.gaps, 0);
  const prTotal = jobs.reduce((n, j) => n + j.primitivePrs, 0);
  return {
    jobs,
    takenIn: jobs.length,
    mergeReady: jobs.filter((j) => j.done).length,
    verified: verified.length,
    firstPass: verified.filter((j) => j.firstVerdict === "PASS").length,
    rounds: {
      mean: round2(worked.length ? worked.reduce((n, j) => n + j.rounds, 0) / worked.length : 0),
      median: median(worked.map((j) => j.rounds)),
      max: Math.max(0, ...worked.map((j) => j.rounds)),
      jobs: worked.length,
    },
    escalations: [...escal.values()].sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)),
    gaps: { total: gapsTotal, perJob: round2(jobs.length ? gapsTotal / jobs.length : 0) },
    primitivePrs: { total: prTotal, perJob: round2(jobs.length ? prTotal / jobs.length : 0) },
    drives: [...drives.values()].sort((a, b) => b.runs - a.runs || a.drive.localeCompare(b.drive)),
    proofs: { runs: proofLines.length, inconclusive: proofLines.filter((p) => p.result === "INCONCLUSIVE").length, flakyGroups, groups: groups.size },
    perPath,
    usd: round4(jobs.reduce((n, j) => n + j.usd, 0)),
    secs: jobs.reduce((n, j) => n + j.secs, 0),
    lenses: [...lensMap.values()].sort((a, b) => a.lens.localeCompare(b.lens)),
  };
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const dur = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** `kitchen report`: every §0 measure, one block each. Pure. */
export function formatMeasures(m: Measures, o: { drivesShown?: number } = {}): string[] {
  const out: string[] = [];
  out.push(`Kitchen report: ${m.takenIn} job(s) taken in, $${m.usd.toFixed(2)} agent cost, ${dur(m.secs)} job time`);
  out.push("");
  out.push(`merge-ready rate         ${m.mergeReady}/${m.takenIn} = ${pct(m.mergeReady, m.takenIn)} of tickets taken in reached a ready PR (done)`);
  out.push(`first-pass Verdict rate  ${m.firstPass}/${m.verified} = ${pct(m.firstPass, m.verified)} of verified jobs passed Verify on their first try`);
  out.push(`rounds per job           mean ${m.rounds.mean}, median ${m.rounds.median}, max ${m.rounds.max} (${m.rounds.jobs} job(s) past intake)`);
  out.push(`Toolkit gaps per job     ${m.gaps.perJob} (${m.gaps.total} in all)`);
  out.push(`primitive PRs per job    ${m.primitivePrs.perJob} (${m.primitivePrs.total} in all; rising means the drive format is too thin)`);
  out.push("");
  out.push("escalation reasons");
  if (!m.escalations.length) out.push("  none");
  for (const e of m.escalations)
    out.push(`  ${String(e.n).padStart(3)}  ${e.to.padEnd(11)} ${e.code}${e.to === "needs-human" && e.example ? `  (${e.example})` : ""}`);
  out.push("");
  out.push(
    `INCONCLUSIVE and flake per drive  (${m.proofs.runs} proof runs: ${m.proofs.inconclusive} INCONCLUSIVE = ${pct(m.proofs.inconclusive, m.proofs.runs)}; flaky ${m.proofs.flakyGroups}/${m.proofs.groups} = ${pct(m.proofs.flakyGroups, m.proofs.groups)})`,
  );
  if (!m.drives.length) out.push("  no proof lines in the ledger yet (Verify writes one per proof)");
  const shown = m.drives.slice(0, o.drivesShown ?? 15);
  for (const d of shown)
    out.push(
      `  ${d.drive.slice(0, 34).padEnd(34)} runs ${String(d.runs).padStart(3)}  pass ${String(d.pass).padStart(3)}  fail ${String(d.fail).padStart(3)}  INCONCLUSIVE ${pct(d.inconclusive, d.runs).padStart(4)}  flake ${pct(d.flaky, d.groups).padStart(4)}`,
    );
  if (m.drives.length > shown.length) out.push(`  … ${m.drives.length - shown.length} more drive(s)`);
  out.push("");
  out.push("time and cost per risk path");
  for (const p of m.perPath)
    out.push(
      `  ${p.risk.padEnd(8)} ${String(p.jobs).padStart(3)} job(s), ${p.done} done  median ${dur(p.medianSecs).padStart(6)} $${p.medianUsd.toFixed(3)}  total ${dur(p.secs)} $${p.usd.toFixed(2)}`,
    );
  if (!m.perPath.length) out.push("  no jobs");
  out.push("");
  out.push("time and cost per job");
  for (const j of m.jobs)
    out.push(
      `  ${j.job.slice(0, 40).padEnd(40)} ${j.risk.padEnd(8)} ${j.last.padEnd(12)} round ${j.rounds}  ${dur(j.secs).padStart(6)}  $${j.usd.toFixed(3)}${j.firstVerdict ? `  first verdict ${j.firstVerdict}` : ""}`,
    );
  out.push("");
  out.push("findings dismissed per review lens");
  if (!m.lenses.length) out.push("  no review lines yet");
  for (const l of m.lenses) out.push(`  ${l.lens.padEnd(10)} ${l.dismissed}/${l.findings} dismissed = ${pct(l.dismissed, l.findings)}  (${l.blocked} blocked)`);
  return out;
}
