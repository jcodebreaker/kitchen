// `npm run bench -- --estimate`: what a real run of the bench should cost, per lane. From real lane costs when there
// are any (the lanes of past real bench results in bench/results/*.json, or a ledger named with --ledger), else from a
// stated assumption per lane and model, labelled as a guess.
import fs from "node:fs";
import path from "node:path";
import type { TicketKind } from "./tickets.ts";

export type LaneCost = { lane: string; model: string; usd: number };
export const BENCH_LANES = ["intake", "build", "qa", "review", "regress"] as const;
export type BenchLane = (typeof BENCH_LANES)[number];

/** The bench's model presets: each lane role's model (`kitchen models set <lane> <model>`); `default` changes nothing. */
export const PRESETS: Record<string, Record<"intake" | "build" | "qa" | "review", string> | null> = {
  cheap: { intake: "haiku", build: "sonnet", qa: "haiku", review: "haiku" },
  haiku: { intake: "haiku", build: "haiku", qa: "haiku", review: "haiku" },
  default: null,
};
/** Kitchen's own defaults for Claude Code (src/config.ts: intake and build strong, QA and review medium). */
const KITCHEN_DEFAULT = { intake: "opus", build: "opus", qa: "sonnet", review: "sonnet" };

/** The model a preset runs a lane on. The merge check (regress) runs on QA's model. */
export function presetModel(preset: string, lane: BenchLane): string {
  const p = PRESETS[preset] ?? KITCHEN_DEFAULT;
  return p[lane === "regress" ? "qa" : lane];
}

/**
 * The assumption when no real cost is known: USD per lane session, low and high, per model. Reasoning: a headless
 * Claude Code session starts with ~20-30k tokens of system prompt and brief (cached after the first turn) and takes
 * 5-25 turns; Haiku is about a third of Sonnet's price, Opus about 1.7 times Sonnet's. A guess, never a measurement.
 */
const GUESS: Record<string, Record<BenchLane, [number, number]>> = {
  haiku: { intake: [0.03, 0.12], build: [0.1, 0.4], qa: [0.05, 0.25], review: [0.03, 0.12], regress: [0.05, 0.2] },
  sonnet: { intake: [0.1, 0.35], build: [0.3, 1.2], qa: [0.15, 0.6], review: [0.1, 0.35], regress: [0.15, 0.5] },
  opus: { intake: [0.17, 0.6], build: [0.5, 2.0], qa: [0.25, 1.0], review: [0.17, 0.6], regress: [0.25, 0.85] },
};

/** Lane sessions a ticket of a kind takes: [low, high] (a second round at the high end; a merge check at most once). */
const SESSIONS: Record<TicketKind, Record<BenchLane, [number, number]>> = {
  feature: { intake: [1, 1], build: [1, 2], qa: [1, 2], review: [1, 2], regress: [0, 1] },
  bug: { intake: [1, 1], build: [1, 2], qa: [1, 2], review: [1, 2], regress: [0, 1] },
  shared: { intake: [1, 1], build: [1, 2], qa: [1, 2], review: [1, 2], regress: [0, 1] },
  check: { intake: [1, 1], build: [0, 0], qa: [1, 1], review: [0, 0], regress: [0, 0] },
  ambiguous: { intake: [1, 1], build: [0, 0], qa: [0, 0], review: [0, 0], regress: [0, 0] },
  refuse: { intake: [1, 1], build: [0, 0], qa: [0, 0], review: [0, 0], regress: [0, 0] },
};

/** Real lane costs: from past real (not dry) bench results, and from a ledger.jsonl when one is named. */
export function knownCosts(resultsDir: string, ledger?: string): LaneCost[] {
  const out: LaneCost[] = [];
  if (fs.existsSync(resultsDir))
    for (const f of fs.readdirSync(resultsDir).filter((x) => x.endsWith(".json"))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8")) as { mode?: string; lanes?: LaneCost[] };
        if (r.mode === "real" && Array.isArray(r.lanes)) out.push(...r.lanes.filter((l) => l.usd > 0));
      } catch {}
    }
  if (ledger) out.push(...ledgerCosts(fs.readFileSync(ledger, "utf8")).filter((l) => l.usd > 0));
  return out;
}

/** Pure: each lane session's cost in a ledger: the session line's usd, with the lane and model its start line named. */
export function ledgerCosts(text: string): LaneCost[] {
  const lines = text
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as { event?: string; key?: string; stage?: string; model?: string; usd?: number }];
      } catch {
        return [];
      }
    });
  const starts = new Map(lines.filter((l) => l.event === "agent" && l.key?.endsWith("/start")).map((l) => [l.key?.slice(0, -"/start".length), l]));
  const seen = new Set<string>();
  const out: LaneCost[] = [];
  for (const l of lines) {
    if (l.event !== "session" || typeof l.usd !== "number" || !l.key || seen.has(l.key)) continue;
    seen.add(l.key);
    const s = starts.get(l.key.slice(0, -"/session".length));
    out.push({ lane: l.stage ?? "?", model: s?.model ?? "?", usd: l.usd });
  }
  return out;
}

export type Estimate = {
  preset: string;
  lines: { lane: BenchLane; model: string; sessions: [number, number]; each: [number, number]; from: string }[];
  low: number;
  /** Every ticket right the first time (one round each), each session at the middle of its range. */
  likely: number;
  high: number;
  guessed: boolean;
};

/** The cost range of one run of `kinds` (one entry per ticket) on `preset`. */
export function estimate(preset: string, kinds: TicketKind[], known: LaneCost[]): Estimate {
  const lines: Estimate["lines"] = [];
  let guessed = false;
  for (const lane of BENCH_LANES) {
    const model = presetModel(preset, lane);
    const sessions = kinds.reduce<[number, number]>((a, k) => [a[0] + SESSIONS[k][lane][0], a[1] + SESSIONS[k][lane][1]], [0, 0]);
    if (!sessions[1]) continue;
    const real = known.filter((c) => c.lane === lane && c.model === model).map((c) => c.usd);
    let each: [number, number];
    let from: string;
    if (real.length) {
      each = [Math.min(...real), Math.max(...real)];
      from = `measured: ${real.length} past session${real.length === 1 ? "" : "s"}`;
    } else {
      each = GUESS[model]?.[lane] ?? GUESS.opus[lane];
      from = `GUESS (no ${lane} session on ${model} measured yet)`;
      guessed = true;
    }
    lines.push({ lane, model, sessions, each, from });
  }
  const low = lines.reduce((s, l) => s + l.sessions[0] * l.each[0], 0);
  const high = lines.reduce((s, l) => s + l.sessions[1] * l.each[1], 0);
  const likely = lines.reduce((s, l) => s + l.sessions[0] * ((l.each[0] + l.each[1]) / 2), 0);
  return { preset, lines, low, likely, high, guessed };
}

/** Pure: the estimate as the terminal prints it. */
export function renderEstimate(e: Estimate, tickets: number, maxUsd: number): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const rows = e.lines.map(
    (l) =>
      `  ${l.lane.padEnd(8)} ${l.model.padEnd(7)} ${`${l.sessions[0]}-${l.sessions[1]} sessions`.padEnd(15)} ${`${usd(l.each[0])}-${usd(l.each[1])} each`.padEnd(17)} ${l.from}`,
  );
  return [
    `Estimate for one bench run: ${tickets} tickets, preset ${e.preset}`,
    ...rows,
    `  total    ${usd(e.low)} - ${usd(e.high)}, likely about ${usd(e.likely)} (one round per ticket)${e.guessed ? "\n           A GUESS: some lanes have no measured cost yet; the first real run's ledger replaces it" : ""}`,
    `  budget   --max-usd ${maxUsd}: Kitchen starts nothing new once it is spent, so a run stops near it${e.high > maxUsd ? " (below the high end: a run that needs second rounds may stop with work left)" : ""}`,
  ].join("\n");
}
