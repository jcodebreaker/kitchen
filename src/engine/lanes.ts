// The files each lane agent leaves, and what `kitchen job finish` reads from them. Pure parsers: what an agent
// wrote goes in, a decision or the reason it is refused comes out. An agent never moves a job; Kitchen does, from
// these files.
//
//   intake  → .kitchen/jobs/<id>/intake.md
//   build   → commits on kitchen/<id> (Kitchen runs the checks itself)
//   qa      → .kitchen/jobs/<id>/rounds/<n>/qa/verdict.json, plus the evidence files it cites (same folder)
//   review  → .kitchen/jobs/<id>/rounds/<n>/review.json
import fs from "node:fs";
import path from "node:path";
import type { Kind, Risk } from "./machine.ts";
import { roundDir } from "./store.ts";

export const CHECK_KINDS = ["page", "http", "test", "cmd"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export type Criterion = { id: string; text: string; check: CheckKind };

export type Intake =
  | {
      decision: "ACCEPT";
      title: string | null;
      kind: Kind;
      risk: Risk;
      surfaces: ("ui" | "security")[];
      files: string[];
      after: string[];
      criteria: Criterion[];
    }
  | { decision: "NEEDS-INFO"; question: string; title: string | null }
  | { decision: "REJECT"; reason: string; title: string | null };

const header = (text: string, k: string) => new RegExp(`^${k}:[ \\t]*(.*)$`, "mi").exec(text)?.[1].trim() ?? "";
const list = (v: string) =>
  v
    .split(/[,\s]+/)
    .map((x) => x.replace(/^[`'"]+|[`'".;]+$/g, ""))
    .filter((x) => x && !/^(none|-|n\/a)$/i.test(x));

/** Pure: the criteria lines `- C1 (page): what must be true`, in order. */
export function parseCriteria(text: string): Criterion[] {
  const out: Criterion[] = [];
  for (const m of text.matchAll(/^\s*[-*]\s*\**(C\d+)\**\s*\(\s*([a-z]+)\s*\)\s*:\s*(.+)$/gim)) {
    const check = m[2].toLowerCase() as CheckKind;
    if ((CHECK_KINDS as readonly string[]).includes(check) && !out.some((c) => c.id === m[1].toUpperCase()))
      out.push({ id: m[1].toUpperCase(), text: m[3].trim(), check });
  }
  return out;
}

/** Pure: intake.md, or the reason it can't be used (the intake lane runs again with that reason). */
export function parseIntake(text: string): Intake | { refused: string } {
  const decision = header(text, "DECISION").toUpperCase();
  const title = header(text, "TITLE") || null;
  if (decision === "NEEDS-INFO") {
    const question = header(text, "QUESTION");
    return question ? { decision, question, title } : { refused: "NEEDS-INFO needs a QUESTION: line" };
  }
  if (decision === "REJECT") return { decision, reason: header(text, "REASON") || "intake rejected it", title };
  if (decision !== "ACCEPT") return { refused: `DECISION: is ACCEPT, NEEDS-INFO or REJECT (got ${JSON.stringify(decision || "nothing")})` };
  const kind = header(text, "KIND").toLowerCase();
  if (!["feature", "bug", "ui", "chore"].includes(kind)) return { refused: "KIND: is feature, bug, ui or chore" };
  const risk = header(text, "RISK").toLowerCase();
  if (!["low", "medium", "high"].includes(risk)) return { refused: "RISK: is low, medium or high" };
  const surfaces = list(header(text, "SURFACES").toLowerCase()).filter((s): s is "ui" | "security" => s === "ui" || s === "security");
  const criteria = parseCriteria(text);
  if (!criteria.length) return { refused: "ACCEPT needs at least one criterion: `- C1 (page|http|test|cmd): what must be true`" };
  const after = list(header(text, "AFTER")).flatMap((x) => (/^\d{1,6}$/.test(x) ? [x.padStart(3, "0")] : /^\d{3,}-/.test(x) ? [x.split("-")[0]] : []));
  return { decision: "ACCEPT", title, kind: kind as Kind, risk: risk as Risk, surfaces, files: list(header(text, "FILES")), after, criteria };
}

export const intakeFile = (jobDir: string) => path.join(jobDir, "intake.md");
/** The accepted intake's criteria, or [] before intake accepted it. */
export function criteriaOf(jobDir: string): Criterion[] {
  try {
    const i = parseIntake(fs.readFileSync(intakeFile(jobDir), "utf8"));
    return "decision" in i && i.decision === "ACCEPT" ? i.criteria : [];
  } catch {
    return [];
  }
}

export const qaDir = (jobDir: string, round: number) => path.join(roundDir(jobDir, round), "qa");
export const qaVerdictFile = (jobDir: string, round: number) => path.join(qaDir(jobDir, round), "verdict.json");
export type QaRow = { id: string; result: "PASS" | "FAIL"; evidence: string[]; note: string };
export type QaVerdict = { verdict: "PASS" | "FAIL"; criteria: QaRow[] };

/**
 * Pure apart from reading the evidence folder: the QA verdict, or why it is refused. Every criterion must have a row;
 * every row cites evidence files that exist in the QA folder and aren't empty; a page criterion cites a screenshot.
 * The verdict is PASS only when every row is (the agent's own verdict line is checked against its rows).
 */
export function readQa(jobDir: string, round: number, criteria: Criterion[]): QaVerdict | { refused: string } {
  const dir = qaDir(jobDir, round);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(qaVerdictFile(jobDir, round), "utf8"));
  } catch (e) {
    return { refused: `no readable ${path.relative(jobDir, qaVerdictFile(jobDir, round))}: ${(e as Error).message.split("\n")[0]}` };
  }
  const v = raw as { verdict?: unknown; criteria?: unknown };
  if (!Array.isArray(v.criteria)) return { refused: "verdict.json needs a criteria array" };
  const rows: QaRow[] = [];
  for (const r of v.criteria as Record<string, unknown>[]) {
    const id = String(r?.id ?? "").toUpperCase();
    const result = String(r?.result ?? "").toUpperCase();
    if (!/^C\d+$/.test(id)) return { refused: `a row's id is C<n> (got ${JSON.stringify(r?.id)})` };
    if (result !== "PASS" && result !== "FAIL") return { refused: `${id}: result is PASS or FAIL` };
    const evidence = Array.isArray(r.evidence) ? r.evidence.map(String) : [];
    rows.push({ id, result, evidence, note: String(r.note ?? "") });
  }
  for (const c of criteria) {
    const row = rows.find((r) => r.id === c.id);
    if (!row) return { refused: `no row for ${c.id}` };
    if (!row.evidence.length) return { refused: `${c.id} cites no evidence file` };
    for (const f of row.evidence) {
      const p = path.resolve(dir, f);
      if (!p.startsWith(`${dir}${path.sep}`)) return { refused: `${c.id}: evidence ${f} is outside the QA folder` };
      if (!fs.existsSync(p) || !fs.statSync(p).isFile() || fs.statSync(p).size === 0) return { refused: `${c.id}: evidence ${f} is missing or empty` };
    }
    if (c.check === "page" && row.result === "PASS" && !row.evidence.some((f) => /\.(png|jpe?g)$/i.test(f)))
      return { refused: `${c.id} is a page criterion: its PASS cites a screenshot` };
  }
  const allPass = criteria.every((c) => rows.find((r) => r.id === c.id)?.result === "PASS");
  const said = String(v.verdict ?? "").toUpperCase();
  if (said === "PASS" && !allPass) return { refused: "verdict PASS, but a criterion's row is FAIL" };
  return { verdict: allPass ? "PASS" : "FAIL", criteria: rows };
}

export const reviewFile = (jobDir: string, round: number) => path.join(roundDir(jobDir, round), "review.json");
export type Finding = { id: string; blocks: boolean; at?: string; category?: string; why: string };
export type Review = { verdict: "PASS" | "BLOCKING"; findings: Finding[]; summary: string };

/** Pure apart from the read: the review, or why it is refused. It blocks exactly when a finding does. */
export function readReview(jobDir: string, round: number): Review | { refused: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(reviewFile(jobDir, round), "utf8"));
  } catch (e) {
    return { refused: `no readable ${path.relative(jobDir, reviewFile(jobDir, round))}: ${(e as Error).message.split("\n")[0]}` };
  }
  const v = raw as { findings?: unknown; summary?: unknown };
  if (!Array.isArray(v.findings)) return { refused: "review.json needs a findings array (empty when there are none)" };
  const findings: Finding[] = (v.findings as Record<string, unknown>[]).map((f, i) => ({
    id: String(f?.id ?? `F${i + 1}`),
    blocks: f?.blocks === true,
    ...(f?.at ? { at: String(f.at) } : {}),
    ...(f?.category ? { category: String(f.category) } : {}),
    why: String(f?.why ?? ""),
  }));
  if (findings.some((f) => f.blocks && !f.why.trim())) return { refused: "a blocking finding needs a why" };
  return { verdict: findings.some((f) => f.blocks) ? "BLOCKING" : "PASS", findings, summary: String(v.summary ?? "") };
}

/** Pure: glob-ish match for high_paths (`**`, `*`). */
export function matchPath(glob: string, file: string): boolean {
  const re = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*")
    .replace(/\.\*\//g, "(?:.*/)?");
  return new RegExp(`^${re}$`).test(file);
}
