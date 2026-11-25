// "Kitchen findings" (ADR 0022 §2): the built-in source. What a lane notices beyond its job becomes an inbox item when
// the lane finishes: QA's notes outside the criteria (verdict.json `notes`), a passing review's non-blocking findings,
// and the features a sweep or map upkeep found broken. A check's problems (ADR 0028) go further: each becomes an item
// and a proposal, so the person can Run, Hold or set it aside like triage's. Keyed `kitchen:<job or run>:<lane>:<n>`, so finishing a lane
// again adds nothing twice. Best effort: a finding that can't be added never stops the job.
import fs from "node:fs";
import path from "node:path";
import { causeLabel, checkFindingKey, type QaFinding } from "../engine/lanes.ts";
import { readState, writeState } from "../sources/config.ts";
import { addItems, listItems, listProposals, type NewItem, type Proposal, propose } from "./store.ts";

const num = (id: string) => /^(\d{3,})-/.exec(id)?.[1] ?? id;

/** Pure: QA's `notes` (things it saw that no criterion covers): `[{ "text": "…", "evidence": ["…"] }]` or strings. */
export function qaNotes(verdict: unknown): string[] {
  const v = verdict as { notes?: unknown } | null;
  if (!v || !Array.isArray(v.notes)) return [];
  return v.notes
    .map((n) => (typeof n === "string" ? n : typeof (n as { text?: unknown })?.text === "string" ? (n as { text: string }).text : ""))
    .map((t) => t.trim())
    .filter(Boolean);
}

export type Finding = { lane: "qa" | "review" | "sweep" | "maintain" | "check"; job: string; n: string; text: string; label: string };

/** Pure: a finding as an inbox item of the built-in source. */
export function findingItem(f: Finding): NewItem {
  return { key: `kitchen:${f.job}:${f.lane}:${f.n}`, text: f.text, src: { source: "kitchen", kind: "kitchen", label: f.label, ref: f.job, job: f.job } };
}

/** Add findings to the inbox and count them on the built-in source. Never throws. */
export async function addFindings(repo: string, fs_: Finding[], now = new Date()): Promise<number> {
  if (!fs_.length) return 0;
  try {
    const added = (await addItems(repo, fs_.map(findingItem), now)).filter((a) => a.added !== "seen").length;
    if (added) {
      const st = readState(repo, "kitchen");
      writeState(repo, "kitchen", { ...st, lastAt: now.toISOString(), lastNew: added, status: "available" });
    }
    return added;
  } catch {
    return 0;
  }
}

/** QA finished a round: its notes outside the criteria. */
export function qaFindings(job: string, round: number, qaFolder: string): Finding[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(qaFolder, "verdict.json"), "utf8"));
    return qaNotes(v).map((text, i) => ({ lane: "qa", job, n: `${round}.${i + 1}`, text, label: `QA finding in ${num(job)}` }));
  } catch {
    return [];
  }
}

/** A review passed: the findings that didn't block (they would have cost a round). */
export function reviewFindings(job: string, round: number, findings: { id: string; blocks: boolean; at?: string; why: string }[]): Finding[] {
  return findings
    .filter((f) => !f.blocks)
    .map((f) => ({ lane: "review", job, n: `${round}.${f.id}`, text: `${f.at ? `${f.at}: ` : ""}${f.why}`, label: `Review note in ${num(job)}` }));
}

/** A sweep or map upkeep finished: each feature it found broken. */
export function runFindings(kind: "sweep" | "maintain", run: string, rows: { id: string; result: string; note: string }[]): Finding[] {
  return rows
    .filter((r) => r.result === "FAIL")
    .map((r) => ({
      lane: kind,
      job: run,
      n: r.id,
      text: `${r.id} failed in ${kind === "sweep" ? "the sweep" : "map upkeep"} ${run}: ${r.note}`,
      label: `${kind === "sweep" ? "Sweep" : "Upkeep"}: ${r.id}`,
    }));
}

/**
 * Pure, ADR 0031 §1: a finding as the proposal says it: Seen, Expected, and the cause as suspected or confirmed, each
 * on its own line. An older finding (no expected, no cause) is its `seen` alone.
 */
export function findingText(f: Pick<QaFinding, "seen" | "expected" | "cause">): string {
  if (!f.expected && !f.cause) return f.seen;
  return [`Seen: ${f.seen}`, f.expected ? `Expected: ${f.expected}` : "", f.cause ? `${causeLabel(f)}: ${f.cause.text}` : ""].filter(Boolean).join("\n");
}

/**
 * ADR 0028 §4: a check's problems, each an inbox item of Kitchen findings (keyed `kitchen:<job>:check:<round>.<n>`,
 * linked to the check job) and a proposal the person may Run (a bug, P2) with the check's repro and evidence. A
 * finish run again adds nothing twice: an item already proposed keeps its proposal. The proposal ids, in order.
 */
export async function proposeCheckFindings(
  repo: string,
  c: {
    job: string;
    title?: string;
    round: number;
    onto: string;
    target: string;
    qaFolder: string;
    findings: QaFinding[];
    skip?: number[];
    earlier?: string;
  },
  now = new Date(),
): Promise<string[]> {
  // ADR 0031 §5: a finding the second look didn't confirm (1-based in `skip`) is never proposed; keys stay QA's numbering.
  const kept = c.findings.map((f, i) => ({ f, n: i + 1 })).filter((x) => !c.skip?.includes(x.n));
  if (!kept.length) return [];
  const label = `Check ${num(c.job)}`;
  const added = await addItems(
    repo,
    kept.map(({ f, n }) => ({
      key: checkFindingKey(c.job, c.round, n),
      text: `${f.title}\n\n${findingText(f)}`,
      src: { source: "kitchen", kind: "kitchen", label, ref: c.job, job: c.job },
    })),
    now,
  );
  const st = readState(repo, "kitchen");
  writeState(repo, "kitchen", { ...st, lastAt: now.toISOString(), lastNew: added.filter((a) => a.added !== "seen").length, status: "available" });
  // ADR 0033 §4: tooling findings with the same title are one chore. Its proposal takes every one of their items, so
  // each finding (by its key, ADR 0031 §5) links to it.
  const toolKey = (f: QaFinding) => (f.kind === "tooling" ? f.title.trim().toLowerCase() : null);
  const ids: string[] = [];
  for (const [i, a] of added.entries()) {
    const had = listProposals(repo).find((p: Proposal) => p.items.includes(a.item.id));
    if (had) {
      ids.push(had.id);
      continue;
    }
    const f = kept[i].f;
    if (f.kind === "tooling") {
      const group = added.filter((_, j) => toolKey(kept[j].f) === toolKey(f)).map((x) => x.item.id);
      ids.push((await proposeTooling(repo, c, f, group, now)).id);
      continue;
    }
    const p = await propose(
      repo,
      {
        title: f.title,
        text: `${findingText(f)}${f.criterion ? `\n\nCheck ${num(c.job)}'s ${f.criterion} failed on ${c.target} (${c.onto.slice(0, 12)}).` : `\n\nFound by check ${num(c.job)} on ${c.target} (${c.onto.slice(0, 12)}).`}`,
        items: [a.item.id],
        kind: "bug",
        prio: "P2",
        why: `check ${num(c.job)} saw it on ${c.target}`,
        line: `Found by check ${num(c.job)} on ${c.target}`,
        steps: f.repro,
        evidence: [...new Set([...f.evidence, ...(f.cause?.evidence ?? [])])].map((e) => path.join(c.qaFolder, e)),
        sha: c.onto,
      },
      now,
    );
    ids.push(p.id);
  }
  return ids;
}

/** ADR 0031 §5: the proposal that took a check finding's inbox item (by its key), or null (also when unreadable). */
export function findingProposal(repo: string, job: string, round: number, n: number): string | null {
  // Never throws: an inbox that can't be read (ADR 0029 §6's failed proposals) is "not proposed yet".
  try {
    const item = listItems(repo).find((x) => x.key === checkFindingKey(job, round, n));
    return item ? (listProposals(repo).find((p) => p.items.includes(item.id))?.id ?? null) : null;
  } catch {
    return null;
  }
}

/** Pure: a tooling proposal's title, "Add <tooling> so <check> can run" (ADR 0033 §4). */
const toolingTitle = (tooling: string, check: string) => `Add ${tooling.replace(/^add\s+/i, "")} so "${check}" can run`.slice(0, 120);

/**
 * ADR 0033 §4: a check's missing tooling as a chore the person may Run, linked to the check like its other findings.
 * Once its job merges, `kitchen job next` files the check again.
 */
function proposeTooling(
  repo: string,
  c: { job: string; title?: string; target: string; onto: string; qaFolder: string; earlier?: string },
  f: QaFinding,
  items: string[],
  now: Date,
): Promise<Proposal> {
  return propose(
    repo,
    {
      title: toolingTitle(f.title, c.title ?? `check ${num(c.job)}`),
      text: `${f.seen}\n\nCheck ${num(c.job)} couldn't verify this on ${c.target} (${c.onto.slice(0, 12)}): the project has no ${f.title}. Add it, with one example that runs. Once this merges into ${c.target}, Kitchen files check ${num(c.job)} again.${c.earlier ? `\n\n${c.earlier}` : ""}`,
      items,
      kind: "chore",
      prio: "P2",
      why: `check ${num(c.job)} can't run without it`,
      line: `Tooling check ${num(c.job)} needs`,
      evidence: f.evidence.map((e) => path.join(c.qaFolder, e)),
      sha: c.onto,
      // ADR 0033 §4: the tooling goes where the check runs, so the check filed again finds it.
      target: c.target,
    },
    now,
  );
}
