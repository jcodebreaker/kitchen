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

/** NO-TOOLKIT: the criterion drives the app and the repo has no Toolkit, so nothing proved it (ADR 0010). Never a pass, never a failure. */
export type Result = "PASS" | "FAIL" | "INCONCLUSIVE" | "TOOLKIT-GAP" | "NO-TOOLKIT";
export const NOT_PROVEN_NO_TOOLKIT = "not proven (no Toolkit): it needs Kitchen to drive the app";
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
  verdict: Exclude<Result, "NO-TOOLKIT">;
  criteria: CriterionVerdict[];
  manifestOk: boolean;
  citationsOk: boolean;
  citationProblem?: string;
  gap?: string;
  argsDeltas: ArgsDelta[];
  /** Criteria that already passed on the base: a pass on them doesn't tell this change from no change. */
  nonDiscriminating: string[];
};

/** Roles whose entries a Verdict may cite. A builder's self-check is never proof. */
export const CITABLE_ROLES = ["engine", "verifier"];

const NOTHING = /^(none|no|n\/?a|null|nil|-+|—|false|0|\(none\)|<.*>)$/i;
const PRIMITIVE_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * The missing primitive a `GAP:` header value names, or undefined. The value must be
 * one primitive-shaped word (optionally in backticks), alone or followed by a
 * separator and a note (`drag (to reorder rows)`, `drag: …`); free text such as
 * "the `read` primitive fails" names nothing. A name the Toolkit already has
 * (`known`, from describe) is not missing. Pure.
 */
export function gapName(v: string | undefined, known: readonly string[] = []): string | undefined {
  const m = /^`?([^\s`,;:(]+)`?\s*([\s\S]*)$/.exec(v?.trim() ?? "");
  if (!m) return undefined;
  const [, t, rest] = m;
  if (NOTHING.test(t) || !PRIMITIVE_NAME.test(t) || known.includes(t)) return undefined;
  if (rest && !/^([(:,;]|[—–]|-\s)/.test(rest)) return undefined;
  return t;
}

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

// NO-TOOLKIT ranks below PASS: it neither fails a job nor counts as proof (the Report says which criteria it is).
const RANK: Result[] = ["NO-TOOLKIT", "PASS", "INCONCLUSIVE", "TOOLKIT-GAP", "FAIL"];
const worst = (rs: Result[]): Verdict["verdict"] =>
  rs.reduce<Verdict["verdict"]>((a, b) => (b !== "NO-TOOLKIT" && RANK.indexOf(b) > RANK.indexOf(a) ? b : a), "PASS");

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
  /** describe's primitives: a GAP that names one of them names nothing missing. */
  primitives?: string[];
  /** Criteria whose mechanical expect already held on the base before the change: flagged, not failed. */
  nonDiscriminating?: string[];
}): Verdict {
  const entries = o.entries ?? [];
  const judgements = o.judgedText ? judgementsOf(o.judgedText) : new Map<string, Result>();
  const cited = o.judgedText ? citationsOf(o.judgedText) : new Map<string, string[]>();
  const agentVerdict = o.judgedText ? (/^\s*VERDICT:\s*(PASS|FAIL|INCONCLUSIVE|TOOLKIT-GAP)\b/m.exec(o.judgedText)?.[1] as Result | undefined) : undefined;
  const agentGap = o.judgedText ? gapName(/^\s*GAP:[ \t]*(.*)$/m.exec(o.judgedText)?.[1], o.primitives) : undefined;
  let citationProblemText: string | undefined;
  const out: CriterionVerdict[] = o.criteria.map((c) => {
    const proof = o.proofs.find((p) => p.criterion === c.id);
    const judged = (c.expect ?? "").trim() === "judged";
    if (!proof) return { id: c.id, judged, result: "INCONCLUSIVE", why: "its proof did not run", evidence: [] };
    if (!judged || proof.result !== "PASS") return { id: c.id, judged, result: proof.result, why: proof.why, evidence: proof.evidence };
    if (o.judgedText === null) return { id: c.id, judged, result: "INCONCLUSIVE", why: "no verifier judgement", evidence: proof.evidence };
    let said = judgements.get(c.id) ?? (agentVerdict === "INCONCLUSIVE" || agentVerdict === "TOOLKIT-GAP" ? agentVerdict : undefined);
    if (!said) return { id: c.id, judged, result: "FAIL", why: "the verifier gave no JUDGED line", evidence: [] };
    // A TOOLKIT-GAP must name a missing primitive; free text names nothing a smith could add.
    if (said === "TOOLKIT-GAP" && !agentGap) said = "INCONCLUSIVE";
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
  let verdict = worst(out.map((c) => c.result));
  // Evidence that doesn't verify proves nothing: a refused manifest is never a PASS.
  if (o.entries === null && verdict === "PASS") verdict = "INCONCLUSIVE";
  const gap = verdict === "TOOLKIT-GAP" ? (o.proofs.find((p) => p.gap)?.gap ?? agentGap) : undefined;
  return {
    verdict,
    criteria: out,
    manifestOk: o.entries !== null,
    citationsOk: !citationProblemText,
    ...(citationProblemText ? { citationProblem: citationProblemText } : {}),
    ...(gap ? { gap } : {}),
    argsDeltas: o.argsDeltas ?? [],
    nonDiscriminating: o.nonDiscriminating ?? [],
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
      (c) =>
        `| ${c.id} | ${c.judged ? "verifier" : "engine"} | ${c.result} | ${c.evidence.join(" ")} | ${[
          ...(v.nonDiscriminating.includes(c.id) ? ["NON-DISCRIMINATING (held on the base too)"] : []),
          ...(c.why ? [c.why] : []),
        ]
          .join("; ")
          .replace(/\|/g, "\\|")} |`,
    ),
    ...(v.nonDiscriminating.length
      ? [
          "",
          `NON-DISCRIMINATING: ${v.nonDiscriminating.join(" ")} (already held on the base before the change, so passing proves nothing about it: base-check.json)`,
        ]
      : []),
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
