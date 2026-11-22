// `kitchen report` (W1): counts per stage and per event from the de-duplicated ledger.
// The full report (rates, time and cost per path, flake rate) comes in W5.
import type { LedgerLine } from "./append.ts";

export type Counts = { lines: number; jobs: number; byEvent: Record<string, number>; byStage: Record<string, Record<string, number>>; usd: number };

/** Pure. */
export function summarize(lines: LedgerLine[]): Counts {
  const byEvent: Record<string, number> = {};
  const byStage: Record<string, Record<string, number>> = {};
  let usd = 0;
  for (const l of lines) {
    byEvent[l.event] = (byEvent[l.event] ?? 0) + 1;
    byStage[l.stage] ??= {};
    byStage[l.stage][l.event] = (byStage[l.stage][l.event] ?? 0) + 1;
    usd += l.usd ?? 0;
  }
  return { lines: lines.length, jobs: new Set(lines.map((l) => l.job).filter((j) => j !== "-")).size, byEvent, byStage, usd };
}

const pairs = (o: Record<string, number>) =>
  Object.entries(o)
    .sort()
    .map(([e, n]) => `${e}=${n}`)
    .join(" ");

export function formatCounts(c: Counts): string {
  const rows = [`ledger: ${c.lines} lines, ${c.jobs} jobs, $${c.usd.toFixed(4)}`, `events: ${pairs(c.byEvent)}`];
  for (const [stage, ev] of Object.entries(c.byStage).sort()) rows.push(`  ${stage.padEnd(12)} ${pairs(ev)}`);
  return rows.join("\n");
}
