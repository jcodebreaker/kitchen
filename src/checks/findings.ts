// Review findings (PLAN §2 review → ready/build, §7 W4 "precision"). Pure.
//
// A reviewer lens writes `review-<lens>.md`: a `VERDICT:` line, optional `VIEW:`
// lines (ux/ui), then one `### F<n>: <title>` block per finding:
//   - kind: blocking | note
//   - confidence: high | medium | low
//   - at: server.js:42           a line at HEAD
//   - requirement: R2            a requirement of intake.md
//   - evidence: e12 e14          stamped evidence ids
//   - why: how it is shown
// The engine, not the lens, decides what blocks. A finding blocks only when it is
// demonstrable: it names at least one anchor and every anchor it names holds (the
// file is tracked at HEAD and has that line; the requirement is in scope; every
// evidence id is in the verified manifest). Low confidence never blocks. Anything
// else is kept as a note, with the reason. Findings from different lenses about
// the same line (or, without a line, the same requirement) are merged into one.

export type Kind = "blocking" | "note";
export type Confidence = "high" | "medium" | "low";

export type Finding = {
  /** `<lens>-<round>-<n>`: what `kitchen dismiss` names. */
  id: string;
  lens: string;
  title: string;
  kind: Kind;
  confidence: Confidence;
  at?: { file: string; line: number };
  /** The text of an `at:` value that didn't parse as file:line. */
  atRaw?: string;
  requirement?: string;
  evidence: string[];
  why: string;
};

export type Judged = Finding & {
  /** The engine's call: true only for a demonstrable, confident blocking finding. */
  blocks: boolean;
  /** Why a `kind: blocking` finding does not block. */
  downgraded?: string;
};

export type Merged = Judged & { lenses: string[]; also: string[] };

/** What the anchors are checked against, gathered by the caller from git, intake.md and the manifest. */
export type Anchors = {
  /** Tracked files at HEAD and their line counts. */
  lines: (file: string) => number | null;
  /** Requirement ids in scope (intake.md `## Requirements`, minus out of scope). */
  requirements: readonly string[];
  /** Evidence ids of the verified manifest. */
  evidence: readonly string[];
};

const KINDS: Kind[] = ["blocking", "note"];
const CONF: Confidence[] = ["high", "medium", "low"];

/** `VERDICT:` of a review file, upper-cased, or undefined. */
export const verdictOf = (text: string) => /^\s*VERDICT:\s*([A-Za-z-]+)/m.exec(text)?.[1]?.toUpperCase();

/** `VIEW: …` lines of a review file (ux/ui lenses ask the engine for more views this way). */
export function viewsOf(text: string): string[] {
  return [...text.matchAll(/^\s*VIEW:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^`(.*)`$/, "$1")).filter((v) => !/^(none|n\/a|-)$/i.test(v));
}

/** `server.js:42`, `src/a.ts:12-14`, `` `server.js` line 42 `` → { file, line } (the first line of a range). */
export function parseAt(v: string): { file: string; line: number } | null {
  const s = v.replace(/`/g, "").trim();
  const m = /^(.+?)(?::|\s+line\s+|#L)(\d+)(?:\s*[-–]\s*\d+)?\b/i.exec(s);
  if (!m) return null;
  const file = m[1].trim().replace(/^\.\//, "");
  if (!file || /\s/.test(file)) return null;
  return { file, line: Number(m[2]) };
}

/** The findings of one lens's review file. Unknown kinds read as note, unknown confidence as low: an unclear finding never blocks. */
export function parseFindings(text: string, lens: string, round: number): Finding[] {
  const out: Finding[] = [];
  const blocks = text.split(/^#{2,4}\s+(?=F\d+\b)/m).slice(1);
  for (const b of blocks) {
    const head = /^F(\d+)\b[:.\s-]*(.*)$/m.exec(b);
    if (!head) continue;
    const field = (name: string) => new RegExp(`^\\s*[-*]?\\s*${name}\\s*:\\s*(.*?)\\s*$`, "im").exec(b)?.[1] ?? "";
    const kindRaw = field("kind").toLowerCase().replace(/[`*]/g, "");
    const confRaw = field("confidence").toLowerCase().replace(/[`*]/g, "");
    const atRaw = field("at");
    const at = atRaw && !/^(none|n\/a|-)$/i.test(atRaw) ? parseAt(atRaw) : null;
    const req = /\bR\d+\b/i.exec(field("requirement"))?.[0]?.toUpperCase();
    out.push({
      id: `${lens}-${round}-${out.length + 1}`,
      lens,
      title: head[2].trim() || `finding ${head[1]}`,
      kind: (KINDS.find((k) => kindRaw.startsWith(k)) ?? "note") as Kind,
      confidence: (CONF.find((c) => confRaw.startsWith(c)) ?? "low") as Confidence,
      ...(at ? { at } : atRaw && !/^(none|n\/a|-)$/i.test(atRaw) ? { atRaw } : {}),
      ...(req ? { requirement: req } : {}),
      evidence: field("evidence").match(/\be\d+\b/g) ?? [],
      why: field("why"),
    });
  }
  return out;
}

/** Why a finding's anchors don't show it, or null when it names at least one and every one it names holds. */
export function anchorProblem(f: Finding, a: Anchors): string | null {
  if (!f.at && !f.atRaw && !f.requirement && !f.evidence.length) return "names no line, requirement or evidence";
  if (f.atRaw) return `\`at: ${f.atRaw}\` is not file:line`;
  if (f.at) {
    const n = a.lines(f.at.file);
    if (n === null) return `${f.at.file} is not a tracked file at HEAD`;
    if (f.at.line < 1 || f.at.line > n) return `${f.at.file}:${f.at.line} is past the end of the file (${n} lines)`;
  }
  if (f.requirement && !a.requirements.includes(f.requirement)) return `${f.requirement} is not a requirement in scope`;
  const unknown = f.evidence.filter((id) => !a.evidence.includes(id));
  if (unknown.length) return `evidence ${unknown.join(", ")} is not in the manifest`;
  return null;
}

/** The engine's call on each finding: demonstrable and confident blocking findings block; the rest are notes. */
export function judge(findings: Finding[], a: Anchors): Judged[] {
  return findings.map((f) => {
    if (f.kind !== "blocking") return { ...f, blocks: false };
    if (f.confidence === "low") return { ...f, blocks: false, downgraded: "low confidence never blocks" };
    const p = anchorProblem(f, a);
    return p ? { ...f, blocks: false, downgraded: `not demonstrable: ${p}` } : { ...f, blocks: true };
  });
}

const RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
/** Same line, or (with no line) the same requirement: the same finding seen by two lenses. */
export const dedupeKey = (f: Finding) => (f.at ? `at:${f.at.file}:${f.at.line}` : f.requirement ? `req:${f.requirement}` : `id:${f.id}`);

/** Merge findings that are about the same thing; the merged one blocks if any member does. Order: blocking first, then by lens order. */
export function dedupe(judged: Judged[]): Merged[] {
  const groups = new Map<string, Judged[]>();
  for (const f of judged) groups.set(dedupeKey(f), [...(groups.get(dedupeKey(f)) ?? []), f]);
  const out: Merged[] = [];
  for (const g of groups.values()) {
    const lead = g.find((f) => f.blocks) ?? g.find((f) => f.kind === "blocking") ?? g[0];
    const best = g.reduce((c, f) => (RANK[f.confidence] > RANK[c] ? f.confidence : c), lead.confidence);
    out.push({
      ...lead,
      confidence: best,
      blocks: g.some((f) => f.blocks),
      ...(g.some((f) => f.blocks) ? { downgraded: undefined } : {}),
      evidence: [...new Set(g.flatMap((f) => f.evidence))],
      lenses: [...new Set(g.map((f) => f.lens))],
      also: g.filter((f) => f !== lead).map((f) => f.id),
    });
  }
  return out.sort((x, y) => Number(y.blocks) - Number(x.blocks));
}

export type LensStats = {
  lens: string;
  verdict: string;
  findings: number;
  claimedBlocking: number;
  blocks: number;
  lowConfidence: number;
  notDemonstrable: number;
  /** Findings of this lens merged into another lens's (or another of its own). */
  duplicates: number;
};

/** Per-lens counts for the ledger (precision: what each lens claimed vs what held). */
export function lensStats(lens: string, verdict: string | undefined, judged: Judged[], merged: Merged[]): LensStats {
  const mine = judged.filter((f) => f.lens === lens);
  return {
    lens,
    verdict: verdict ?? "none",
    findings: mine.length,
    claimedBlocking: mine.filter((f) => f.kind === "blocking").length,
    blocks: mine.filter((f) => f.blocks).length,
    lowConfidence: mine.filter((f) => f.downgraded?.startsWith("low confidence")).length,
    notDemonstrable: mine.filter((f) => f.downgraded?.startsWith("not demonstrable")).length,
    duplicates: merged.reduce((n, m) => n + m.also.filter((id) => mine.some((f) => f.id === id)).length, 0),
  };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const where = (f: Finding) =>
  [f.at ? `${f.at.file}:${f.at.line}` : f.atRaw ? `?${f.atRaw}` : "", f.requirement ?? "", f.evidence.join(" ")].filter(Boolean).join(" · ");

/** rounds/<N>/review.md: the engine's merged findings, for the builder, the report and people. */
export function renderReview(o: { round: number; head: string; lenses: string[]; merged: Merged[]; stats: LensStats[] }): string {
  const blocking = o.merged.filter((f) => f.blocks);
  return [
    `REVIEW: ${blocking.length ? "BLOCKING" : "PASS"}`,
    `HEAD: ${o.head}`,
    `ROUND: ${o.round}`,
    `LENSES: ${o.lenses.join(", ") || "none"}`,
    "",
    "| id | lens | blocks | confidence | where | finding | note |",
    "|---|---|---|---|---|---|---|",
    ...o.merged.map(
      (f) =>
        `| ${f.id}${f.also.length ? ` (+${f.also.join(", ")})` : ""} | ${f.lenses.join(", ")} | ${f.blocks ? "BLOCKS" : "note"} | ${f.confidence} | ${cell(where(f))} | ${cell(f.title)}${f.why ? `: ${cell(f.why)}` : ""} | ${cell(f.downgraded ?? "")} |`,
    ),
    "",
    "| lens | verdict | findings | claimed blocking | blocks | low confidence | not demonstrable | merged |",
    "|---|---|---|---|---|---|---|---|",
    ...o.stats.map(
      (s) => `| ${s.lens} | ${s.verdict} | ${s.findings} | ${s.claimedBlocking} | ${s.blocks} | ${s.lowConfidence} | ${s.notDemonstrable} | ${s.duplicates} |`,
    ),
    "",
  ].join("\n");
}
