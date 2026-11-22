// spec-lint (PLAN §2 "Spec format"): the engine's check of a verification
// contract, the spec's `## Criteria` or a low-risk ticket's inline criteria in
// intake.md. Pure. Rules:
//   1. every criterion has a `proof:` of kind toolkit, cmd or test (proof-line.ts)
//   2. every primitive it names is in `describe`; every feature drive (a dotted
//      name) is in the Toolkit's feature files, with the args that drive takes, or
//      is a new feature drive for this job, declared under `## New drives` (the
//      verifier writes it in the drives stage). A missing primitive is a Toolkit
//      gap (→ toolkit stage)
//   3. `expect: judged` only for a criterion about layout, appearance, visual
//      style, tone or copy quality, and its proof takes a screenshot; every other
//      expect is mechanical and must parse (assert.ts). A negative expect (`not
//      visible`, `not contains`, `!=`) holds whenever the thing never existed, so
//      it must be backed (negativeBacking): (a) created: an earlier step of the
//      same proof makes what must not show (its text is an arg of that step);
//      (b) a value read: `$v != "…"` / `json … != …` on a value a step of this
//      proof reads and keeps (`--save v`, or the last output); the runtime
//      refuses an unsaved, empty, missing or failed subject (assert.ts), so it
//      holds only on a real value that differs; (c) shown on the base: anything else
//      is left to the base check (`baseNegatives`): the clause must be FALSE on
//      the base, the thing is there before the change (base-check.ts
//      baseNegativeProblems). A repro criterion's expect must be able to be false
//      with every step run (not `ok` alone, no `read --equals` step), and an arg
//      that looks like JSON (`[…]`, `{…}`) must parse
//   9. a seed user a proof names (`--as`, `--user`, `--admin`, `username = '…'`)
//      is in describe's `seed_users`, or an earlier step of the proof makes it
//   4. nothing touches a protected path (kitchen.yaml `protected`, the Toolkit's
//      primitives): no `test` file, `cmd` word or criterion text names one; a
//      `cmd` stays in the worktree (no absolute or `..` path, `~`, `$HOME`, env
//      dump or network tool)
//   5. a bug has a `repro: true` criterion with a mechanical expect; only a bug has one
//   6. ids are unique
//   7. the spec matches the ticket, structurally (ADR 0003: no agent checks the
//      spec): intake.md lists the ticket's requirements (`## Requirements`, R1…Rn,
//      each a quote or faithful paraphrase, negative and unchanged ones marked);
//      every criterion `covers:` at least one R, every R in scope is covered by a
//      criterion, a negative R ("no owner shown for regular users": something must
//      not appear) by at least one criterion whose mechanical expect asserts an
//      absence, and an unchanged R (a regression guard: "`list` output stays the
//      same") by a mechanical criterion, positive or negative: the old behaviour
//      still produces the same output or exit
//   8. a `test` proof's file is where the repo's tests live (the test runner's own
//      globs, checks/test-layout.ts), when the layout is known
import path from "node:path";
import { absentString, type Clause, ExpectError, isJudged, negativeClauses, parseExpect } from "../proof/assert.ts";
import { checkPrimArgs, DriveFormatError } from "../proof/drive-format.ts";
import { ProofLineError, parseProof, type Segment, words } from "../proof/proof-line.ts";
import { inLayout, type TestLayout } from "./test-layout.ts";

export type Criterion = { id: string; text: string; proof: string | null; expect: string | null; repro: boolean; covers: string[] };
/**
 * One requirement intake read in the ticket. `negative`: it says something must not appear or happen (needs an
 * absence assertion); `unchanged`: a regression guard, existing behaviour stays as it is (a positive "still the
 * same" criterion proves it); `outOfScope`: intake rescoped it away (with a note).
 */
export type Requirement = { id: string; text: string; negative: boolean; unchanged?: boolean; outOfScope: boolean };
/** A negative clause no earlier step backs: the base check must show it is FALSE there (the thing exists before the change). */
export type BaseNegative = { criterion: string; clause: string };
export type LintResult = {
  ok: boolean;
  /** Every problem found, one per line (a refused role fixes them all in one retry). */
  reason?: string;
  missingPrimitive?: string;
  criteria: Criterion[];
  newDrives: string[];
  /** Rule 3 (c): negatives left to the base check (base-check.ts baseNegativeProblems). */
  baseNegatives: BaseNegative[];
};
/**
 * What the Toolkit offers: primitive names, every feature drive's name → its args, the drives that take a
 * screenshot, and describe's `seed_users` (rule 9 runs when it is non-empty).
 */
export type ToolkitView = { primitives: string[]; drives: Record<string, string[]>; screenshots?: string[]; seedUsers?: string[] };

/** Criteria lines: `- [C1] text` followed by indented `proof:`, `expect:`, `repro:` lines. */
export function parseCriteria(md: string): Criterion[] {
  const out: Criterion[] = [];
  let cur: Criterion | null = null;
  for (const line of md.split("\n")) {
    const c = /^\s*[-*]\s*\[(C\d+)\]\s*(.*)$/.exec(line);
    if (c) {
      cur = { id: c[1], text: c[2].trim(), proof: null, expect: null, repro: false, covers: [] };
      out.push(cur);
      continue;
    }
    const kv = /^\s+(proof|expect|repro|covers):\s*(.*?)\s*$/.exec(line);
    if (cur && kv) {
      // A trailing `# comment` after the value is not part of it (outside quotes).
      const v = kv[1] === "expect" || kv[1] === "covers" ? stripTrailingComment(kv[2]) : kv[2];
      if (kv[1] === "proof") cur.proof = v;
      else if (kv[1] === "expect") cur.expect = v;
      else if (kv[1] === "covers") cur.covers = [...new Set(v.toUpperCase().match(/\bR\d+\b/g) ?? [])];
      else cur.repro = v === "true";
    } else if (/^\S/.test(line)) cur = null;
  }
  return out;
}

function stripTrailingComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim();
  }
  return s.trim();
}

/**
 * intake.md's `## Requirements`: `- R1: …`, a negative one `- R3 (negative): …`, a regression
 * guard `- R4 (unchanged): …`, one intake rescoped away `- R5 (out of scope): … — why`. Any other
 * line in the section is a note. Marked both negative and unchanged, it is negative (the stricter).
 */
export function parseRequirements(md: string): Requirement[] {
  const out: Requirement[] = [];
  let inSection = false;
  for (const line of md.split("\n")) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      inSection = /^requirements\b/i.test(h[1].trim());
      continue;
    }
    const m = inSection ? /^\s*[-*]\s*\[?(R\d+)\]?\s*((?:\([^)]*\)\s*)*)[:.\u2013\u2014-]\s*(.*)$/i.exec(line) : null;
    if (!m || out.some((r) => r.id === m[1].toUpperCase())) continue;
    const marks = m[2].toLowerCase();
    const negative = /\b(negative|must not|not)\b/.test(marks);
    out.push({
      id: m[1].toUpperCase(),
      text: m[3].trim(),
      negative,
      unchanged: !negative && /\b(unchanged|regression guard|guard|stays)\b/.test(marks),
      outOfScope: /out of scope|rescoped|dropped/.test(marks),
    });
  }
  return out;
}

/**
 * The requirements a spec is held to: intake's, except that the spec may re-mark a `(negative)` one as
 * `(unchanged)` in its own `## Requirements` (`- R4 (unchanged): the settings page stays as it is, why`),
 * when what intake read as "must not show" is a boundary the change leaves alone (nothing shows it today,
 * nothing must show it after). Nothing else intake wrote can change (no dropping, no out of scope). The
 * re-mark is kept in the text, for the review and the report. Pure.
 */
export function withSpecMarks(intake: Requirement[], specMd: string): Requirement[] {
  const spec = parseRequirements(specMd);
  return intake.map((r) => {
    const s = spec.find((x) => x.id === r.id);
    return r.negative && !r.outOfScope && s?.unchanged
      ? { ...r, negative: false, unchanged: true, text: `${r.text} (re-marked (unchanged) by the spec: ${s.text})` }
      : r;
  });
}

/** `## New drives` list items: `- settings.display-name: what it does`, name → description. */
export function newDriveLines(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inSection = false;
  for (const line of md.split("\n")) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      inSection = /^new (feature )?drives\b/i.test(h[1].trim());
      continue;
    }
    const m = inSection ? /^\s*[-*]\s*`?([a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+)`?(.*)$/.exec(line) : null;
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}
/** `## New drives` names. */
export const newDrivesOf = (md: string): string[] => Object.keys(newDriveLines(md));

/** Primitive names a proof line calls (toolkit segments without a dot). */
export function toolkitNames(proof: string): string[] {
  try {
    return parseProof(proof).flatMap((s) => (s.kind === "toolkit" ? [s.name] : []));
  } catch {
    return [];
  }
}

/**
 * What only an agent can judge: layout, appearance, visual style, tone, copy quality.
 * Not whether a message, label or value is there, or how wide something is: those are
 * mechanical (`text "…" visible`, `$var == …`).
 */
const VISUAL_OR_WORDING =
  /\b(look|looks|looking|visual|visually|layout|laid out|appearance|appear|styl(e|ed|ing)|colou?rs?|contrast|align(ed|ment)?|spacing|font|typograph\w*|legib\w*|readab\w*|overlap\w*|truncat\w*|tone|copy|wording|worded|phrasing|phrased|well[- ]written|clear(ly)? written|polish\w*)\b/i;
export const isVisualOrWording = (text: string) => VISUAL_OR_WORDING.test(text);

/** Network tools and environment dumps a `cmd` proof may not run (it runs in the worktree, untrusted env, no network). */
const CMD_TOOLS = /^(curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|rsync|ftp|env|printenv)$/;
/** Why a `cmd` proof (or a `test` file) reaches outside the worktree, or null. */
export function cmdProblem(cmd: string): string | null {
  if (/\$\{?HOME\b|\$\{?USER\b|\$\{?PATH\b|(^|[\s=:"'<>|;&(])~/.test(cmd)) return "it refers to the home folder or the environment ($HOME, ~)";
  let ws: string[];
  try {
    ws = words(cmd.replace(/[<>|&;()`]/g, " "));
  } catch {
    return "it has an unclosed quote";
  }
  for (const w of ws) {
    const base = w.split("/").at(-1) ?? w;
    if (CMD_TOOLS.test(w) || CMD_TOOLS.test(base)) return `it runs ${w} (no network tools or environment dumps in a proof)`;
    if (/(^|=)\//.test(w) && !/^(\/dev\/null|\/dev\/stdout|\/dev\/stderr)$/.test(w)) return `it names ${w}, a path outside the worktree`;
    if (w.split(/[/=]/).includes("..")) return `it names ${w}, a path outside the worktree`;
  }
  return null;
}

/** Does the proof chain take a screenshot (a screenshot step, a drive that takes one, or a new drive described as taking one)? */
function takesScreenshot(segs: Segment[], view: ToolkitView, newDrives: Record<string, string>): boolean {
  return segs.some(
    (s) =>
      s.kind === "toolkit" &&
      (s.name === "screenshot" || (s.drive && ((view.screenshots ?? []).includes(s.name) || /screenshot/i.test(newDrives[s.name] ?? "")))),
  );
}

/** `$x == ""` / `json … == ""`: an empty read holds whenever the element is missing, so the lint treats it as a negative. */
const emptyEquals = (clauses: Clause[]) => clauses.filter((c) => (c.kind === "json" || c.kind === "var") && c.op === "==" && c.value === "");
/** The clauses of an expect that assert an absence (the lint's view: negatives plus equality to empty). */
export const absenceClauses = (expect: string): Clause[] => {
  const cs = parseExpect(expect);
  return [...negativeClauses(cs), ...emptyEquals(cs)];
};
/** A step that makes something: a feature drive, or an `http` call that writes. */
const makes = (s: Segment) => s.kind === "toolkit" && (s.drive || (s.name === "http" && /^(POST|PUT|PATCH|DELETE)$/i.test(s.args.method ?? "")));

/**
 * Rule 3: how each negative clause of a toolkit proof is backed. A negative holds whenever its thing never
 * existed, so it counts only when
 *  (a) created: what must not show is an arg value of an earlier segment
 *      (`projects.create --user bob-admin --name "Bob plan" ; … ; open --path /projects`), or names one (a word
 *      of 5+ letters of such an arg: `cli --argv "add Zebra" ; … ` then `not contains "[x] 7 Zebra"`);
 *  (b) a value read: `$v != "…"` / `$v not contains "…"` / `json … != …` on a value a step of this proof
 *      reads and keeps (a primitive's `--save v`, or the last output): at run time assert.ts fails such a
 *      clause when the value wasn't saved, is empty, is missing at its path or is a failed response, so it
 *      can only hold on a real value that differs (`$amt != "8910"`, `$b not contains "true"` read by `sql`);
 *  (c) shown on the base: anything else goes to the base check, where it must be FALSE (base-check.ts).
 * Equality to empty (`$o == ""`) names nothing that must not show: it needs an earlier making step, else it
 * is refused (`refuse`). Pure.
 */
export function negativeBacking(expect: string, segs: Segment[]): { refuse?: string; base: string[] } {
  const clauses = parseExpect(expect);
  for (const c of emptyEquals(clauses)) if (!segs.slice(0, -1).some(makes)) return { refuse: c.src, base: [] };
  const base: string[] = [];
  const earlier = segs
    .slice(0, -1)
    .flatMap((s) => (s.kind === "toolkit" ? Object.values(s.args) : []))
    .map((v) => v.toLowerCase());
  // Words of what earlier steps that write (a drive, a writing `http`, a `cli` command) were given, not where they went.
  const madeWords = segs
    .slice(0, -1)
    .flatMap((s) => (s.kind === "toolkit" && (makes(s) || s.name === "cli") ? Object.entries(s.args) : []))
    .filter(([k]) => !/^(path|target|method|as|expect_status|expect_exit)$/.test(k))
    .flatMap(([, v]) => v.toLowerCase().split(/[^\p{L}\p{N}_-]+/u))
    .filter((w) => w.length >= 5);
  const saved = new Map<string, number>();
  segs.forEach((s, i) => {
    if (s.kind === "toolkit" && s.save) saved.set(s.save, i);
  });
  for (const c of negativeClauses(clauses)) {
    const x = absentString(c)?.toLowerCase();
    if (x && earlier.some((v) => v === x || (Math.min(v.length, x.length) >= 3 && (v.includes(x) || x.includes(v))))) continue; // (a)
    // (a) the absent text names a thing an earlier step made: a word of 5+ letters of its args (`cli --argv "add Zebra"` … `not contains "[x] 7 Zebra"`).
    if (x && madeWords.some((w) => x.includes(w))) continue;
    if ((c.kind === "var" || c.kind === "json") && c.value !== null && String(c.value) !== "") {
      const subject = c.kind === "var" ? c.name : c.subject;
      if (subject === null || saved.has(subject)) continue; // (b) a value read and kept by a step of this proof
    }
    base.push(c.src); // (c)
  }
  return { base };
}

/** Paths a proof names: the `test` file, path-like words of a `cmd`. */
function pathsOf(segs: Segment[]): string[] {
  return segs.flatMap((s) =>
    s.kind === "test" ? [s.file] : s.kind === "cmd" ? words(s.cmd.replace(/[<>|&;]/g, " ")).filter((w) => /[/.]/.test(w) && !/^-/.test(w)) : [],
  );
}
const norm = (p: string) => path.posix.normalize(p.replace(/^\.\//, ""));
/** Toolkit primitives are protected by the layer rules (only the smith changes them); feature drives are not. */
export const TOOLKIT_PRIMITIVE_PATHS = [".kitchen/toolkit/bin/**", ".kitchen/toolkit/lib/**", ".kitchen/toolkit/*.json", ".kitchen/toolkit/SKILL.md"];
export function isProtected(p: string, globs: string[]): boolean {
  const n = norm(p);
  return [...globs, ...TOOLKIT_PRIMITIVE_PATHS].some((g) => path.posix.matchesGlob(n, g) || n === norm(g));
}

/**
 * Rule 7: why the criteria don't match intake's requirements, one line per problem ([] when they do). Every
 * criterion covers an R intake listed; every R in scope is covered; a negative R by at least one criterion
 * asserting an absence; an unchanged R (regression guard) by at least one mechanical criterion, positive or
 * negative.
 */
export function coverageProblems(criteria: Criterion[], reqs: Requirement[]): string[] {
  if (!reqs.length) return ["intake.md lists no requirements (`## Requirements`, `- R1: …`): nothing to check the criteria against"];
  const out: string[] = [];
  const ids = new Set(reqs.map((r) => r.id));
  for (const c of criteria) {
    if (!c.covers.length) out.push(`${c.id} covers no requirement: add a \`covers: R…\` line naming the requirement(s) of intake.md it proves`);
    const unknown = c.covers.find((r) => !ids.has(r));
    if (unknown) out.push(`${c.id} covers ${unknown}, which intake.md does not list (${[...ids].join(", ")})`);
  }
  for (const r of reqs.filter((x) => !x.outOfScope)) {
    const by = criteria.filter((c) => c.covers.includes(r.id));
    if (!by.length) {
      out.push(`${r.id} ("${r.text}") is covered by no criterion: every requirement of the ticket needs one`);
      continue;
    }
    if (r.unchanged) {
      if (!by.some((c) => !!c.expect && !isJudged(c.expect)))
        out.push(
          `${r.id} guards existing behaviour ("${r.text}"): a criterion covering it must show, mechanically, that the old behaviour still gives the same output or exit (\`contains "…"\`, \`exit 0\`, \`$x == …\`)`,
        );
      continue;
    }
    if (!r.negative) continue;
    const asserts = by.some((c) => {
      try {
        return !!c.expect && !isJudged(c.expect) && absenceClauses(c.expect).length > 0;
      } catch {
        return false;
      }
    });
    if (!asserts)
      out.push(
        `${r.id} says what must not happen ("${r.text}"), but no criterion covering it asserts an absence (\`text "…" not visible\`, \`not contains "…"\`, \`$x != …\`), backed: what must not show is made by an earlier step of the same proof (its text an arg), or is a value a step reads and saves (\`read --target amount --save amt\` then \`$amt != "8910"\`), or shows on the current code (the engine runs that proof on the base, every step must run there, and the clause must be false there). If it means existing behaviour stays as it is (nothing else changes, a case the change must leave alone), mark it \`(unchanged)\` instead and prove it positively (the same output or exit, \`$x == …\`)`,
      );
  }
  return out;
}
/** Rule 7's first problem, or null. */
export const coverageProblem = (criteria: Criterion[], reqs: Requirement[]): string | null => coverageProblems(criteria, reqs)[0] ?? null;

/**
 * Regression guards: criteria that cover only `(unchanged)` requirements. They hold on the base by
 * design (the old behaviour stays), so the base check doesn't count them as non-discriminating. Pure.
 */
export function guardCriteria(criteria: Criterion[], reqs: Requirement[]): string[] {
  const guard = new Set(reqs.filter((r) => r.unchanged && !r.outOfScope).map((r) => r.id));
  return criteria.filter((c) => c.covers.length > 0 && c.covers.every((r) => guard.has(r))).map((c) => c.id);
}

export function lintSpec(
  md: string,
  o: {
    kind: string | null;
    toolkit: ToolkitView;
    protected?: string[];
    /** intake.md's requirements: rule 7 runs when given. */
    requirements?: Requirement[];
    /** The repo's test layout (checks/test-layout.ts): rule 8 runs when given. */
    testLayout?: TestLayout | null;
  },
): LintResult {
  const criteria = parseCriteria(md);
  const newDriveText = newDriveLines(md);
  const newDrives = Object.keys(newDriveText);
  const baseNegatives: BaseNegative[] = [];
  const fail = (reason: string, extra: Partial<LintResult> = {}): LintResult => ({ ok: false, reason, criteria, newDrives, baseNegatives, ...extra });
  if (!criteria.length) return fail("no criteria (`- [C1] …` with a `proof:` line)");
  // 6. unique ids
  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.id)) return fail(`duplicate id ${c.id}`);
    seen.add(c.id);
  }
  // Every problem is collected (the first per criterion), so one retry of the role can fix them all.
  const problems: string[] = [];
  let missingPrimitive: string | undefined;
  const parsed = new Map<string, Segment[]>();
  const check = (c: Criterion): string | null => {
    // 1. proof kind
    if (!c.proof) return `${c.id} has no proof`;
    try {
      parsed.set(c.id, parseProof(c.proof));
    } catch (e) {
      if (e instanceof ProofLineError) return `${c.id}: ${e.message}`;
      throw e;
    }
    // 3. judged only for visual/wording, with a screenshot; mechanical expects must parse; negatives are backed
    const segs = parsed.get(c.id) ?? [];
    const kindOf = segs[0]?.kind;
    if (isJudged(c.expect)) {
      if (kindOf !== "toolkit") return `${c.id}: a judged criterion needs a toolkit proof (evidence to look at)`;
      if (!isVisualOrWording(c.text))
        return `${c.id}: expect: judged is only for layout, appearance, visual style, tone or copy quality; make it mechanical (text "…" visible, $var == …)`;
      if (!takesScreenshot(segs, o.toolkit, newDriveText))
        return `${c.id}: a judged criterion's proof must take a screenshot (a \`screenshot\` step, or a drive that takes one) for the verifier to look at`;
    } else if (c.expect) {
      try {
        parseExpect(c.expect);
        if (kindOf === "toolkit") {
          const b = negativeBacking(c.expect, segs);
          if (b.refuse)
            return `${c.id}: \`${b.refuse}\` holds whenever the thing never existed (an empty read); an earlier step of the same proof must make what it reads (a feature drive, a writing \`http\`)`;
          for (const clause of b.base) baseNegatives.push({ criterion: c.id, clause });
        }
      } catch (e) {
        if (e instanceof ExpectError) return `${c.id}: expect ${e.message}`;
        throw e;
      }
    } else if (kindOf === "toolkit") return `${c.id}: a toolkit proof needs an expect: line (ok, text … visible, $var == …, judged …)`;
    // 4b. a cmd or test proof stays in the worktree
    for (const s of segs) {
      const why = s.kind === "cmd" ? cmdProblem(s.cmd) : s.kind === "test" ? cmdProblem(s.file) : null;
      if (why) return `${c.id}: the ${s.kind} proof is refused: ${why}`;
      // 8. a test file sits where the repo's runner finds its tests
      if (s.kind === "test" && o.testLayout && !inLayout(s.file, o.testLayout))
        return `${c.id}: the test file ${s.file} is outside the repo's test layout (${o.testLayout.runner}: ${o.testLayout.globs.join(", ")}, from ${o.testLayout.source}); put it where the repo's tests live (the builder may not change the runner's config to reach it)`;
    }
    if (c.repro && o.kind !== "bug") return `${c.id}: \`repro: true\` is only for a bug (this ticket is a ${o.kind ?? "ticket of no kind"})`;
    // 5. a repro must be able to fail as expected: every step runs on the buggy base and the expect is false there
    if (c.repro && c.expect && !isJudged(c.expect)) {
      const why = reproProblem(c.expect, segs);
      if (why) return `${c.id}: ${why}`;
    }
    // 2. names resolve
    for (const s of segs) {
      if (s.kind !== "toolkit") continue;
      const bad = jsonArgProblem(s);
      if (bad) return `${c.id}: ${bad}`;
      if (!s.drive) {
        if (!o.toolkit.primitives.includes(s.name)) {
          missingPrimitive ??= s.name;
          return `${c.id} needs primitive ${s.name}, which the Toolkit lacks`;
        }
        try {
          checkPrimArgs(s.name, s.args);
        } catch (e) {
          if (e instanceof DriveFormatError) return `${c.id}: ${e.message}`;
          throw e;
        }
        continue;
      }
      const have = o.toolkit.drives[s.name];
      if (!have) {
        if (!newDrives.includes(s.name)) return `${c.id}: no feature drive ${s.name}; a new one must be listed under "## New drives"`;
        continue;
      }
      const given = Object.keys(s.args).sort();
      const want = [...have].sort();
      if (given.join() !== want.join())
        return `${c.id}: ${s.name} takes ${want.map((a) => `--${a}`).join(" ") || "no args"}, got ${given.map((a) => `--${a}`).join(" ") || "none"}`;
    }
    // 9. seed users exist
    const ghost = unknownUser(segs, o.toolkit.seedUsers ?? []);
    if (ghost)
      return `${c.id}: the proof uses the user ${JSON.stringify(ghost)}, who is not a seed user (${(o.toolkit.seedUsers ?? []).join(", ")}) and no earlier step makes; use a seed user, or create that user in an earlier step`;
    // 4. protected paths
    const hit = pathsOf(segs).find((p) => isProtected(p, o.protected ?? []));
    if (hit) return `${c.id}: the proof touches protected path ${hit}`;
    const named = (c.text.match(/[\w./-]+\.[\w]+|\.kitchen\/[\w./-]+/g) ?? []).find((p) => isProtected(p, o.protected ?? []));
    if (named) return `${c.id}: the criterion touches protected path ${named}`;
    return null;
  };
  for (const c of criteria) {
    const why = check(c);
    if (why) problems.push(why);
  }
  // 7. the criteria match the ticket's requirements
  if (o.requirements) problems.push(...coverageProblems(criteria, o.requirements));
  // 5. a bug has a mechanical repro criterion
  if (o.kind === "bug" && !criteria.some((c) => c.repro && c.expect !== null && !isJudged(c.expect)))
    problems.push("a bug needs a `repro: true` criterion with a mechanical expect");
  if (problems.length) return fail(problems.join("\n"), missingPrimitive ? { missingPrimitive } : {});
  return { ok: true, criteria, newDrives, baseNegatives };
}

/**
 * Rule 5: why a repro criterion can never "fail as expected" on the buggy base (repro.ts counts only a false
 * expect after every step ran, or a timed-out wait for what the expect asks), or null. `ok` alone is false only
 * when a step fails; a `read --equals` step fails the step instead of the expect. Pure.
 */
export function reproProblem(expect: string, segs: Segment[]): string | null {
  const clauses = parseExpect(expect);
  if (clauses.every((c) => c.kind === "ok"))
    return "a repro's `expect: ok` can never fail as expected (ok is false only when a step fails, which is a broken proof, not a reproduction): save what the bug gets wrong (`--save x`) and assert the right value (`$x == …`, `json .status == 201`)";
  const eq = segs.find((s) => s.kind === "toolkit" && !s.drive && s.name === "read" && s.args.equals !== undefined);
  if (eq)
    return "a repro's `read --equals` fails the step on the buggy base, before the expect is read: `read --target … --save x`, then assert it in the expect (`$x == …`)";
  // Pinning the bug's own outcome on a step (`--expect_status 400`, `--expect_exit 1`) makes the step pass on the base
  // and fail once the bug is fixed: the repro then can never pass (d-qty-100).
  const pin = segs.find(
    (s) => s.kind === "toolkit" && ((Number(s.args.expect_status) >= 400 && !s.drive) || (s.args.expect_exit !== undefined && s.args.expect_exit !== "0")),
  );
  if (pin)
    return 'a repro pins an error outcome on a step (`--expect_status 4xx/5xx` or `--expect_exit` other than 0): that step passes on the buggy base and fails once the bug is fixed. Don\'t pin it: save it (`toolkit read --target status --save code`) and assert the right value in the expect (`$code == "201"`, `exit 0`)';
  return null;
}

/** Args a primitive reads as JSON when they look like it (the cli's `argv` list, an `http` `body`). */
const JSON_ARGS = new Set(["argv", "body"]);
/** A JSON arg that looks like a list or object but doesn't parse (`--argv ["add","x"]` lost its quotes as shell words do), or null. Pure. */
export function jsonArgProblem(s: Extract<Segment, { kind: "toolkit" }>): string | null {
  for (const [k, v] of Object.entries(s.args)) {
    const t = v.trim();
    if (!JSON_ARGS.has(k) || t.includes("$")) continue;
    if (!/^\[.*\]$|^\{.*\}$/s.test(t)) continue;
    try {
      JSON.parse(t);
    } catch {
      return `${s.name} --${k} ${t.length > 60 ? `${t.slice(0, 60)}…` : t} is not valid JSON (the proof line reads quotes as a shell does, so the inner "…" were dropped): put the JSON in '…' (--${k} '["add","Buy milk"]'), or give a list arg as one shell line (--${k} "add 'Buy milk'")`;
    }
  }
  return null;
}

/** Args that name an existing user; SQL that picks one by name. */
const USER_ARGS = new Set(["as", "user", "admin"]);
const SQL_USER = /\busername\s*=\s*'([^']+)'/gi;
/**
 * Rule 9: a user a proof names (a primitive's `--as`, `--user` or `--admin`; `username = '…'` in a query or cmd; a feature drive's args may make one) that isn't a
 * seed user and isn't an arg value of an earlier segment (made there), or null. Only when describe lists seed users. Pure.
 */
export function unknownUser(segs: Segment[], seedUsers: string[]): string | null {
  if (!seedUsers.length) return null;
  const known = new Set(seedUsers);
  const made = new Set<string>();
  for (const s of segs) {
    const named: string[] = [];
    if (s.kind === "toolkit") {
      for (const [k, v] of Object.entries(s.args)) {
        if (!s.drive && USER_ARGS.has(k) && !v.includes("$")) named.push(v);
        for (const m of v.matchAll(SQL_USER)) named.push(m[1]);
      }
    } else if (s.kind === "cmd") for (const m of s.cmd.matchAll(SQL_USER)) named.push(m[1]);
    const ghost = named.find((u) => !known.has(u) && !made.has(u));
    if (ghost) return ghost;
    if (s.kind === "toolkit") for (const v of Object.values(s.args)) made.add(v);
  }
  return null;
}
