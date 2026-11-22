// Raw counts per stage and per event from the de-duplicated ledger (the tail of `kitchen report`),
// and time and cost per stage for one job's Report. The §0 measures are measures.ts.
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

export type StageCostRow = { stage: string; round: number; secs: number; usd: number; roles: string };

/**
 * Time and cost per stage entry of one job, for its Report. Pure. Time runs from the
 * move into a stage (or the job's start) to the move out of it; cost is the agent runs
 * recorded in that stage and round. Rows of the same stage and round are added up.
 */
export function stageCosts(lines: LedgerLine[], job: string, startedAt: string, now = new Date().toISOString()): StageCostRow[] {
  const mine = lines.filter((l) => l.job === job);
  const moves = mine.filter((l) => l.event === "move");
  const agents = mine.filter((l) => l.event === "agent");
  const rows = new Map<string, StageCostRow & { set: Set<string> }>();
  let t = Date.parse(startedAt);
  const add = (stage: string, round: number, until: number) => {
    const k = `${stage}/${round}`;
    const r = rows.get(k) ?? { stage, round, secs: 0, usd: 0, roles: "", set: new Set<string>() };
    r.secs += Math.max(0, (until - t) / 1000);
    rows.set(k, r);
    t = until;
  };
  for (const m of moves) add(m.stage, m.round, Date.parse(m.t));
  const last = moves.at(-1);
  if (last && !["done", "needs-human", "rejected"].includes(String(last.result))) add(String(last.result), last.round, Date.parse(now));
  for (const a of agents) {
    const r = rows.get(`${a.stage}/${a.round}`);
    if (!r) continue;
    r.usd += a.usd ?? 0;
    r.set.add(`${a.role}${a.model ? ` (${a.model})` : ""}`);
  }
  return [...rows.values()].map(({ set, ...r }) => ({ ...r, secs: Math.round(r.secs), usd: Math.round(r.usd * 10000) / 10000, roles: [...set].join(", ") }));
}
