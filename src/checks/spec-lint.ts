// spec-lint (PLAN §2 "Spec format"), the W1 subset: rules 1 (every criterion
// has a proof of kind toolkit, cmd or test), 2 (a named primitive must exist;
// a dotted name is a feature drive, which the drives stage may write), 5 (a bug
// has a `repro: true` criterion with a mechanical expect) and 6 (unique ids).
// Rules 3 (judged only for visual/wording) and 4 (protected paths) come in W3a. Pure.

export type Criterion = { id: string; text: string; proof: string | null; expect: string | null; repro: boolean };
export type LintResult = { ok: boolean; reason?: string; missingPrimitive?: string; criteria: Criterion[] };

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
      if (kv[1] === "proof") cur.proof = kv[2];
      else if (kv[1] === "expect") cur.expect = kv[2];
      else cur.repro = kv[2] === "true";
    } else if (/^\S/.test(line)) cur = null;
  }
  return out;
}

/** Primitive names a proof line calls: `toolkit <name> …` segments separated by `;`. */
export function toolkitNames(proof: string): string[] {
  return proof
    .split(";")
    .map((s) => /^\s*toolkit\s+([A-Za-z0-9_.-]+)/.exec(s)?.[1])
    .filter((x): x is string => !!x);
}

export function lintSpec(md: string, o: { kind: string | null; primitives: string[] }): LintResult {
  const criteria = parseCriteria(md);
  const fail = (reason: string, extra: Partial<LintResult> = {}): LintResult => ({ ok: false, reason, criteria, ...extra });
  if (!criteria.length) return fail("no criteria (`- [C1] …` with a `proof:` line)");
  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.id)) return fail(`duplicate id ${c.id}`);
    seen.add(c.id);
    if (!c.proof) return fail(`${c.id} has no proof`);
    if (!/^\s*(toolkit|cmd|test)\b/.test(c.proof)) return fail(`${c.id}: proof must be toolkit, cmd or test`);
  }
  for (const c of criteria) {
    for (const name of toolkitNames(c.proof ?? "")) {
      if (!name.includes(".") && !o.primitives.includes(name))
        return fail(`${c.id} needs primitive ${name}, which the Toolkit lacks`, { missingPrimitive: name });
    }
  }
  if (o.kind === "bug" && !criteria.some((c) => c.repro && c.expect && c.expect !== "judged"))
    return fail("a bug needs a `repro: true` criterion with a mechanical expect");
  return { ok: true, criteria };
}
