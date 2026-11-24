// "Kitchen findings" (ADR 0022 §2): the built-in source. What a lane notices beyond its job becomes an inbox item when
// the lane finishes: QA's notes outside the criteria (verdict.json `notes`), a passing review's non-blocking findings,
// and the features a sweep or map upkeep found broken. A check's problems (ADR 0028) go further: each becomes an item
// and a proposal, so the person can Run, Hold or set it aside like triage's. Keyed `kitchen:<job or run>:<lane>:<n>`, so finishing a lane
// again adds nothing twice. Best effort: a finding that can't be added never stops the job.
import fs from "node:fs";
import path from "node:path";
import type { QaFinding } from "../engine/lanes.ts";
import { readState, writeState } from "../sources/config.ts";
import { addItems, listProposals, type NewItem, type Proposal, propose } from "./store.ts";

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
 * ADR 0028 §4: a check's problems, each an inbox item of Kitchen findings (keyed `kitchen:<job>:check:<round>.<n>`,
 * linked to the check job) and a proposal the person may Run (a bug, P2) with the check's repro and evidence. A
 * finish run again adds nothing twice: an item already proposed keeps its proposal. The proposal ids, in order.
 */
export async function proposeCheckFindings(
  repo: string,
  c: { job: string; round: number; onto: string; target: string; qaFolder: string; findings: QaFinding[] },
  now = new Date(),
): Promise<string[]> {
  if (!c.findings.length) return [];
  const label = `Check ${num(c.job)}`;
  const added = await addItems(
    repo,
    c.findings.map((f, i) => ({
      key: `kitchen:${c.job}:check:${c.round}.${i + 1}`,
      text: `${f.title}\n\n${f.seen}`,
      src: { source: "kitchen", kind: "kitchen", label, ref: c.job, job: c.job },
    })),
    now,
  );
  const st = readState(repo, "kitchen");
  writeState(repo, "kitchen", { ...st, lastAt: now.toISOString(), lastNew: added.filter((a) => a.added !== "seen").length, status: "available" });
  const ids: string[] = [];
  for (const [i, a] of added.entries()) {
    const had = listProposals(repo).find((p: Proposal) => p.items.includes(a.item.id));
    if (had) {
      ids.push(had.id);
      continue;
    }
    const f = c.findings[i];
    const p = await propose(
      repo,
      {
        title: f.title,
        text: `${f.seen}${f.criterion ? `\n\nCheck ${num(c.job)}'s ${f.criterion} failed on ${c.target} (${c.onto.slice(0, 12)}).` : `\n\nFound by check ${num(c.job)} on ${c.target} (${c.onto.slice(0, 12)}).`}`,
        items: [a.item.id],
        kind: "bug",
        prio: "P2",
        why: `check ${num(c.job)} saw it on ${c.target}`,
        line: `Found by check ${num(c.job)} on ${c.target}`,
        steps: f.repro,
        evidence: f.evidence.map((e) => path.join(c.qaFolder, e)),
        sha: c.onto,
      },
      now,
    );
    ids.push(p.id);
  }
  return ids;
}
