// Review findings (PLAN §2 review → ready/build, §7 W4 "precision"). Pure.
//
// A reviewer lens writes `review-<lens>.md`: a `VERDICT:` line, optional `VIEW:`
// lines (ux/ui), then one `### F<n>: <title>` block per finding:
//   - kind: blocking | note
//   - confidence: high | medium | low
//   - at: server.js:42           a line at HEAD, in this change
//   - requirement: R2            a requirement of intake.md
//   - evidence: e12 e14          stamped evidence ids
//   - why: how it is shown
// The engine, not the lens, decides what blocks. A finding blocks only when it is
// demonstrable: it names at least one anchor and every anchor it names holds:
// - `at:` a file tracked at HEAD, a line that exists, and inside what this job
//   changed (within DIFF_SLACK lines of a line the diff vs base changed): a lens
//   can't block a job on code the job didn't touch;
// - `evidence:` ids of this job's verified manifest, stamped for HEAD;
// - `requirement:` a requirement in scope. On its own (no line, no evidence) it
//   blocks only when every criterion covering it is NON-DISCRIMINATING: then its
//   PASS proves nothing and the requirement is unproven.
// Low confidence never blocks. A finding a person dismissed (`kitchen dismiss`),
// raised again by the same lens on the same anchor, never blocks. Anything else is
// a note, with the reason. Findings are merged only when they name the same file
// and line (±1); distinct findings on one requirement all stay, and a merged one
// keeps every member's title and why.

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

/** A finding merged into another (same file and line): what it said, kept for the builder and the report. */
export type Member = { id: string; lens: string; title: string; why: string; blocks: boolean };
export type Merged = Judged & { lenses: string[]; also: string[]; members: Member[] };

/** What the anchors are checked against, gathered by the caller from git, intake.md, the contract and the manifest. */
export type Anchors = {
  /** Tracked files at HEAD and their line counts. */
  lines: (file: string) => number | null;
  /** Lines (at HEAD) the job's diff vs base changed in `file`: added lines, and where lines were removed. [] when it changed none. */
  changed: (file: string) => readonly number[];
  /** Requirement ids in scope (intake.md `## Requirements`, minus out of scope). */
  requirements: readonly string[];
  /** Requirements in scope whose covering criteria are all NON-DISCRIMINATING: a finding naming one blocks on its own. */
  unproven: readonly string[];
  /** The verified manifest's entries (the manifest is sealed per job, so they are this job's). */
  evidence: readonly { id: string; sha: string; phase?: unknown }[];
  /** Evidence must be stamped for this HEAD. */
  head: string;
};

/** How near a changed line an `at:` may be (a missing check sits next to the lines that need it). */
export const DIFF_SLACK = 3;

/** A person's `kitchen dismiss`, as the engine reads it back (dismissed.jsonl). */
export type Dismissal = {
  finding: string;
  lens: string;
  round: number;
  by: string;
  reason: string | null;
  title?: string;
  at?: { file: string; line: number };
  requirement?: string;
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

/** Lines (new side) each file's diff changed: added lines, and the line where a removal happened. Pure. */
export function changedLines(patch: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let file: string | null = null;
  let n = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) {
      file = null;
      continue;
    }
    if (l.startsWith("+++ ")) {
      const p = l.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && !out.has(file)) out.set(file, []);
      continue;
    }
    if (l.startsWith("--- ")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (!file) continue;
    const list = out.get(file) as number[];
    if (l.startsWith("+")) list.push(n++);
    else if (l.startsWith("-")) list.push(Math.max(1, n));
    else if (l.startsWith(" ")) n++;
  }
  return out;
}

/** `[3,4,5,9]` → `3-5, 9`. */
function ranges(ls: readonly number[]): string {
  const s = [...new Set(ls)].sort((x, y) => x - y);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.length > 8 ? `${out.slice(0, 8).join(", ")}, …` : out.join(", ");
}

/**
 * The first anchor that doesn't hold, or null. `fixable`: the lens could fix it by rewriting the anchor
 * (an `at:` that isn't file:line, names an untracked file, or a line past the end).
 */
export function anchorCheck(f: Finding, a: Anchors): { why: string; fixable: boolean } | null {
  if (!f.at && !f.atRaw && !f.requirement && !f.evidence.length) return { why: "names no line, requirement or evidence", fixable: false };
  if (f.atRaw) return { why: `\`at: ${f.atRaw}\` is not file:line`, fixable: true };
  if (f.at) {
    const { file, line } = f.at;
    const n = a.lines(file);
    if (n === null) return { why: `${file} is not a tracked file at HEAD`, fixable: true };
    if (line < 1 || line > n) return { why: `${file}:${line} is past the end of the file (${n} lines)`, fixable: true };
    const changed = a.changed(file);
    if (!changed.some((l) => Math.abs(l - line) <= DIFF_SLACK))
      return {
        why: changed.length
          ? `${file}:${line} is not in this change (the diff changed lines ${ranges(changed)} of ${file})`
          : `${file}:${line} is not in this change (the diff doesn't touch ${file})`,
        fixable: false,
      };
  }
  if (f.requirement && !a.requirements.includes(f.requirement)) return { why: `${f.requirement} is not a requirement in scope`, fixable: false };
  const unknown = f.evidence.filter((id) => !a.evidence.some((e) => e.id === id));
  if (unknown.length) return { why: `evidence ${unknown.join(", ")} is not in this job's manifest`, fixable: false };
  const stale = f.evidence.filter((id) => a.evidence.some((e) => e.id === id && (e.sha !== a.head || e.phase === "base")));
  if (stale.length) return { why: `evidence ${stale.join(", ")} is not stamped for HEAD ${a.head.slice(0, 8)}`, fixable: false };
  if (f.requirement && !f.at && !f.evidence.length && !a.unproven.includes(f.requirement))
    return {
      why: `${f.requirement} alone: its criteria passed and discriminate, so a finding on it needs a line in the change or evidence that shows it`,
      fixable: false,
    };
  return null;
}

/** Why a finding's anchors don't show it, or null when it names at least one and every one it names holds. */
export const anchorProblem = (f: Finding, a: Anchors): string | null => anchorCheck(f, a)?.why ?? null;

/** Same lens and the same anchor (a line within DIFF_SLACK of it in the same file, or, with no line, the same requirement): a dismissed finding raised again. */
export function dismissedBy(f: Finding, dismissed: readonly Dismissal[]): Dismissal | undefined {
  return dismissed.find(
    (d) =>
      d.lens === f.lens &&
      (f.at && d.at
        ? d.at.file === f.at.file && Math.abs(d.at.line - f.at.line) <= DIFF_SLACK
        : !f.at && !d.at && !!f.requirement && d.requirement === f.requirement),
  );
}

/** The engine's call on each finding: demonstrable and confident blocking findings block; the rest are notes. */
export function judge(findings: Finding[], a: Anchors, dismissed: readonly Dismissal[] = []): Judged[] {
  return findings.map((f) => {
    if (f.kind !== "blocking") return { ...f, blocks: false };
    if (f.confidence === "low") return { ...f, blocks: false, downgraded: "low confidence never blocks" };
    const d = dismissedBy(f, dismissed);
    if (d) return { ...f, blocks: false, downgraded: `dismissed by ${d.by} (${d.finding})${d.reason ? `: ${d.reason}` : ""}` };
    const p = anchorProblem(f, a);
    return p ? { ...f, blocks: false, downgraded: `not demonstrable: ${p}` } : { ...f, blocks: true };
  });
}

/** Blocking findings (not low confidence) whose anchor the lens could fix: the lens is asked once to fix them before they are kept as notes. */
export function fixableAnchors(findings: Finding[], a: Anchors): { finding: Finding; why: string }[] {
  return findings
    .filter((f) => f.kind === "blocking" && f.confidence !== "low")
    .flatMap((f) => {
      const c = anchorCheck(f, a);
      return c?.fixable ? [{ finding: f, why: c.why }] : [];
    });
}

/** A review file that says `VERDICT: BLOCKING` but has no `kind: blocking` finding the engine can read: why, or null. */
export function unparseable(text: string, findings: Finding[]): string | null {
  if (verdictOf(text) !== "BLOCKING") return null;
  if (findings.some((f) => f.kind === "blocking")) return null;
  return findings.length
    ? `VERDICT: BLOCKING, but none of its ${findings.length} finding(s) says \`kind: blocking\``
    : "VERDICT: BLOCKING, but no `### F<n>: <title>` finding block could be read";
}

const RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
/** The same file and line (±1). Findings without a line are never merged. */
export const sameLine = (x: Finding, y: Finding) => !!x.at && !!y.at && x.at.file === y.at.file && Math.abs(x.at.line - y.at.line) <= 1;

/** Merge findings on the same file and line (±1): the merged one blocks if any member does and keeps every member's title and why. Blocking first. */
export function dedupe(judged: Judged[]): Merged[] {
  const groups: Judged[][] = [];
  for (const f of judged) {
    const g = f.at ? groups.find((x) => sameLine(x[0], f)) : undefined;
    if (g) g.push(f);
    else groups.push([f]);
  }
  const out: Merged[] = [];
  for (const g of groups) {
    const lead = g.find((f) => f.blocks) ?? g.find((f) => f.kind === "blocking") ?? g[0];
    const best = g.reduce((c, f) => (RANK[f.confidence] > RANK[c] ? f.confidence : c), lead.confidence);
    const others = g.filter((f) => f !== lead);
    out.push({
      ...lead,
      confidence: best,
      blocks: g.some((f) => f.blocks),
      ...(g.some((f) => f.blocks) ? { downgraded: undefined } : {}),
      evidence: [...new Set(g.flatMap((f) => f.evidence))],
      lenses: [...new Set(g.map((f) => f.lens))],
      also: others.map((f) => f.id),
      members: others.map((f) => ({ id: f.id, lens: f.lens, title: f.title, why: f.why, blocks: f.blocks })),
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
  /** Raised again after a person dismissed it (same lens, same anchor): kept as a note. */
  redismissed: number;
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
    redismissed: mine.filter((f) => f.downgraded?.startsWith("dismissed by")).length,
    duplicates: merged.reduce((n, m) => n + m.also.filter((id) => mine.some((f) => f.id === id)).length, 0),
  };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const said = (f: { title: string; why: string }) => `${f.title}${f.why ? `: ${f.why}` : ""}`;
const where = (f: Finding) =>
  [f.at ? `${f.at.file}:${f.at.line}` : f.atRaw ? `?${f.atRaw}` : "", f.requirement ?? "", f.evidence.join(" ")].filter(Boolean).join(" · ");

/** rounds/<N>/review.md: the engine's merged findings, for the builder, the report and people. A merged row carries every member's title and why. */
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
        `| ${f.id}${f.also.length ? ` (+${f.also.join(", ")})` : ""} | ${f.lenses.join(", ")} | ${f.blocks ? "BLOCKS" : "note"} | ${f.confidence} | ${cell(where(f))} | ${cell(said(f))}${(f.members ?? []).map((m) => ` + ${m.id} (${m.lens}): ${cell(said(m))}`).join("")} | ${cell(f.downgraded ?? "")} |`,
    ),
    "",
    "| lens | verdict | findings | claimed blocking | blocks | low confidence | not demonstrable | dismissed before | merged |",
    "|---|---|---|---|---|---|---|---|---|",
    ...o.stats.map(
      (s) =>
        `| ${s.lens} | ${s.verdict} | ${s.findings} | ${s.claimedBlocking} | ${s.blocks} | ${s.lowConfidence} | ${s.notDemonstrable} | ${s.redismissed} | ${s.duplicates} |`,
    ),
    "",
  ].join("\n");
}
