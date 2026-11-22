// The retro's decisions (PLAN §7 W5), pure: what to mute and which lessons to propose,
// from the ledger, the review findings and the retro's own state. retro.ts does the I/O.
//
// Mutes. A (lens, category) pair is muted once a person dismissed `mute_after` of
// its findings (`kitchen dismiss`, or a "not useful" reply on the PR read through the
// forge). A muted category's findings never block again; they stay in the Report as
// notes. `other`, the lenses and categories in `never_mute` (security) and any finding
// the security veto covers (categories.ts: a security term in it, any lens) are never muted.
// `kitchen retro unmute` lifts one; it is muted again only after `mute_after` new
// dismissals.
//
// Lessons. A signal is something that went wrong the same way in at least two jobs:
// a Toolkit gap on the same primitive, a drive that is flaky or INCONCLUSIVE, the
// same escalation reason, findings of one category that kept blocking. Each signal is
// proposed at most once, ever (its id is kept in `filed`).
import type { LedgerLine } from "../ledger/append.ts";
import type { Measures } from "../ledger/measures.ts";
import { type Category, categoryOf, securityVeto } from "./categories.ts";

export type Dismissal = {
  job: string;
  finding: string;
  lens: string;
  category: Category;
  title: string;
  source: string;
  /** The security veto covers it (categories.ts): it never counts toward a mute. */
  vetoed?: string | null;
};
export type Mute = { lens: string; category: Category; at: string; dismissals: number; findings: string[] };
export type Unmuted = { lens: string; category: Category; at: string; dismissals: number };
export type Filed = { signal: string; ref: string; title: string; kind: LessonKind; at: string };
export type RetroState = { finished: number; runs: number; mutes: Mute[]; unmuted: Unmuted[]; filed: Filed[] };
export const emptyState = (): RetroState => ({ finished: 0, runs: 0, mutes: [], unmuted: [], filed: [] });

/** In the order the retro prefers them: a lint rule over a check over a Toolkit fix, an AGENTS.md note last. */
export const LESSON_KINDS = ["lint-rule", "check", "toolkit-fix", "agents-md"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

export type Signal = { id: string; hint: LessonKind; what: string; count: number; jobs: string[]; facts: string[] };
export type Lesson = { signal: string; kind: LessonKind; title: string; body: string };

/** Moves into a finished stage: what `retro.every_jobs` counts. */
export const finishedCount = (lines: LedgerLine[]) =>
  lines.filter((l) => l.event === "move" && ["done", "rejected", "needs-human"].includes(String(l.result))).length;

/** Every dismissal in the ledger (`finding-dismissed`, from the CLI or the forge), once per finding. */
export function dismissalsOf(lines: LedgerLine[]): Dismissal[] {
  const seen = new Set<string>();
  const out: Dismissal[] = [];
  for (const l of lines.filter((x) => x.event === "finding-dismissed")) {
    const d = l.detail ?? {};
    const finding = String(d.finding ?? "");
    const k = `${l.job}/${finding}`;
    if (!finding || seen.has(k)) continue;
    seen.add(k);
    const title = String(d.title ?? "");
    const why = String(d.why ?? "");
    const declared = d.category === undefined ? undefined : String(d.category);
    out.push({
      job: l.job,
      finding,
      lens: String(d.lens ?? l.role?.replace(/^reviewer-/, "") ?? "?"),
      category: categoryOf(title, why, declared),
      title,
      source: String(d.source ?? "cli"),
      vetoed: securityVeto({ title, why, category: declared }),
    });
  }
  return out;
}

/** New mutes: (lens, category) pairs with `muteAfter` dismissals (since an unmute), not muted yet. */
export function muteDecisions(ds: Dismissal[], st: RetroState, o: { muteAfter: number; neverMute: string[]; now: string }): Mute[] {
  const groups = new Map<string, Dismissal[]>();
  for (const d of ds) {
    if (d.category === "other" || d.vetoed || o.neverMute.includes(d.lens) || o.neverMute.includes(d.category)) continue;
    const k = `${d.lens}/${d.category}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const out: Mute[] = [];
  for (const [, g] of [...groups].sort()) {
    const { lens, category } = g[0];
    if (st.mutes.some((m) => m.lens === lens && m.category === category)) continue;
    const lifted = st.unmuted.filter((u) => u.lens === lens && u.category === category).at(-1);
    const since = g.length - (lifted?.dismissals ?? 0);
    if (since >= o.muteAfter) out.push({ lens, category, at: o.now, dismissals: g.length, findings: g.map((d) => `${d.job}/${d.finding}`) });
  }
  return out;
}

export type Dismissed = { id: string; reason: string | null };

const TRIGGER = /not useful|^\s*(👎|:-1:|:thumbsdown:)/i;
const FINDING_ID = /\b([a-z][a-z0-9]*-\d+-\d+)\b/g;
const FILLER = /^(thanks?( you)?|thx|ty|cheers|ok(ay)?|lgtm)$/i;

/**
 * A trusted person's PR comment, read for dismissals. Pure. Only a finding id in the same sentence (of
 * a line) as a trigger ("not useful", or a sentence starting with 👎) is dismissed; ids elsewhere in the
 * comment are not. Its reason is what that sentence says after "because", "since", "reason:", or a colon
 * or dash after "not useful" (null when it gives none). `rest` is the comment without the dismissal
 * sentences: when it says anything, the comment is still feedback (`pure` is false).
 */
export function dismissalsIn(body: string): { dismissed: Dismissed[]; rest: string; pure: boolean } {
  const dismissed: Dismissed[] = [];
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const keep: string[] = [];
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const ids = TRIGGER.test(sentence) ? [...sentence.matchAll(FINDING_ID)].map((m) => m[1]) : [];
      if (!ids.length) {
        keep.push(sentence);
        continue;
      }
      const reason = reasonIn(sentence);
      for (const id of ids) if (!dismissed.some((d) => d.id === id)) dismissed.push({ id, reason });
    }
    kept.push(keep.join(" "));
  }
  const rest = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const words = rest
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { dismissed, rest, pure: dismissed.length > 0 && (!words || FILLER.test(words)) };
}

/** The ids a comment dismisses (see dismissalsIn). */
export const dismissedIn = (body: string): string[] => dismissalsIn(body).dismissed.map((d) => d.id);

/** An explicit reason in a dismissal sentence: after because/since/reason:, or a colon or dash after "not useful"; at least 3 words. */
function reasonIn(sentence: string): string | null {
  const m = /\b(?:because|since|reason:)\s*(.+)$/i.exec(sentence) ?? /not useful\s*(?:[:—–]|\s-\s)\s*(.+)$/i.exec(sentence);
  const r = m?.[1]
    ?.replace(FINDING_ID, "")
    .replace(/[\s.!;]+$/, "")
    .trim();
  return r && r.split(/\s+/).length >= 3 ? r : null;
}

/** The lesson signals, strongest first. `blocked`: findings that blocked (review.json); `gaps`: the primitive each Toolkit gap named. */
export function signalsOf(o: {
  m: Measures;
  blocked: { job: string; lens: string; id: string; title: string; why?: string; category?: string }[];
  dismissed: Dismissal[];
  gaps: { job: string; primitive: string }[];
  mutes: Mute[];
}): Signal[] {
  const out: Signal[] = [];
  const by = <T>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return m;
  };
  const jobsOf = (xs: { job: string }[]) => [...new Set(xs.map((x) => x.job))];
  for (const [p, g] of by(o.gaps, (x) => x.primitive)) {
    const jobs = jobsOf(g);
    if (jobs.length >= 2)
      out.push({
        id: `gap:${p}`,
        hint: "toolkit-fix",
        what: `${jobs.length} jobs needed the primitive \`${p}\``,
        count: jobs.length,
        jobs,
        facts: jobs.map((j) => `${j} needed ${p}`),
      });
  }
  for (const d of o.m.chains) {
    const flaky = d.groups ? d.flaky / d.groups : 0;
    if ((d.flaky >= 2 && flaky > 0.05) || d.inconclusive >= 2)
      out.push({
        id: `drive:${d.drive.replace(/ → /g, ">")}`,
        hint: "toolkit-fix",
        what: `the drive \`${d.drive}\` is unreliable: ${d.inconclusive} INCONCLUSIVE of ${d.runs} runs, flaky in ${d.flaky} of ${d.groups}`,
        count: d.flaky + d.inconclusive,
        jobs: [],
        facts: [`runs ${d.runs}, pass ${d.pass}, fail ${d.fail}, INCONCLUSIVE ${d.inconclusive}, flaky groups ${d.flaky}/${d.groups}`],
      });
  }
  for (const e of o.m.escalations.filter((x) => x.to === "needs-human" && x.n >= 2))
    out.push({
      id: `escalation:${e.code}`,
      hint: "check",
      what: `${e.n} jobs escalated to a human for \`${e.code}\``,
      count: e.n,
      jobs: [],
      facts: [e.example || e.code],
    });
  const dismissedIds = new Set(o.dismissed.map((d) => `${d.job}/${d.finding}`));
  // A dismissed finding is not a lesson: a person said it was not useful.
  const kept = o.blocked
    .filter((b) => !dismissedIds.has(`${b.job}/${b.id}`))
    .map((b) => ({ ...b, category: categoryOf(b.title, b.why ?? "", b.category) }))
    .filter((b) => b.category !== "other");
  for (const [k, g] of by(kept, (b) => `${b.lens}/${b.category}`)) {
    const jobs = jobsOf(g);
    if (jobs.length < 2 || o.mutes.some((m) => `${m.lens}/${m.category}` === k)) continue;
    out.push({
      id: `findings:${k}`,
      hint: g[0].category === "style" || g[0].category === "naming" || g[0].category === "types" ? "lint-rule" : "check",
      what: `${g.length} ${g[0].category} findings of the ${g[0].lens} lens blocked jobs (${jobs.length} jobs): a mechanical rule could catch them before review`,
      count: jobs.length,
      jobs,
      facts: g.slice(0, 5).map((b) => `${b.job}: ${b.title}`),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/** The signals not proposed before, strongest first, at most `max`. */
export function pickSignals(signals: Signal[], st: RetroState, max: number): Signal[] {
  return signals.filter((s) => !st.filed.some((f) => f.signal === s.id)).slice(0, Math.max(0, max));
}

/**
 * The retro role's file: one `### L<n>: <title>` block per lesson, with `- signal: <id>`, `- kind: <kind>`,
 * then the ticket body. Only signals it was given, each once, at most `max`, a known kind.
 */
export function parseLessons(text: string, allowed: string[], max: number): { lessons: Lesson[]; refused: string[] } {
  const lessons: Lesson[] = [];
  const refused: string[] = [];
  for (const block of text.split(/^###\s+(?=L\d+\b)/m).slice(1)) {
    const title = /^L\d+\s*[:.-]\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    const signal = /^\s*-\s*signal:\s*`?([^`\s]+)`?\s*$/m.exec(block)?.[1] ?? "";
    const kind = (/^\s*-\s*kind:\s*`?([a-z-]+)`?\s*$/m.exec(block)?.[1] ?? "") as LessonKind;
    const body = block
      .split("\n")
      .slice(1)
      .filter((l) => !/^\s*-\s*(signal|kind):/.test(l))
      .join("\n")
      .trim();
    if (!title || !allowed.includes(signal)) refused.push(`${title || "(untitled)"}: signal ${signal || "(none)"} is not one of this retro's`);
    else if (!LESSON_KINDS.includes(kind)) refused.push(`${title}: kind ${kind || "(none)"} is not ${LESSON_KINDS.join(", ")}`);
    else if (!body) refused.push(`${title}: no body`);
    else if (lessons.some((l) => l.signal === signal)) refused.push(`${title}: signal ${signal} already has a lesson`);
    else if (lessons.length >= max) refused.push(`${title}: over the limit of ${max}`);
    else lessons.push({ signal, kind, title: title.slice(0, 100), body });
  }
  return { lessons, refused };
}
