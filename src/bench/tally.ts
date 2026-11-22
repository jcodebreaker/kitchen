// Per-drive reliability across bench runs (PLAN §0.2's INCONCLUSIVE and flake rate).
// One definition, the ledger's (src/ledger/measures.ts): Verify's `proof` lines only.
// A drive is INCONCLUSIVE when a Verify proof run that drove it was, and flaky in a
// job when, for one (HEAD, criterion), Verify got a PASS and a non-PASS. Builder
// self-checks, the base check and repro runs are not Verify, so they never count.
// Pure.
import type { DriveMeasure } from "../ledger/measures.ts";

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

/** One job's per-drive tally, from its ledger measures (measures(lines).drives). */
export function jobDriveTally(drives: DriveMeasure[]): DriveTally[] {
  return drives
    .filter((d) => d.drive !== "(none)")
    .map((d) => ({ drive: d.drive, verifies: d.runs, inconclusive: d.inconclusive, runs: d.runs, passed: d.pass, failed: d.fail, flaky: d.flaky > 0 }))
    .sort((a, b) => a.drive.localeCompare(b.drive));
}

/** Per fixture + drive, across every run. */
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
