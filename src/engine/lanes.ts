// The files each lane agent leaves, and what `kitchen job finish` reads from them. Pure parsers: what an agent
// wrote goes in, a decision or the reason it is refused comes out. An agent never moves a job; Kitchen does, from
// these files.
//
//   intake  → .kitchen/jobs/<id>/intake.md
//   build   → commits on kitchen/<id> (Kitchen runs the checks itself)
//   qa      → .kitchen/jobs/<id>/rounds/<n>/qa/verdict.json, plus the evidence files it cites (same folder)
//   review  → .kitchen/jobs/<id>/rounds/<n>/review.json
//   regress → .kitchen/jobs/<id>/rounds/<n>/regress/verdict.json (one row per feature driven), plus its evidence
import fs from "node:fs";
import path from "node:path";
import { EXPLORE_MINUTES, KINDS, type Kind, REFINE_REASONS, type RefineReason, type Risk } from "./machine.ts";
import { roundDir } from "./store.ts";

export const CHECK_KINDS = ["page", "http", "test", "cmd"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
/** ADR 0031 §4: `given`: the state the claim needs (`· given: <state>`), which QA shows held before checking it. */
export type Criterion = { id: string; text: string; check: CheckKind; given?: string };

export type Intake =
  | {
      decision: "ACCEPT";
      title: string | null;
      kind: Kind;
      risk: Risk;
      surfaces: ("ui" | "security")[];
      files: string[];
      after: string[];
      /** Behaviour this ticket changes on purpose, as `<feature>/<sub-feature>` of the verify map (ADR 0017 §4). */
      changes: string[];
      criteria: Criterion[];
      /** ADR 0020: later slices of a ticket split with its author (`## Later slices`); Kitchen files each as a ticket. */
      slices: string[];
      /** ADR 0028: a check that explores (`EXPLORE: <minutes>`): QA drives freely that long and reports findings. */
      explore?: number;
      /** ADR 0028 amendment: `KEEP: no`: built only to verify now, never merged unless promoted. Default true; a check has none. */
      keep: boolean;
    }
  | { decision: "NEEDS-INFO"; question: string; title: string | null }
  /** ADR 0020: the ticket is refined with its author before it is built. `items`: the readings, slices or gaps. */
  | { decision: "REFINE"; reason: RefineReason; items: string[]; title: string | null }
  | { decision: "REJECT"; reason: string; title: string | null };

const header = (text: string, k: string) => new RegExp(`^${k}:[ \\t]*(.*)$`, "mi").exec(text)?.[1].trim() ?? "";
const list = (v: string) =>
  v
    .split(/[,\s]+/)
    .map((x) => x.replace(/^[`'"]+|[`'".;]+$/g, ""))
    .filter((x) => x && !/^(none|-|n\/a)$/i.test(x));

/**
 * Pure: the criteria lines `- C1 (page): what must be true`, in order. ADR 0029 §1, `strict` (intake's own finish):
 * every criterion line (`- C<n> (` or `- C<n>:`) must parse: one kind (any case), text after the colon, a new id;
 * else why not. Nothing is guessed or merged. Lenient (everyone reading an intake already accepted, possibly before
 * this rule): the lines that parse, the first of a repeated id.
 */
export function parseCriteria(text: string, o: { strict?: boolean } = {}): Criterion[] | { refused: string } {
  const out: Criterion[] = [];
  const bad: string[] = [];
  const lines = [...text.matchAll(/^[ \t]*[-*][ \t]*\**[ \t]*(C\d+)\**[ \t]*(?=[(:])(.*)$/gim)];
  let next = Math.max(0, ...lines.map((m) => Number(m[1].slice(1)))) + 1;
  for (const m of lines) {
    const id = m[1].toUpperCase();
    const k = /^\(([^)]*)\)\**[ \t]*(:)?\**[ \t]*(.*)$/.exec(m[2]);
    if (!k) {
      bad.push(`${id} has no kind: write - ${id} (page|http|test|cmd): …`);
      continue;
    }
    const said = k[1].trim();
    const kinds = said
      .toLowerCase()
      .split(/\s*(?:[+,/&|]|\band\b|\bor\b)\s*|\s+/)
      .filter(Boolean);
    const known = kinds.every((x) => (CHECK_KINDS as readonly string[]).includes(x));
    const body = k[3].replace(/^\*+\s*/, "").trim();
    if (kinds.length > 1 && known) {
      const ids = kinds.map((x, i) => `${i ? `C${next++}` : id} (${x})`);
      bad.push(`${id} (${said}): one kind per criterion: split it into ${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);
    } else if (kinds.length !== 1 || !known) bad.push(`${id} (${said}): the kind is one of page, http, test or cmd: write - ${id} (page|http|test|cmd): …`);
    else if (!k[2]) bad.push(`${id} (${kinds[0]}) needs a colon and what must be true after it: write - ${id} (${kinds[0]}): …`);
    else if (!body) bad.push(`${id} (${kinds[0]}) needs what must be true after the colon: write - ${id} (${kinds[0]}): …`);
    else if (out.some((c) => c.id === id)) bad.push(`${id} is listed twice`);
    else {
      const g = givenOf(body);
      if (!g.text) bad.push(`${id} (${kinds[0]}) needs what must be true before given: write - ${id} (${kinds[0]}): … · given: <state>`);
      else if (g.given === "") bad.push(`${id}: given: names the state the claim needs: write - ${id} (${kinds[0]}): … · given: <state>`);
      else out.push({ id, text: g.text, check: kinds[0] as CheckKind, ...(g.given ? { given: g.given } : {}) });
    }
  }
  return o.strict && bad.length ? { refused: bad.join("; ") } : out;
}

/** Pure, ADR 0031 §4: a criterion's claim as written, its precondition included (briefs, the dashboard, refine). */
export const claimOf = (c: Pick<Criterion, "text" | "given">) => `${c.text}${c.given ? `${GIVEN}${c.given}` : ""}`;

/**
 * Pure, ADR 0031 §4: a criterion's claim and its optional precondition (`<claim> · given: <state>`): only that
 * separator, exactly, at its last occurrence, so a claim's own `;`, `|` or "given:" stays in the claim.
 */
export function givenOf(said: string): { text: string; given?: string } {
  const t = ` ${said.trim()}`;
  const at = t.lastIndexOf(GIVEN);
  if (at < 0) return t.endsWith(GIVEN.trimEnd()) ? { text: t.slice(0, -GIVEN.trimEnd().length).trim(), given: "" } : { text: t.trim() };
  return { text: t.slice(0, at).trim(), given: t.slice(at + GIVEN.length).trim() };
}
const GIVEN = " · given: ";

/**
 * Pure: intake.md, or the reason it can't be used (the intake lane runs again with that reason). `strict` (ADR 0029
 * §1): only when intake's lane finishes; an intake accepted earlier is read leniently, keeping what parses.
 */
export function parseIntake(text: string, o: { strict?: boolean } = {}): Intake | { refused: string } {
  const decision = header(text, "DECISION").toUpperCase();
  const title = header(text, "TITLE") || null;
  if (decision === "NEEDS-INFO") {
    const question = header(text, "QUESTION");
    return question ? { decision, question, title } : { refused: "NEEDS-INFO needs a QUESTION: line" };
  }
  if (decision === "REJECT") return { decision, reason: header(text, "REASON") || "intake rejected it", title };
  if (decision === "REFINE") {
    const said = header(text, "REASON")
      .toLowerCase()
      .replace(/^[`*]+/, "")
      .replace(/^(too|no)[ _]/, "$1-");
    const reason = REFINE_REASONS.find((r) => new RegExp(`^${r}\\b`).test(said));
    if (!reason) return { refused: `REFINE needs REASON: ${REFINE_REASONS.join(" | ")}` };
    const items = refineItems(text);
    if (!items.length) return { refused: "REFINE needs a `## Refine` section with at least one `- ` line: the readings, slices or gaps" };
    return { decision, reason, items, title };
  }
  if (decision !== "ACCEPT") return { refused: `DECISION: is ACCEPT, NEEDS-INFO, REFINE or REJECT (got ${JSON.stringify(decision || "nothing")})` };
  const kind = header(text, "KIND").toLowerCase();
  if (!(KINDS as readonly string[]).includes(kind)) return { refused: "KIND: is feature, bug, ui, chore or check" };
  const check = kind === "check";
  // ADR 0028: a check changes nothing, so its risk is low unless intake says otherwise.
  const risk = header(text, "RISK").toLowerCase() || (check ? "low" : "");
  if (!["low", "medium", "high"].includes(risk)) return { refused: "RISK: is low, medium or high" };
  const surfaces = list(header(text, "SURFACES").toLowerCase()).filter((s): s is "ui" | "security" => s === "ui" || s === "security");
  const criteria = parseCriteria(text, o);
  if ("refused" in criteria) return criteria;
  const explore = check ? exploreOf(text) : undefined;
  if (!criteria.length && explore === undefined)
    return {
      refused: check
        ? "a check needs at least one criterion (`- C1 (page|http|test|cmd): what to check`) or an EXPLORE: <minutes> line"
        : "ACCEPT needs at least one criterion: `- C1 (page|http|test|cmd): what must be true`",
    };
  const after = list(header(text, "AFTER")).flatMap((x) => (/^\d{1,6}$/.test(x) ? [x.padStart(3, "0")] : /^\d{3,}-/.test(x) ? [x.split("-")[0]] : []));
  const changes = list(header(text, "CHANGES")).filter((x) => /^[\w.-]+\/[\w.-]+$/.test(x));
  return {
    decision: "ACCEPT",
    title,
    kind: kind as Kind,
    risk: risk as Risk,
    surfaces,
    files: list(header(text, "FILES")),
    after,
    changes,
    criteria,
    slices: sectionItems(text, "Later slices"),
    ...(explore !== undefined ? { explore } : {}),
    keep: check || !/^(no|false|n)\b/i.test(header(text, "KEEP")),
  };
}

/** Pure: a check's `EXPLORE:` line in minutes (no number: EXPLORE_MINUTES, at most 120), or undefined without one. */
export function exploreOf(text: string): number | undefined {
  const m = /^EXPLORE:[ \t]*(.*)$/im.exec(text);
  if (!m) return undefined;
  const said = m[1].trim();
  if (/^(none|no|-|n\/a)\.?$/i.test(said)) return undefined;
  const n = Number(/\d+/.exec(said)?.[0] ?? EXPLORE_MINUTES);
  return Math.min(120, Math.max(1, n || EXPLORE_MINUTES));
}

/** Pure: the `- ` lines under intake's `## Refine` heading, up to the next heading. */
export const refineItems = (text: string): string[] => sectionItems(text, "Refine");

/** Pure: the `- ` lines under the `## <heading>` section, up to the next heading. */
function sectionItems(text: string, heading: string): string[] {
  const body = new RegExp(`^##[ \\t]+${heading.replace(/ /g, "[ \\t]+")}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,6}[ \\t]|(?![\\s\\S]))`, "im").exec(text)?.[1] ?? "";
  return [...body.matchAll(/^[ \t]*[-*][ \t]+(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
}

/** The intake as written (any decision), or null when there is none or it can't be used. */
export function readIntake(jobDir: string): Intake | null {
  try {
    const i = parseIntake(fs.readFileSync(intakeFile(jobDir), "utf8"));
    return "decision" in i ? i : null;
  } catch {
    return null;
  }
}

export const intakeFile = (jobDir: string) => path.join(jobDir, "intake.md");
/** What intake considered and left out (its LEFT OUT: line), or "" when nothing was. */
export function leftOutOf(jobDir: string): string {
  try {
    const v = header(fs.readFileSync(intakeFile(jobDir), "utf8"), "LEFT OUT");
    return /^(nothing|none|-|n\/a)?\.?$/i.test(v) ? "" : v;
  } catch {
    return "";
  }
}
/** The accepted intake's CHANGES: entries (`feature/sub-feature`), or []. */
export function changesOf(jobDir: string): string[] {
  try {
    const i = parseIntake(fs.readFileSync(intakeFile(jobDir), "utf8"));
    return "decision" in i && i.decision === "ACCEPT" ? i.changes : [];
  } catch {
    return [];
  }
}
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
/**
 * ADR 0029 §2: NOT_RUN: QA couldn't test this row (the seed, a service down, the app won't start, its precondition
 * didn't hold); `why` says so. ADR 0031 §4: `given`: the evidence (and a note) that the criterion's precondition held.
 */
export type QaRow = {
  id: string;
  result: "PASS" | "FAIL" | "NOT_RUN";
  evidence: string[];
  note: string;
  why?: string;
  given?: { evidence: string[]; note: string };
};
/**
 * ADR 0028: a problem a check found: a proposed bug (what was seen, how to see it again, the evidence). ADR 0031 §1
 * (as ADR 0036 left it): what was expected, the cause QA thinks it has (free text), and `severity`. Older ones have neither.
 */
export type QaFinding = {
  title: string;
  seen: string;
  repro: string[];
  evidence: string[];
  criterion?: string;
  expected?: string;
  cause?: string;
  severity?: Risk;
  /** ADR 0033 §4: not a problem in the app: the project lacks the tooling to verify it (`title` names the tooling). */
  kind?: "tooling";
  /** ADR 0033 §4: a tooling finding's NOT_RUN rows (`criterion` and any `criteria`). */
  criteria?: string[];
};
export type QaVerdict = {
  /**
   * ADR 0029 §2: INCOMPLETE: a row is NOT_RUN and none FAILED. It never passes and is never a fail: Kitchen runs all
   * of QA again once (ADR 0036). A FAIL anywhere is FAIL.
   */
  verdict: "PASS" | "FAIL" | "INCOMPLETE";
  criteria: QaRow[];
  /** A check's problems, one per failure or finding (ADR 0028 §3); [] for a job's QA. */
  findings: QaFinding[];
  /** BLOCKED (every row NOT_RUN: QA couldn't run at all): why, and the files it cites (in the QA folder). */
  blocked?: string;
  evidence?: string[];
};

/** Pure apart from the stat: the evidence file is in `dir`, a file, and not empty. */
export const goodEvidence = (dir: string, f: string) => {
  const p = path.resolve(dir, f);
  return p.startsWith(`${dir}${path.sep}`) && fs.existsSync(p) && fs.statSync(p).isFile() && fs.statSync(p).size > 0;
};

/**
 * Pure apart from reading the evidence folder: the QA verdict, or why it is refused. Every criterion must have a row;
 * every row cites evidence files that exist in the QA folder and aren't empty; a page criterion cites a screenshot.
 * The verdict is PASS only when every row is (the agent's own verdict line is checked against its rows).
 *
 * ADR 0029 §2: a row may be NOT_RUN (`why`, evidence): QA couldn't test it. A verdict BLOCKED (`blocked`, `evidence`)
 * is every row NOT_RUN.
 *
 * ADR 0028, `check`: `findings` lists each problem
 * as a proposed bug: `{ title, seen, repro: [steps], evidence: [files], criterion? }`. Every FAIL row has one (its
 * `criterion`); an exploring check's findings stand alone. A check passes only with every row PASS and no finding.
 *
 * ADR 0031: a finding's `expected`, `cause` and `severity` (findingFields). `strict` (the finish path): one that can't
 * be read refuses the verdict; elsewhere (the Report, proposing again) it is read leniently, so an older verdict still
 * renders. A row's `given` read-back and the captures' stamps are information only (ADR 0036): never a refusal.
 */
export function readQa(jobDir: string, round: number, criteria: Criterion[], o: { check?: boolean; strict?: boolean } = {}): QaVerdict | { refused: string } {
  const dir = qaDir(jobDir, round);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(qaVerdictFile(jobDir, round), "utf8"));
  } catch (e) {
    return { refused: `no readable ${path.relative(jobDir, qaVerdictFile(jobDir, round))}: ${(e as Error).message.split("\n")[0]}` };
  }
  const v = raw as { verdict?: unknown; criteria?: unknown; findings?: unknown; blocked?: unknown; evidence?: unknown };
  const said = String(v.verdict ?? "").toUpperCase();
  if (said === "BLOCKED") {
    const blocked = String(v.blocked ?? "").trim();
    if (!blocked) return { refused: "a BLOCKED verdict says why in blocked (the app won't start, the seed data is wrong, a service is down)" };
    const ev = Array.isArray(v.evidence) ? v.evidence.map(String) : [];
    const bad = ev.find((f) => !goodEvidence(dir, f));
    if (bad) return { refused: `BLOCKED: evidence ${bad} is missing, empty or outside the QA folder` };
    const rows = criteria.map((c): QaRow => ({ id: c.id, result: "NOT_RUN", evidence: ev, note: "", why: blocked }));
    return { verdict: "INCOMPLETE", criteria: rows, findings: [], blocked, evidence: ev };
  }
  if (!Array.isArray(v.criteria)) return { refused: "verdict.json needs a criteria array" };
  const rows: QaRow[] = [];
  for (const r of v.criteria as Record<string, unknown>[]) {
    const id = String(r?.id ?? "").toUpperCase();
    const result = String(r?.result ?? "").toUpperCase();
    // C<n>: a criterion. R-<feature>[/<sub-feature>]: a map recipe that didn't hold (ADR 0035: reported, never the verdict).
    if (!/^C\d+$/.test(id) && !/^R-[A-Z0-9][A-Z0-9-]*(\/[A-Z0-9][A-Z0-9-]*)?$/.test(id))
      return { refused: `a row's id is C<n>, or R-<feature>[/<sub-feature>] for a broken recipe (got ${JSON.stringify(r?.id)})` };
    const res = result.replace(/[ -]/g, "_");
    if (res !== "PASS" && res !== "FAIL" && res !== "NOT_RUN") return { refused: `${id}: result is PASS, FAIL or NOT_RUN` };
    const evidence = Array.isArray(r.evidence) ? r.evidence.map(String) : [];
    const why = String(r.why ?? "").trim();
    if (res === "NOT_RUN" && !why) return { refused: `${id} is NOT_RUN: say why in why (the seed, a service down, the app won't start)` };
    rows.push({ id, result: res as QaRow["result"], evidence, note: String(r.note ?? ""), ...(res === "NOT_RUN" ? { why } : {}), ...rowGiven(r) });
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
  for (const row of rows.filter((r) => r.id.startsWith("R-"))) {
    if (!row.evidence.length) return { refused: `${row.id} cites no evidence file` };
    for (const f of row.evidence) if (!goodEvidence(dir, f)) return { refused: `${row.id}: evidence ${f} is missing, empty or outside the QA folder` };
  }
  // ADR 0031 §4: any row's given evidence, whatever its criterion, is a file in the QA folder (the Report inlines it).
  // ADR 0036: a row without one is never refused.
  for (const r of rows) {
    const bad = (r.given?.evidence ?? []).find((f) => !goodEvidence(dir, f));
    if (bad) return { refused: `${r.id}: given evidence ${bad} is missing, empty or outside the QA folder` };
  }
  const findings: QaFinding[] = [];
  if (o.check) {
    if (v.findings !== undefined && !Array.isArray(v.findings)) return { refused: "findings is an array (empty when there are none)" };
    for (const [i, x] of ((v.findings ?? []) as Record<string, unknown>[]).entries()) {
      const title = String(x?.title ?? "").trim();
      const seen = String(x?.seen ?? "").trim();
      if (!title || !seen) return { refused: `finding ${i + 1} needs a title and what was seen (seen)` };
      const repro = (Array.isArray(x.repro) ? x.repro.map(String) : x.repro ? [String(x.repro)] : []).map((s) => s.trim()).filter(Boolean);
      if (x.kind !== undefined && x.kind !== "tooling") return { refused: `finding ${i + 1} (${title}): kind is "tooling" or absent` };
      const tooling = x.kind === "tooling";
      // ADR 0033 §4: missing tooling has nothing to reproduce.
      if (!repro.length && !tooling) return { refused: `finding ${i + 1} (${title}) needs repro: the steps to see it again` };
      const evidence = Array.isArray(x.evidence) ? x.evidence.map(String) : [];
      if (!evidence.length) return { refused: `finding ${i + 1} (${title}) cites no evidence file` };
      const bad = evidence.find((f) => !goodEvidence(dir, f));
      if (bad) return { refused: `finding ${i + 1} (${title}): evidence ${bad} is missing, empty or outside the QA folder` };
      // ADR 0033 §4: a tooling finding may cover several rows (`criteria`); `criterion` is its first.
      const many = tooling && Array.isArray(x.criteria) ? [...new Set(x.criteria.map((c) => String(c).toUpperCase()))] : [];
      const criterion = x.criterion ? String(x.criterion).toUpperCase() : many[0];
      const all = tooling && criterion ? [...new Set([criterion, ...many])] : [];
      // ADR 0031 §1 for every finding; a tooling one needs no expected or cause (nothing is broken, a tool is missing).
      const honest = findingFields(x, `finding ${i + 1} (${title})`, !!o.strict);
      if ("refused" in honest) return honest;
      findings.push({
        title: title.slice(0, 120),
        seen,
        repro,
        evidence,
        ...(criterion ? { criterion } : {}),
        ...(tooling ? { kind: "tooling" as const, criteria: all } : {}),
        ...honest,
      });
    }
    // ADR 0033 §4: a tooling finding covers exactly the NOT_RUN rows it names (missing tooling is why they couldn't
    // run). Never a FAIL or a PASS: a failure is a problem found and needs a real finding.
    for (const f of findings.filter((x) => x.kind === "tooling")) {
      if (!f.criteria?.length)
        return { refused: `tooling finding "${f.title}" names no criterion: give it criterion: "<the NOT_RUN row>" (or criteria: [...])` };
      for (const id of f.criteria) {
        const row = rows.find((r) => r.id === id);
        if (row?.result !== "NOT_RUN")
          return {
            refused: `tooling finding "${f.title}" names ${id}, which is ${row ? row.result : "no row"}: missing tooling covers only a NOT_RUN row (a FAIL needs its own finding)`,
          };
      }
    }
    // ADR 0029 §2: what QA couldn't test is never a problem found.
    const notRunFinding = findings.find((f) => f.kind !== "tooling" && rows.some((r) => r.id === f.criterion && r.result === "NOT_RUN"));
    if (notRunFinding)
      return { refused: `finding "${notRunFinding.title}" names ${notRunFinding.criterion}, which was NOT_RUN: a criterion not tested is no problem found` };
    const unexplained = rows.filter((r) => r.result === "FAIL" && !findings.some((f) => f.criterion === r.id)).map((r) => r.id);
    if (unexplained.length)
      return {
        refused: `${unexplained.join(", ")} FAILED with no finding: give each failure a finding (title, seen, repro, evidence, criterion: "${unexplained[0]}")`,
      };
  }
  // ADR 0035: only the ticket's criteria decide a job's verdict; a check's every row does (a FAIL is a finding).
  const counted = rows.filter((r) => criteria.some((c) => c.id === r.id) || o.check);
  // ADR 0033 §4: a NOT_RUN row a tooling finding covers waits for that tooling; any other NOT_RUN row is retried first.
  const covered = new Set(findings.flatMap((f) => (f.kind === "tooling" ? (f.criteria ?? []) : [])));
  const failed = counted.some((r) => r.result === "FAIL") || findings.some((f) => f.kind !== "tooling");
  const notRun = counted.some((r) => r.result === "NOT_RUN" && !covered.has(r.id));
  if (said === "PASS" && findings.length) return { refused: "verdict PASS, but it lists findings: a check with problems is FAIL" };
  if (said === "PASS" && (failed || notRun)) return { refused: `verdict PASS, but a criterion's row is ${failed ? "FAIL" : "NOT_RUN"}` };
  // ADR 0033 §4: a real FAIL is FAIL (everything proposed, ADR 0029); else rows nobody could test are run again first.
  const verdict = failed ? "FAIL" : notRun ? "INCOMPLETE" : covered.size ? "FAIL" : "PASS";
  return { verdict, criteria: rows, findings };
}

/**
 * ADR 0031 §2: what `kitchen qa page|http` stamp next to each capture (`<file>.meta.json`): the job and round (or the
 * verify run), the lane, the worktree's commit and whether it was dirty, the URL, the app instance, when. ADR 0036:
 * the Report shows it; nothing refuses on it.
 */
export type CaptureMeta = {
  job?: string;
  run?: string;
  round?: number;
  lane?: string;
  sha: string;
  dirty: boolean;
  url: string;
  app: { pid?: number; at?: string } | null;
  /** ADR 0034 §3: the browser a page capture was taken in (Playwright's `browser.version()`); none on http. */
  browser?: { name: string; version: string };
  at: string;
};
export const metaFile = (file: string) => `${file}.meta.json`;
/** A capture's stamp, or null when the file has none (made by hand) or it can't be read. */
export function readMeta(dir: string, f: string): CaptureMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaFile(path.resolve(dir, f)), "utf8")) as CaptureMeta;
  } catch {
    return null;
  }
}

/** ADR 0031 §4: a row's `given`, as `[files]` or `{ evidence, note }`. */
function rowGiven(r: Record<string, unknown>): { given?: { evidence: string[]; note: string } } {
  const g = r?.given as unknown;
  if (Array.isArray(g)) return { given: { evidence: g.map(String), note: "" } };
  if (g && typeof g === "object") {
    const o = g as { evidence?: unknown; note?: unknown };
    return { given: { evidence: Array.isArray(o.evidence) ? o.evidence.map(String) : [], note: String(o.note ?? "") } };
  }
  return {};
}

/**
 * ADR 0031 §1: a finding's `expected`, `cause` (free text; ADR 0036) and `severity`, or why it is refused (`strict`
 * only). An older verdict's cause object reads as its text.
 */
function findingFields(x: Record<string, unknown>, label: string, strict: boolean): Pick<QaFinding, "expected" | "cause" | "severity"> | { refused: string } {
  const out: Pick<QaFinding, "expected" | "cause" | "severity"> = {};
  if (strict && x.expected !== undefined && typeof x.expected !== "string") return { refused: `${label}: expected is a sentence (a string)` };
  if (strict && x.cause !== undefined && typeof x.cause !== "string") return { refused: `${label}: cause is a sentence (a string)` };
  const expected = typeof x.expected === "string" ? x.expected.trim() : "";
  if (expected) out.expected = expected;
  if (x.severity !== undefined) {
    const sev = String(x.severity).toLowerCase();
    if (sev === "low" || sev === "medium" || sev === "high") out.severity = sev;
    else if (strict) return { refused: `${label}: severity is low, medium or high` };
  }
  const c = x.cause as unknown;
  const cause = typeof c === "string" ? c.trim() : c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "").trim() : "";
  if (cause) out.cause = cause;
  return out;
}

export const regressDir = (jobDir: string, round: number) => path.join(roundDir(jobDir, round), "regress");
/** NOT_RUN: only a `--url` sweep's, for a recipe the deployed environment can't run (it needs a reset or seed). */
export type FeatureRow = { id: string; result: "PASS" | "FAIL" | "NOT_RUN"; evidence: string[]; note: string };
export type FeatureVerdict = { verdict: "PASS" | "FAIL"; features: FeatureRow[] };

/**
 * Pure apart from reading the folder: a drive of features (the regress lane, a sweep), from `<folder>/verdict.json`:
 * `{ verdict, features: [{ id, result, evidence, note }] }`. Every feature in `ids` has a row citing evidence files
 * that exist in the folder and aren't empty; the verdict is PASS only when every row is.
 */
export function readFeatureVerdict(folder: string, ids: string[], o: { notRun?: string[] } = {}): FeatureVerdict | { refused: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(folder, "verdict.json"), "utf8"));
  } catch (e) {
    return { refused: `no readable verdict.json in ${path.basename(folder)}/: ${(e as Error).message.split("\n")[0]}` };
  }
  const v = raw as { verdict?: unknown; features?: unknown };
  if (!Array.isArray(v.features)) return { refused: "verdict.json needs a features array" };
  const result = (r: Record<string, unknown>) =>
    String(r?.result ?? "")
      .toUpperCase()
      .replace(/[ -]/g, "_");
  const rows: FeatureRow[] = (v.features as Record<string, unknown>[]).map((r) => ({
    id: String(r?.id ?? ""),
    result: result(r) === "PASS" ? "PASS" : result(r) === "NOT_RUN" ? "NOT_RUN" : "FAIL",
    evidence: Array.isArray(r?.evidence) ? (r.evidence as unknown[]).map(String) : [],
    note: String(r?.note ?? ""),
  }));
  for (const r of v.features as Record<string, unknown>[]) {
    const res = result(r);
    if (res === "NOT_RUN" && !o.notRun?.includes(String(r?.id)))
      return { refused: `${String(r?.id)}: NOT_RUN is only for a recipe that needs a fresh seed on a deployed environment (a --url sweep)` };
    if (res !== "PASS" && res !== "FAIL" && res !== "NOT_RUN") return { refused: `${String(r?.id)}: result is PASS or FAIL` };
  }
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) return { refused: `no row for feature ${id}` };
    if (row.result === "NOT_RUN") continue;
    if (!row.evidence.length) return { refused: `${id} cites no evidence file` };
    for (const f of row.evidence) {
      const p = path.resolve(folder, f);
      if (!p.startsWith(`${folder}${path.sep}`)) return { refused: `${id}: evidence ${f} is outside the folder` };
      if (!fs.existsSync(p) || !fs.statSync(p).isFile() || fs.statSync(p).size === 0) return { refused: `${id}: evidence ${f} is missing or empty` };
    }
  }
  const allPass = ids.every((id) => rows.find((r) => r.id === id)?.result !== "FAIL");
  if (String(v.verdict ?? "").toUpperCase() === "PASS" && !allPass) return { refused: "verdict PASS, but a feature's row is FAIL" };
  return { verdict: allPass ? "PASS" : "FAIL", features: rows.filter((r) => ids.includes(r.id)) };
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

/** ADR 0028 §4: the inbox item key of a check's finding `n` (1-based, QA's numbering) in `round`. */
export const checkFindingKey = (job: string, round: number, n: number) => `kitchen:${job}:check:${round}.${n}`;

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
