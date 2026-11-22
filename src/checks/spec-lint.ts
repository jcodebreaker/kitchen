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
//      visible`, `not contains`, `!=`) needs an earlier step of the same proof to
//      create what must not show (its text is an arg of that step): otherwise it
//      holds whatever the code does
//   4. nothing touches a protected path (kitchen.yaml `protected`, the Toolkit's
//      primitives): no `test` file, `cmd` word or criterion text names one; a
//      `cmd` stays in the worktree (no absolute or `..` path, `~`, `$HOME`, env
//      dump or network tool)
//   5. a bug has a `repro: true` criterion with a mechanical expect; only a bug has one
//   6. ids are unique
import path from "node:path";
import { absentString, ExpectError, isJudged, negativeClauses, parseExpect } from "../proof/assert.ts";
import { checkPrimArgs, DriveFormatError } from "../proof/drive-format.ts";
import { ProofLineError, parseProof, type Segment, words } from "../proof/proof-line.ts";

export type Criterion = { id: string; text: string; proof: string | null; expect: string | null; repro: boolean };
export type LintResult = { ok: boolean; reason?: string; missingPrimitive?: string; criteria: Criterion[]; newDrives: string[] };
/** What the Toolkit offers: primitive names, every feature drive's name → its args, and the drives that take a screenshot. */
export type ToolkitView = { primitives: string[]; drives: Record<string, string[]>; screenshots?: string[] };

/** Criteria lines: `- [C1] text` followed by indented `proof:`, `expect:`, `repro:` lines. */
export function parseCriteria(md: string): Criterion[] {
  const out: Criterion[] = [];
  let cur: Criterion | null = null;
  for (const line of md.split("\n")) {
    const c = /^\s*[-*]\s*\[(C\d+)\]\s*(.*)$/.exec(line);
    if (c) {
      cur = { id: c[1], text: c[2].trim(), proof: null, expect: null, repro: false };
      out.push(cur);
      continue;
    }
    const kv = /^\s+(proof|expect|repro):\s*(.*?)\s*$/.exec(line);
    if (cur && kv) {
      // A trailing `# comment` after the value is not part of it (outside quotes).
      const v = kv[1] === "expect" ? stripTrailingComment(kv[2]) : kv[2];
      if (kv[1] === "proof") cur.proof = v;
      else if (kv[1] === "expect") cur.expect = v;
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

/**
 * A negative clause holds when its thing never existed. So what must not show has to be
 * made by an earlier step of the same proof: its text is an arg value of a segment before
 * the last one (`projects.create --user bob-admin --name "Bob plan" ; … ; open --path /projects`).
 * Returns the clause that isn't backed, or null.
 */
function unbackedNegative(expect: string, segs: Segment[]): string | null {
  const neg = negativeClauses(parseExpect(expect));
  if (!neg.length) return null;
  const earlier = segs
    .slice(0, -1)
    .flatMap((s) => (s.kind === "toolkit" ? Object.values(s.args) : []))
    .map((v) => v.toLowerCase());
  for (const c of neg) {
    const x = absentString(c)?.toLowerCase();
    if (x === undefined || x === null) continue;
    if (!earlier.some((v) => v === x || (Math.min(v.length, x.length) >= 3 && (v.includes(x) || x.includes(v))))) return c.src;
  }
  return null;
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

export function lintSpec(md: string, o: { kind: string | null; toolkit: ToolkitView; protected?: string[] }): LintResult {
  const criteria = parseCriteria(md);
  const newDriveText = newDriveLines(md);
  const newDrives = Object.keys(newDriveText);
  const fail = (reason: string, extra: Partial<LintResult> = {}): LintResult => ({ ok: false, reason, criteria, newDrives, ...extra });
  if (!criteria.length) return fail("no criteria (`- [C1] …` with a `proof:` line)");
  // 6. unique ids
  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.id)) return fail(`duplicate id ${c.id}`);
    seen.add(c.id);
  }
  const parsed = new Map<string, Segment[]>();
  for (const c of criteria) {
    // 1. proof kind
    if (!c.proof) return fail(`${c.id} has no proof`);
    try {
      parsed.set(c.id, parseProof(c.proof));
    } catch (e) {
      if (e instanceof ProofLineError) return fail(`${c.id}: ${e.message}`);
      throw e;
    }
    // 3. judged only for visual/wording, with a screenshot; mechanical expects must parse; negatives need a creating step
    const segs = parsed.get(c.id) ?? [];
    const kindOf = segs[0]?.kind;
    if (isJudged(c.expect)) {
      if (kindOf !== "toolkit") return fail(`${c.id}: a judged criterion needs a toolkit proof (evidence to look at)`);
      if (!isVisualOrWording(c.text))
        return fail(
          `${c.id}: expect: judged is only for layout, appearance, visual style, tone or copy quality; make it mechanical (text "…" visible, $var == …)`,
        );
      if (!takesScreenshot(segs, o.toolkit, newDriveText))
        return fail(
          `${c.id}: a judged criterion's proof must take a screenshot (a \`screenshot\` step, or a drive that takes one) for the verifier to look at`,
        );
    } else if (c.expect) {
      try {
        parseExpect(c.expect);
        const bare = kindOf === "toolkit" ? unbackedNegative(c.expect, segs) : null;
        if (bare)
          return fail(
            `${c.id}: \`${bare}\` holds whenever the thing never existed; an earlier step of the same proof must create it, with that text as an arg (e.g. \`toolkit <feature>.create --user <other user> --name "<text>" ; … ; open --path /list\`)`,
          );
      } catch (e) {
        if (e instanceof ExpectError) return fail(`${c.id}: expect ${e.message}`);
        throw e;
      }
    } else if (kindOf === "toolkit") return fail(`${c.id}: a toolkit proof needs an expect: line (ok, text … visible, $var == …, judged …)`);
    // 4b. a cmd or test proof stays in the worktree
    for (const s of segs) {
      const why = s.kind === "cmd" ? cmdProblem(s.cmd) : s.kind === "test" ? cmdProblem(s.file) : null;
      if (why) return fail(`${c.id}: the ${s.kind} proof is refused: ${why}`);
    }
    if (c.repro && o.kind !== "bug") return fail(`${c.id}: \`repro: true\` is only for a bug (this ticket is a ${o.kind ?? "ticket of no kind"})`);
  }
  // 2. names resolve
  for (const c of criteria) {
    for (const s of parsed.get(c.id) ?? []) {
      if (s.kind !== "toolkit") continue;
      if (!s.drive) {
        if (!o.toolkit.primitives.includes(s.name)) return fail(`${c.id} needs primitive ${s.name}, which the Toolkit lacks`, { missingPrimitive: s.name });
        try {
          checkPrimArgs(s.name, s.args);
        } catch (e) {
          if (e instanceof DriveFormatError) return fail(`${c.id}: ${e.message}`);
          throw e;
        }
        continue;
      }
      const have = o.toolkit.drives[s.name];
      if (!have) {
        if (!newDrives.includes(s.name)) return fail(`${c.id}: no feature drive ${s.name}; a new one must be listed under "## New drives"`);
        continue;
      }
      const given = Object.keys(s.args).sort();
      const want = [...have].sort();
      if (given.join() !== want.join())
        return fail(`${c.id}: ${s.name} takes ${want.map((a) => `--${a}`).join(" ") || "no args"}, got ${given.map((a) => `--${a}`).join(" ") || "none"}`);
    }
  }
  // 4. protected paths
  for (const c of criteria) {
    const hit = pathsOf(parsed.get(c.id) ?? []).find((p) => isProtected(p, o.protected ?? []));
    if (hit) return fail(`${c.id}: the proof touches protected path ${hit}`);
    const named = (c.text.match(/[\w./-]+\.[\w]+|\.kitchen\/[\w./-]+/g) ?? []).find((p) => isProtected(p, o.protected ?? []));
    if (named) return fail(`${c.id}: the criterion touches protected path ${named}`);
  }
  // 5. a bug has a mechanical repro criterion
  if (o.kind === "bug" && !criteria.some((c) => c.repro && c.expect !== null && !isJudged(c.expect)))
    return fail("a bug needs a `repro: true` criterion with a mechanical expect");
  return { ok: true, criteria, newDrives };
}
