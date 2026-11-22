// Per-drive reliability across bench runs (PLAN §0.2's INCONCLUSIVE and flake rate),
// read from what a job folder keeps. Pure apart from `readJobDrives`.
//
// - A drive is a feature drive's name, or `primitive:<name>` for a bare primitive
//   segment: the `drive` field the engine stamps on every evidence entry (drive.ts).
// - INCONCLUSIVE: a Verify run (rounds/<n>/verdict-m<k>.md) whose row for a criterion
//   says INCONCLUSIVE counts once for every drive that criterion's cited entries ran.
// - Flake: within one job, the same drive on the same source tree (sha + working tree
//   hash, so a builder's edit is a different tree) had a run whose steps all ran and a
//   run where a step failed. A drive run's outcome is its last stamped step (a drive
//   stops at the first step that fails for good; a step's retries come before it).
//   Toolkit-gap entries are no run.
import fs from "node:fs";
import path from "node:path";

/** The fields of a manifest entry the tally reads (src/proof/manifest.ts Entry). */
export type TallyEntry = {
  id: string;
  drive?: unknown;
  criterion?: unknown;
  role?: unknown;
  sha?: unknown;
  tree?: unknown;
  line?: unknown;
  attempt?: unknown;
  ok?: unknown;
  gap?: unknown;
};
export type DriveRun = { drive: string; tree: string; ok: boolean; entries: string[] };
export type VerdictRow = { criterion: string; result: string; evidence: string[] };
/** One job's numbers for one drive. */
export type DriveTally = { drive: string; verifies: number; inconclusive: number; runs: number; passed: number; failed: number; flaky: boolean };
/** All runs' numbers for one drive (keyed by fixture, since drive names are per Toolkit). */
export type DriveSummary = {
  fixture: string;
  drive: string;
  jobs: number;
  verifies: number;
  inconclusive: number;
  runs: number;
  flakyJobs: number;
};

/** Pure: the drive runs in manifest order. */
export function driveRuns(entries: TallyEntry[]): DriveRun[] {
  const out: DriveRun[] = [];
  let prev: { key: string; line: number } | null = null;
  for (const e of entries) {
    if (typeof e.drive !== "string" || e.gap) {
      prev = null;
      continue;
    }
    const tree = `${String(e.sha ?? "")}:${String(e.tree ?? "")}`;
    const key = [e.drive, String(e.criterion ?? ""), String(e.role ?? ""), tree].join("\0");
    const line = typeof e.line === "number" ? e.line : 0;
    const retry = typeof e.attempt === "number" && e.attempt > 0;
    const same = prev && prev.key === key && (line > prev.line || (line === prev.line && retry));
    if (!same) out.push({ drive: e.drive, tree, ok: e.ok === true, entries: [] });
    const run = out[out.length - 1];
    run.entries.push(e.id);
    run.ok = e.ok === true;
    prev = { key, line };
  }
  return out;
}

/** Pure: the criterion rows of a rendered verdict (checks/verdict.ts renderVerdict). */
export function verdictRows(text: string): VerdictRow[] {
  const rows: VerdictRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\|\s*(C\d+)\s*\|\s*(?:engine|verifier)\s*\|\s*(PASS|FAIL|INCONCLUSIVE|TOOLKIT-GAP)\s*\|([^|]*)\|/.exec(line);
    if (m) rows.push({ criterion: m[1], result: m[2], evidence: m[3].match(/\be\d+\b/g) ?? [] });
  }
  return rows;
}

/** Pure: one job's per-drive tally from its manifest entries and its verdict files' text. */
export function jobDriveTally(entries: TallyEntry[], verdicts: string[]): DriveTally[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const t = new Map<string, DriveTally>();
  const of = (drive: string) => {
    const x = t.get(drive) ?? { drive, verifies: 0, inconclusive: 0, runs: 0, passed: 0, failed: 0, flaky: false };
    t.set(drive, x);
    return x;
  };
  for (const text of verdicts)
    for (const row of verdictRows(text)) {
      const drives = new Set(row.evidence.map((id) => byId.get(id)?.drive).filter((d): d is string => typeof d === "string"));
      for (const d of drives) {
        const x = of(d);
        x.verifies++;
        if (row.result === "INCONCLUSIVE") x.inconclusive++;
      }
    }
  const seen = new Map<string, Set<boolean>>();
  for (const r of driveRuns(entries)) {
    const x = of(r.drive);
    x.runs++;
    if (r.ok) x.passed++;
    else x.failed++;
    const k = `${r.drive}\0${r.tree}`;
    const s = seen.get(k) ?? new Set<boolean>();
    s.add(r.ok);
    seen.set(k, s);
    if (s.size === 2) x.flaky = true;
  }
  return [...t.values()].sort((a, b) => a.drive.localeCompare(b.drive));
}

/** Pure: per fixture + drive, across every run. */
export function sumDrives(runs: { fixture: string; drives?: DriveTally[] }[]): DriveSummary[] {
  const t = new Map<string, DriveSummary>();
  for (const r of runs)
    for (const d of r.drives ?? []) {
      const k = `${r.fixture}\0${d.drive}`;
      const x = t.get(k) ?? { fixture: r.fixture, drive: d.drive, jobs: 0, verifies: 0, inconclusive: 0, runs: 0, flakyJobs: 0 };
      x.jobs++;
      x.verifies += d.verifies;
      x.inconclusive += d.inconclusive;
      x.runs += d.runs;
      if (d.flaky) x.flakyJobs++;
      t.set(k, x);
    }
  return [...t.values()].sort((a, b) => a.fixture.localeCompare(b.fixture) || a.drive.localeCompare(b.drive));
}

/** A job folder's drives: evidence/manifest.jsonl (read as is: the bench is a reader, not the verifier) and rounds/<n>/verdict-m<k>.md. */
export function readJobDrives(jobDir: string): DriveTally[] {
  const entries: TallyEntry[] = [];
  const mf = path.join(jobDir, "evidence", "manifest.jsonl");
  if (fs.existsSync(mf))
    for (const line of fs.readFileSync(mf, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as TallyEntry);
      } catch {}
    }
  const verdicts: string[] = [];
  const rounds = path.join(jobDir, "rounds");
  if (fs.existsSync(rounds))
    for (const r of fs.readdirSync(rounds))
      for (const f of fs.readdirSync(path.join(rounds, r)).filter((x) => /^verdict-m\d+\.md$/.test(x)))
        verdicts.push(fs.readFileSync(path.join(rounds, r, f), "utf8"));
  return jobDriveTally(entries, verdicts);
}
