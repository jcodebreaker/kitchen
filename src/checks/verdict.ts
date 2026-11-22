// The Verdict (PLAN §2 "Proofs: kitchen drive and Verdicts"). Pure.
//
// Step 1 has already happened: the engine ran every criterion's proof through
// `kitchen drive` (prove.ts) and decided each mechanical one itself. Step 2: the
// verifier agent judged only the `judged` criteria, in verify.md:
//   JUDGED C4: PASS | FAIL            one line per judged criterion
//   EVIDENCE C4: e12 e13              the stamped entries it relied on
//   VERDICT: PASS | FAIL | INCONCLUSIVE | TOOLKIT-GAP   (its overall answer)
//   GAP: <primitive>                  with TOOLKIT-GAP
// A judged PASS counts only when every cited id is an entry of the verified
// manifest stamped for this HEAD (clean tree), this round and that criterion,
// by the engine or the verifier (never a builder self-check). Anything else
// (no citation, a stale, foreign, unknown or self-check id) counts as FAIL.
import type { Entry } from "../proof/manifest.ts";
import type { Criterion } from "./spec-lint.ts";

export type Result = "PASS" | "FAIL" | "INCONCLUSIVE" | "TOOLKIT-GAP";
/** What the engine found running one criterion's proof (prove.ts). */
export type ProofRecord = {
  criterion: string;
  /** For a judged criterion: whether its evidence run worked (PASS) or not; the agent decides the rest. */
  result: Result;
  why?: string;
  gap?: string;
  evidence: string[];
};
export type ArgsDelta = { criterion: string; drive: string; spec: Record<string, string>; used: Record<string, string>; by: string; at: string };
export type CriterionVerdict = { id: string; judged: boolean; result: Result; why?: string; evidence: string[] };
export type Verdict = {
  verdict: Result;
  criteria: CriterionVerdict[];
  manifestOk: boolean;
  citationsOk: boolean;
  citationProblem?: string;
  gap?: string;
  argsDeltas: ArgsDelta[];
};

/** Roles whose entries a Verdict may cite. A builder's self-check is never proof. */
export const CITABLE_ROLES = ["engine", "verifier"];

/** `EVIDENCE C<n>: e<N> …` lines, as criterion → cited ids. */
export function citationsOf(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const m = /^\s*EVIDENCE\s+(C\d+)\s*:\s*(.*)$/.exec(line);
    if (m) out.set(m[1], [...(out.get(m[1]) ?? []), ...(m[2].match(/\be\d+\b/g) ?? [])]);
  }
  return out;
}

/** `JUDGED C<n>: PASS|FAIL` lines (first one per criterion wins). */
export function judgementsOf(text: string): Map<string, Result> {
  const out = new Map<string, Result>();
  for (const line of text.split("\n")) {
    const m = /^\s*JUDGED\s+(C\d+)\s*:\s*(PASS|FAIL|INCONCLUSIVE|TOOLKIT-GAP)\b/.exec(line);
    if (m && !out.has(m[1])) out.set(m[1], m[2] as Result);
  }
  return out;
}

type Citable = Pick<Entry, "id" | "sha" | "round" | "criterion"> & { role?: unknown; dirty?: unknown };

/** Why one criterion's citations don't hold, or null. */
export function citationProblemFor(c: string, ids: string[] | undefined, entries: Citable[], head: string, round: number): string | null {
  if (!ids?.length) return `${c} is judged and cites no evidence`;
  for (const id of ids) {
    const e = entries.find((x) => x.id === id);
    if (!e) return `${c} cites ${id}, which is not in the manifest`;
    if (e.sha !== head) return `${c} cites ${id}, stamped for ${e.sha.slice(0, 8)}, not HEAD ${head.slice(0, 8)}`;
    if (e.dirty === true) return `${c} cites ${id}, stamped on a dirty tree`;
    if (e.round !== round) return `${c} cites ${id}, stamped in round ${e.round}, not ${round}`;
    if (e.criterion !== c) return `${c} cites ${id}, stamped for ${e.criterion}`;
    if (!CITABLE_ROLES.includes(String(e.role))) return `${c} cites ${id}, a ${String(e.role)} self-check, not proof`;
  }
  return null;
}

/** Every judged criterion needs ≥1 citation; every cited id must hold. First problem, or null. */
export function citationProblem(judged: string[], cited: Map<string, string[]>, entries: Citable[], head: string, round: number): string | null {
  for (const c of judged) if (!cited.get(c)?.length) return `${c} is judged and cites no evidence`;
  for (const [c, ids] of cited) {
    const p = citationProblemFor(c, ids, entries, head, round);
    if (p) return p;
  }
  return null;
}

const RANK: Result[] = ["PASS", "INCONCLUSIVE", "TOOLKIT-GAP", "FAIL"];
const worst = (rs: Result[]): Result => rs.reduce<Result>((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), "PASS");

export function decideVerdict(o: {
  criteria: Pick<Criterion, "id" | "expect">[];
  proofs: ProofRecord[];
  /** verify.md, or null when no agent ran (no judged criteria, or a mechanical one already failed). */
  judgedText: string | null;
  /** The verified manifest's entries, or null when verifyManifest refused it. */
  entries: Entry[] | null;
  head: string;
  round: number;
  argsDeltas?: ArgsDelta[];
}): Verdict {
  const entries = o.entries ?? [];
  const judgements = o.judgedText ? judgementsOf(o.judgedText) : new Map<string, Result>();
  const cited = o.judgedText ? citationsOf(o.judgedText) : new Map<string, string[]>();
  const agentVerdict = o.judgedText ? (/^\s*VERDICT:\s*(PASS|FAIL|INCONCLUSIVE|TOOLKIT-GAP)\b/m.exec(o.judgedText)?.[1] as Result | undefined) : undefined;
  const agentGap = o.judgedText ? /^\s*GAP:\s*(\S+)/m.exec(o.judgedText)?.[1] : undefined;
  let citationProblemText: string | undefined;
  const out: CriterionVerdict[] = o.criteria.map((c) => {
    const proof = o.proofs.find((p) => p.criterion === c.id);
    const judged = (c.expect ?? "").trim() === "judged";
    if (!proof) return { id: c.id, judged, result: "INCONCLUSIVE", why: "its proof did not run", evidence: [] };
    if (!judged || proof.result !== "PASS") return { id: c.id, judged, result: proof.result, why: proof.why, evidence: proof.evidence };
    if (o.judgedText === null) return { id: c.id, judged, result: "INCONCLUSIVE", why: "no verifier judgement", evidence: proof.evidence };
    const said = judgements.get(c.id) ?? (agentVerdict === "INCONCLUSIVE" || agentVerdict === "TOOLKIT-GAP" ? agentVerdict : undefined);
    if (!said) return { id: c.id, judged, result: "FAIL", why: "the verifier gave no JUDGED line", evidence: [] };
    const ids = cited.get(c.id) ?? [];
    if (said === "PASS") {
      const p = citationProblemFor(c.id, ids, entries, o.head, o.round);
      if (p) {
        citationProblemText ??= p;
        return { id: c.id, judged, result: "FAIL", why: `citation refused: ${p}`, evidence: ids };
      }
    }
    return { id: c.id, judged, result: said, why: said === "PASS" ? undefined : "judged by the verifier", evidence: ids };
  });
  const verdict = worst(out.map((c) => c.result));
  const gap = verdict === "TOOLKIT-GAP" ? (o.proofs.find((p) => p.gap)?.gap ?? agentGap) : undefined;
  return {
    verdict,
    criteria: out,
    manifestOk: o.entries !== null,
    citationsOk: !citationProblemText,
    ...(citationProblemText ? { citationProblem: citationProblemText } : {}),
    ...(gap ? { gap } : {}),
    argsDeltas: o.argsDeltas ?? [],
  };
}

/** verdict.md: the engine's table, for people and the report. */
export function renderVerdict(v: Verdict, head: string, round: number): string {
  return [
    `VERDICT: ${v.verdict}`,
    `HEAD: ${head}`,
    `ROUND: ${round}`,
    `MANIFEST: ${v.manifestOk ? "verified" : "REFUSED"}`,
    ...(v.gap ? [`GAP: ${v.gap}`] : []),
    "",
    "| criterion | decided by | result | evidence | why |",
    "|---|---|---|---|---|",
    ...v.criteria.map(
      (c) => `| ${c.id} | ${c.judged ? "verifier" : "engine"} | ${c.result} | ${c.evidence.join(" ")} | ${(c.why ?? "").replace(/\|/g, "\\|")} |`,
    ),
    ...(v.argsDeltas.length
      ? [
          "",
          "Drive args changed from the spec (`--args`):",
          ...v.argsDeltas.map((d) => `- ${d.criterion} ${d.drive}: ${JSON.stringify(d.spec)} → ${JSON.stringify(d.used)} (${d.by})`),
        ]
      : []),
    "",
  ].join("\n");
}
