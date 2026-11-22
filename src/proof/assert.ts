// Mechanical `expect:` matchers (PLAN §2 "Proofs"): the engine decides these,
// no agent involved. Pure.
//
// An expect line is one clause, or several joined by ` and `:
//   ok                                every step ran (toolkit) / exit 0 (cmd, test)
//   exit 0 · exit != 0 · exit code 1  the cmd/test exit code, or the last command step's (the cli primitive)
//   text "Saved" visible              the page's body text contains it (the engine reads `body` after the proof)
//   text "Error" not visible
//   contains "dark" · not contains "x" the proof's last output contains it (a command step: its stdout or stderr)
//   json .theme == "dark"             a JSON path into the last output (a command step: its stdout; an http
//                                     step: its body, or the {status, body} response for a key the body lacks)
//   json $me.body.theme == "dark"     … or into a saved var (a drive's `save:`)
//   rows == 3 · rows $list >= 1 · row count 2   length of a JSON array (or of `rows`/`body` in an object; else non-empty lines)
//   $theme == "Dark" · $theme != "Light" · $me contains "dark"
//   judged                            not mechanical: the verifier agent decides, citing evidence
// Values are "quoted strings", numbers, true, false or null.

export type Outcome = {
  /** Every step ran ok (toolkit) / the command exited 0. */
  ok: boolean;
  exit: number;
  /** The last step's output (a string, or JSON text; a command step's stdout). */
  output: string;
  /** What `contains` reads when it differs from `output`: a command step's stdout and stderr, as a terminal shows them. */
  shown?: string;
  vars: Record<string, string>;
  /** `body` text read after the proof, for `text … visible`. */
  pageText?: string;
  /** The last output came from an http step: `output` is its body; this is its status and the whole response. */
  response?: Response;
  /** The same for a var saved from an http step (`--save v`). */
  responses?: Record<string, Response>;
};
/** An http step's response, kept beside its body: the status (a failed one proves no absence) and the `{status, body}` text. */
export type Response = { status: number; full: string };

type Op = "==" | "!=" | "contains" | "not contains" | ">=" | "<=" | ">" | "<";
type Lit = string | number | boolean | null;
export type Clause =
  | { kind: "ok"; src: string }
  | { kind: "exit"; op: Op; n: number; src: string }
  | { kind: "text"; text: string; visible: boolean; src: string }
  | { kind: "contains"; text: string; negate: boolean; src: string }
  | { kind: "json"; subject: string | null; path: (string | number)[]; op: Op; value: Lit; src: string }
  | { kind: "rows"; subject: string | null; op: Op; n: number; src: string }
  | { kind: "var"; name: string; op: Op; value: Lit; src: string };

export class ExpectError extends Error {}

export const isJudged = (expect: string | null | undefined) => (expect ?? "").trim() === "judged";

/** Split on ` and ` outside quotes. */
function clausesOf(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') {
        cur += c + (s[++i] ?? "");
        continue;
      }
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (s.startsWith(" and ", i)) {
      out.push(cur);
      cur = "";
      i += 4;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function literal(raw: string, src: string): Lit {
  const r = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(r)) return JSON.parse(r) as string;
  if (/^'[^']*'$/.test(r)) return r.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(r)) return Number(r);
  if (r === "true" || r === "false") return r === "true";
  if (r === "null") return null;
  throw new ExpectError(`${JSON.stringify(src)}: ${JSON.stringify(r)} is not a value (quote strings)`);
}

const STR = /^("(?:[^"\\]|\\.)*"|'[^']*')/;
const quoted = (s: string, src: string): [string, string] => {
  const m = STR.exec(s.trim());
  if (!m) throw new ExpectError(`${JSON.stringify(src)}: expected a "quoted string"`);
  return [literal(m[1], src) as string, s.trim().slice(m[1].length).trim()];
};

function parsePath(p: string, src: string): { subject: string | null; path: (string | number)[] } {
  const m = /^(\$[a-z_][a-z0-9_]*)?((?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*)$/i.exec(p);
  if (!m || (!m[1] && !m[2])) throw new ExpectError(`${JSON.stringify(src)}: ${JSON.stringify(p)} is not a JSON path (.a.b[0] or $var.a)`);
  const path = [...m[2].matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g)].map((x) => (x[1] !== undefined ? x[1] : Number(x[2])));
  return { subject: m[1] ? m[1].slice(1) : null, path };
}

const OPS = ["not contains", "contains", "==", "!=", ">=", "<=", ">", "<"] as const;
function opAndRest(s: string, allowed: readonly Op[], src: string): [Op, string] {
  const t = s.trim();
  for (const o of OPS) if (t.startsWith(o) && allowed.includes(o)) return [o, t.slice(o.length).trim()];
  throw new ExpectError(`${JSON.stringify(src)}: expected one of ${allowed.join(", ")}`);
}

export function parseClause(src: string): Clause {
  const s = src.trim();
  if (s === "ok") return { kind: "ok", src };
  let m = /^exit(?:\s+code)?\s+(.*)$/.exec(s);
  if (m) {
    const t = m[1].trim();
    const [op, rest] = /^\d/.test(t) ? (["==", t] as [Op, string]) : opAndRest(t, ["==", "!="], src);
    if (!/^\d+$/.test(rest)) throw new ExpectError(`${JSON.stringify(src)}: exit takes a number`);
    return { kind: "exit", op, n: Number(rest), src };
  }
  m = /^text\s+(.*)$/.exec(s);
  if (m) {
    const [text, rest] = quoted(m[1], src);
    if (rest !== "visible" && rest !== "not visible") throw new ExpectError(`${JSON.stringify(src)}: text "…" visible | not visible`);
    if (!text) throw new ExpectError(`${JSON.stringify(src)}: empty text`);
    return { kind: "text", text, visible: rest === "visible", src };
  }
  m = /^(not\s+)?contains\s+(.*)$/.exec(s);
  if (m) {
    const [text, rest] = quoted(m[2], src);
    if (rest) throw new ExpectError(`${JSON.stringify(src)}: unexpected ${JSON.stringify(rest)}`);
    if (!text) throw new ExpectError(`${JSON.stringify(src)}: empty text`);
    return { kind: "contains", text, negate: !!m[1], src };
  }
  m = /^json\s+(\S+)\s+(.*)$/.exec(s);
  if (m) {
    const p = parsePath(m[1], src);
    const [op, rest] = opAndRest(m[2], ["==", "!=", "not contains", "contains"], src);
    return { kind: "json", ...p, op, value: literal(rest, src), src };
  }
  m = /^(?:rows|row\s+count)\s*(\$[a-z_][a-z0-9_]*)?\s*(.*)$/i.exec(s);
  if (m) {
    const t = m[2].trim();
    const [op, rest] = /^\d/.test(t) ? (["==", t] as [Op, string]) : opAndRest(t, ["==", "!=", ">=", "<=", ">", "<"], src);
    if (!/^\d+$/.test(rest)) throw new ExpectError(`${JSON.stringify(src)}: rows takes a number`);
    return { kind: "rows", subject: m[1] ? m[1].slice(1) : null, op, n: Number(rest), src };
  }
  m = /^\$([a-z_][a-z0-9_]*)\s+(.*)$/i.exec(s);
  if (m) {
    const [op, rest] = opAndRest(m[2], ["==", "!=", "not contains", "contains"], src);
    return { kind: "var", name: m[1], op, value: literal(rest, src), src };
  }
  throw new ExpectError(`${JSON.stringify(src)}: not a mechanical expect (ok, exit, text … visible, contains, json, rows, $var, or judged)`);
}

/** Parse a mechanical expect line. `judged` and an empty line are errors here. */
export function parseExpect(expect: string): Clause[] {
  if (isJudged(expect)) throw new ExpectError("judged is not mechanical");
  if (!expect.trim()) throw new ExpectError("empty expect");
  return clausesOf(expect).map(parseClause);
}

/** The strings a clause asks to be there (positive clauses only): `text "X" visible`, `contains "X"`, `== "X"`. */
export function wantedStrings(c: Clause): string[] {
  if (c.kind === "text") return c.visible ? [c.text] : [];
  if (c.kind === "contains") return c.negate ? [] : [c.text];
  if ((c.kind === "json" || c.kind === "var") && (c.op === "==" || c.op === "contains") && typeof c.value === "string") return [c.value];
  return [];
}

/**
 * Whether a timed-out `wait` polled for the state the criterion's own expect asks for
 * (its text is, or contains, or is contained in, a string a positive clause wants), so
 * the timeout is that expect failing rather than an unrelated broken step. Pure.
 */
export function waitMatchesExpect(waitText: string | undefined, expect: string | null | undefined): boolean {
  if (!waitText || !expect || isJudged(expect)) return false;
  let clauses: Clause[];
  try {
    clauses = parseExpect(expect);
  } catch {
    return false;
  }
  const w = waitText.toLowerCase();
  return clauses.flatMap(wantedStrings).some((s) => {
    const x = s.toLowerCase();
    return x === w || (Math.min(x.length, w.length) >= 3 && (x.includes(w) || w.includes(x)));
  });
}

/** Clauses that ask for something to be absent or different: `not visible`, `not contains`, `!=`. */
export const negativeClauses = (clauses: Clause[]) =>
  clauses.filter(
    (c) =>
      (c.kind === "text" && !c.visible) ||
      (c.kind === "contains" && c.negate) ||
      ((c.kind === "json" || c.kind === "var") && (c.op === "!=" || c.op === "not contains")),
  );
/** The string a negative clause says must not show (null for a non-string value). */
export const absentString = (c: Clause): string | null =>
  c.kind === "text" || c.kind === "contains" ? c.text : (c.kind === "json" || c.kind === "var") && typeof c.value === "string" ? c.value : null;

/** Does deciding this expect need the page's body text read after the proof? */
export const needsPage = (clauses: Clause[]) => clauses.some((c) => c.kind === "text");
/** Vars an expect refers to. */
export const varsOf = (clauses: Clause[]) =>
  clauses.flatMap((c) => (c.kind === "var" ? [c.name] : (c.kind === "json" || c.kind === "rows") && c.subject ? [c.subject] : []));

const tryJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.length > 120 ? `${v.slice(0, 120)}…` : v) : (JSON.stringify(v) ?? "undefined"));

function compare(got: unknown, op: Op, want: Lit): boolean {
  switch (op) {
    case "==":
      return got === want || ((typeof got === "number" || typeof want === "number") && String(got) === String(want));
    case "!=":
      return !compare(got, "==", want);
    case "contains":
      return (typeof got === "string" ? got : (JSON.stringify(got) ?? "")).includes(String(want));
    case "not contains":
      return !compare(got, "contains", want);
    default: {
      const a = Number(got);
      const b = Number(want);
      return op === ">=" ? a >= b : op === "<=" ? a <= b : op === ">" ? a > b : a < b;
    }
  }
}

function rowCount(text: string): number {
  const j = tryJson(text);
  if (Array.isArray(j)) return j.length;
  if (j && typeof j === "object") {
    for (const k of ["rows", "body"]) {
      const v = (j as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v.length;
    }
  }
  return text.split("\n").filter((l) => l.trim()).length;
}

export type ClauseResult = { clause: string; pass: boolean; got: string };
export type AssertResult = { pass: boolean; results: ClauseResult[]; why?: string };

/** Words of a page that failed (an error, not-found or no-access page): absence of anything there proves nothing. */
const ERROR_PAGE =
  /\b(not found|page not found|404|403|500|forbidden|access denied|permission denied|unauthori[sz]ed|internal server error|server error|bad request|admins only|something went wrong)\b/i;
/**
 * Why a negative clause can't hold on this page or response (it failed, or is empty), or null. `expected`: the
 * strings the same expect asks to be there: an error page whose error one of them names (and shows) is the
 * expected outcome (`contains "not found or already used" and not contains "Invite accepted"`), not a failure.
 */
export function failedSubject(text: string | undefined, expected: string[] = []): string | null {
  if (text === undefined || !text.trim()) return "empty: an empty read shows nothing, so its absence proves nothing";
  const j = tryJson(text);
  const status = j && typeof j === "object" ? Number((j as Record<string, unknown>).status) : Number.NaN;
  if (status >= 400) return `the response failed (status ${status}): its absence proves nothing`;
  const m = ERROR_PAGE.exec(text.slice(0, 2000));
  const asserted = m && expected.some((w) => text.includes(w) && w.toLowerCase().includes(m[1].toLowerCase()));
  if (m && !asserted && !(j && typeof j === "object"))
    return `the page looks like an error page ("${m[1]}"): a "not visible" check there proves nothing; if that error is the expected outcome, assert it (text "…" visible)`;
  return null;
}

export function evaluate(clauses: Clause[], o: Outcome): AssertResult {
  const expected = clauses.flatMap(wantedStrings);
  const results: ClauseResult[] = clauses.map((c): ClauseResult => {
    const subject = (name: string | null): { ok: true; v: string; resp?: Response } | { ok: false; got: string } =>
      name === null
        ? { ok: true, v: o.output, resp: o.response }
        : name in o.vars
          ? { ok: true, v: o.vars[name], resp: o.responses?.[name] }
          : { ok: false, got: `$${name} was not saved` };
    const failedResponse = (resp: Response | undefined) =>
      resp && resp.status >= 400 ? `the response failed (status ${resp.status}): its absence proves nothing` : null;
    switch (c.kind) {
      case "ok":
        return { clause: c.src, pass: o.ok, got: o.ok ? "all steps ok" : `failed (exit ${o.exit})` };
      case "exit":
        return { clause: c.src, pass: compare(o.exit, c.op, c.n), got: `exit ${o.exit}` };
      case "text": {
        if (o.pageText === undefined) return { clause: c.src, pass: false, got: "page text was not read" };
        const has = o.pageText.includes(c.text);
        const bad = !c.visible && !has ? failedSubject(o.pageText, expected) : null;
        if (bad) return { clause: c.src, pass: false, got: bad };
        return { clause: c.src, pass: has === c.visible, got: has ? "present" : "absent" };
      }
      case "contains": {
        const seen = o.shown ?? o.output;
        const has = seen.includes(c.text);
        const bad = c.negate && !has ? failedSubject(seen, expected) : null;
        if (bad) return { clause: c.src, pass: false, got: bad };
        return { clause: c.src, pass: has !== c.negate, got: show(seen) };
      }
      case "json": {
        const s = subject(c.subject);
        if (!s.ok) return { clause: c.src, pass: false, got: s.got };
        let v: unknown = tryJson(s.v);
        // An http step's body; a key it lacks is read from the {status, body} response (`.status`, `.body.ok`).
        const k0 = c.path[0];
        if (s.resp && typeof k0 === "string" && !(v && typeof v === "object" && !Array.isArray(v) && k0 in v)) v = tryJson(s.resp.full);
        if (v === undefined) return { clause: c.src, pass: false, got: `not JSON: ${show(s.v)}` };
        const negative = c.op === "!=" || c.op === "not contains";
        const top = negative ? (failedResponse(s.resp) ?? failedSubject(s.v)) : null;
        if (top?.startsWith("the response failed")) return { clause: c.src, pass: false, got: top };
        for (const k of c.path) v = v && typeof v === "object" ? (v as Record<string | number, unknown>)[k] : undefined;
        if (negative && (v === undefined || v === null || v === ""))
          return { clause: c.src, pass: false, got: `${show(v)}: nothing there, so it differing proves nothing` };
        return { clause: c.src, pass: compare(v, c.op, c.value), got: show(v) };
      }
      case "rows": {
        const s = subject(c.subject);
        if (!s.ok) return { clause: c.src, pass: false, got: s.got };
        const n = rowCount(s.v);
        return { clause: c.src, pass: compare(n, c.op, c.n), got: `${n} rows` };
      }
      case "var": {
        const s = subject(c.name);
        if (!s.ok) return { clause: c.src, pass: false, got: s.got };
        // A saved value that failed, is empty or is an error page proves no absence, as for the last output.
        if (c.op === "!=" || c.op === "not contains") {
          const bad = failedResponse(s.resp) ?? failedSubject(s.v, expected);
          if (bad) return { clause: c.src, pass: false, got: `$${c.name} ${bad}` };
        }
        return { clause: c.src, pass: compare(s.v, c.op, c.value), got: show(s.v) };
      }
    }
    return { clause: "?", pass: false, got: "?" };
  });
  const bad = results.find((r) => !r.pass);
  return { pass: !bad, results, ...(bad ? { why: `${bad.clause}: got ${bad.got}` } : {}) };
}
