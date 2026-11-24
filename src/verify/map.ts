// The verify skill's feature map (ADR 0017), read as data. Pure apart from the reads: a feature file in, its
// sub-features, recipe steps, expected results and `Code:` paths out; two maps in, what the newer one removed out.
//
// The feature file contract (from pstack's create-verification-skill, MIT © 2026 Lauren Tan, see NOTICE): an H1
// title and one paragraph, then four H2s in this order — `Sub-features`, `How to get to it (user POV)`,
// `Driving it with …`, `Gotchas` — and a last `Code:` line naming the files or folders behind the feature.
//
// The weakening rule (ADR 0017 §4), over that structure only:
// - a sub-feature is its bullet's id (a leading `code span`, else the word before a colon); it is removed when no
//   bullet in the newer file has that id;
// - a recipe step is a `Driving it with …` bullet outside the `Preconditions:` list, keyed by its bold label (else
//   its whole text); it is removed when no step in the newer file has that key;
// - a step's expected result is its text after the sentence with its command (`Run `…``), else its last sentence;
//   it is changed when the same step's expected result reads differently (whitespace and case aside);
// - a feature file that is gone removes every sub-feature and step it had.
// Each removal is allowed only when intake's `CHANGES:` names it: `<feature>/<sub-feature>` for that sub-feature,
// and for a step either a sub-feature the step names in a code span or, when it names none, any sub-feature of
// that feature.
import fs from "node:fs";
import path from "node:path";
import { matchPath } from "../engine/lanes.ts";

export const H2 = ["Sub-features", "How to get to it (user POV)", "Driving it with", "Gotchas"] as const;

export type Sub = { id: string; text: string };
export type Step = { key: string; label: string | null; text: string; expected: string; subs: string[] };
export type Feature = { id: string; title: string; subs: Sub[]; steps: Step[]; code: string[]; text: string };
export type FeatureMap = { readme: string | null; features: Feature[] };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const bare = (s: string) => norm(s).replace(/[.;:]+$/, "");

/** Top-level bullets of a block of lines, each with the index of the list it is in (lists split at blank lines). */
function bullets(lines: string[]): { text: string; list: number; after: string }[] {
  const out: { text: string; list: number; after: string }[] = [];
  let list = 0;
  let inList = false;
  let lastPara = "";
  for (const l of lines) {
    const m = /^[-*+]\s+(.*)$/.exec(l);
    if (m) {
      if (!inList) {
        list++;
        inList = true;
      }
      out.push({ text: m[1], list, after: lastPara });
    } else if (/^\s+\S/.test(l) && inList && out.length) out[out.length - 1].text += ` ${l.trim()}`;
    else if (l.trim() === "") {
      if (inList) inList = false;
    } else {
      inList = false;
      lastPara = l.trim();
    }
  }
  return out;
}

const spans = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

function subId(text: string): string {
  const t = text.trim();
  const code = /^`([^`]+)`/.exec(t);
  if (code) return code[1].trim();
  const colon = /^\*{0,2}([A-Za-z0-9][\w.-]*)\*{0,2}\s*:/.exec(t);
  if (colon) return colon[1];
  return (t.split(/\s+/)[0] ?? "").replace(/[^\w.-]/g, "");
}

function expectedOf(text: string): string {
  const t = text.replace(/^\*\*.+?\*\*\s*/, "");
  const run = t.lastIndexOf("Run `");
  if (run >= 0) {
    // The command sentence ends at the first period outside a code span.
    let inCode = false;
    for (let i = run; i < t.length; i++) {
      if (t[i] === "`") inCode = !inCode;
      else if (!inCode && t[i] === "." && (i + 1 === t.length || /\s/.test(t[i + 1]))) {
        const after = t.slice(i + 1).trim();
        if (after) return bare(after);
        break;
      }
    }
  }
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z`*])/).filter((s) => s.trim());
  return bare(sentences[sentences.length - 1] ?? t);
}

/** The `Code:` line's paths: its code spans, else its comma- or space-separated words. */
export function parseCode(line: string): string[] {
  const v = line.replace(/^\s*\*{0,2}Code:\*{0,2}\s*/i, "");
  const raw = spans(v).length ? spans(v) : v.split(/[,\s]+/);
  return raw
    .map((x) =>
      x
        .trim()
        .replace(/^\.\//, "")
        .replace(/[,.;]+$/, ""),
    )
    .filter((x) => x && /[\w*]/.test(x));
}

/** Pure: one feature file. `id` is its file name without `.md`. */
export function parseFeature(id: string, md: string): Feature {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const title = (lines.find((l) => /^#\s+/.test(l)) ?? `# ${id}`).replace(/^#\s+/, "").trim();
  const codeIdx = lines.map((l, i) => (/^\s*\*{0,2}Code:/i.test(l) ? i : -1)).filter((i) => i >= 0);
  const code = codeIdx.length ? parseCode(lines[codeIdx[codeIdx.length - 1]]) : [];
  const sections = new Map<string, string[]>();
  let cur: string | null = null;
  for (const [i, l] of lines.entries()) {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) {
      cur = h[1];
      sections.set(cur, []);
    } else if (cur && !codeIdx.includes(i)) sections.get(cur)?.push(l);
  }
  const sec = (prefix: string) => [...sections.entries()].find(([k]) => k.toLowerCase().startsWith(prefix.toLowerCase()))?.[1] ?? [];
  const subs = bullets(sec("Sub-features")).map((b) => ({ id: subId(b.text), text: norm(b.text) }));
  const ids = new Set(subs.map((s) => s.id));
  const drive = bullets(sec("Driving it with"));
  const preList = drive.find((b) => /^\**preconditions\**:?\**$/i.test(b.after))?.list;
  const steps = drive
    .filter((b) => b.list !== preList)
    .map((b) => {
      const label = /^\*\*(.+?)\*\*/.exec(b.text.trim())?.[1] ?? null;
      const text = norm(b.text);
      return {
        key: label ? `label:${bare(label).toLowerCase()}` : `text:${text.toLowerCase()}`,
        label: label ? bare(label) : null,
        text,
        expected: expectedOf(text),
        subs: spans(text).filter((s) => ids.has(s)),
      };
    });
  return { id, title, subs, steps, code, text: md };
}

/** Pure: what a feature file lacks against the contract, or [] when it holds. */
export function contractProblems(f: Feature): string[] {
  const heads = [...f.text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const p: string[] = [];
  if (!/^#\s+\S/m.test(f.text)) p.push("an H1 title");
  const got = heads.map((h) => H2.findIndex((x) => (x === "Driving it with" ? h.startsWith(x) : h === x)));
  if (got.length !== 4 || got.some((g, i) => g !== i))
    p.push(`exactly four H2s in this order: ${H2.map((h) => (h === "Driving it with" ? "Driving it with …" : h)).join(", ")}`);
  if (!f.subs.length) p.push("at least one sub-feature id under Sub-features");
  if (!f.steps.length) p.push("at least one recipe step under Driving it with …");
  if (!f.code.length) p.push("a last `Code:` line naming the files or folders behind the feature");
  return p;
}

/** Pure: does a changed file fall under one of a feature's `Code:` paths (a file, a folder, or a glob)? */
export function codeMatches(code: string, file: string): boolean {
  const c = code.replace(/^\.\//, "");
  if (c.includes("*")) return matchPath(c, file);
  const d = c.replace(/\/+$/, "");
  return file === d || file.startsWith(`${d}/`);
}

/** Pure: the features whose `Code:` covers any of `files`, in map order. */
export function touchedFeatures(features: Feature[], files: string[]): Feature[] {
  return features.filter((f) => f.code.some((c) => files.some((x) => codeMatches(c, x))));
}

/** Pure: the README's sweep order: the feature files it links, in order, then the rest by name. */
export function sweepOrder(readme: string | null, features: Feature[]): Feature[] {
  const linked = [...(readme ?? "").matchAll(/\]\(\.?\/?([\w.-]+)\.md\)/g)].map((m) => m[1]);
  const seen = new Set<string>();
  const out: Feature[] = [];
  for (const id of linked) {
    const f = features.find((x) => x.id === id);
    if (f && !seen.has(id)) {
      out.push(f);
      seen.add(id);
    }
  }
  return [...out, ...features.filter((f) => !seen.has(f.id)).sort((a, b) => a.id.localeCompare(b.id))];
}

export type Removal = { feature: string; kind: "sub" | "step" | "expected"; item: string; was: string; now: string; subs: string[] };

/** Pure: what `after` removes from `before` (ADR 0017 §4; the rule is at the top of this file). */
export function removals(before: Feature[], after: Feature[]): Removal[] {
  const out: Removal[] = [];
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    for (const s of b.subs)
      if (!a?.subs.some((x) => x.id === s.id)) out.push({ feature: b.id, kind: "sub", item: `${b.id}/${s.id}`, was: s.text, now: "(removed)", subs: [s.id] });
    for (const s of b.steps) {
      const n = a?.steps.find((x) => x.key === s.key);
      const name = `${b.id}: ${s.label ?? s.text.slice(0, 60)}`;
      if (!n) out.push({ feature: b.id, kind: "step", item: name, was: s.text, now: "(removed)", subs: s.subs });
      else if (norm(n.expected).toLowerCase() !== norm(s.expected).toLowerCase())
        out.push({ feature: b.id, kind: "expected", item: name, was: s.expected, now: n.expected, subs: s.subs });
    }
  }
  return out;
}

/** Pure: is this removal named by one of intake's `CHANGES:` entries (`feature/sub-feature`)? */
export function namedBy(r: Removal, changes: string[]): string | null {
  const f = r.feature.toLowerCase();
  const ok = (x: string) => (r.subs.length ? r.subs.some((s) => x === `${f}/${s.toLowerCase()}`) : x.startsWith(`${f}/`));
  return changes.find((x) => ok(x.toLowerCase())) ?? null;
}

// ---------- where the skill lives ----------

export const SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

/** The verify skill's folder name in a checkout (`verify-<app>`), or null when there is none. The Claude copy wins. */
export function skillName(root: string): string | null {
  for (const r of SKILL_ROOTS) {
    const d = path.join(root, r);
    if (!fs.existsSync(d)) continue;
    const hit = fs
      .readdirSync(d)
      .filter((n) => /^verify-[\w.-]+$/.test(n) && fs.existsSync(path.join(d, n, "SKILL.md")))
      .sort()[0];
    if (hit) return hit;
  }
  return null;
}

/** The map folder (`features/`) of the verify skill, relative to the checkout root. */
export const featuresRel = (name: string, root: (typeof SKILL_ROOTS)[number] = ".claude/skills") => `${root}/${name}/features`;

/** Is this path inside a verify skill (either tool's copy)? */
export const isVerifyPath = (p: string) => /^\.(claude|agents)\/skills\/verify-[^/]+(\/|$)/.test(p);

/** The map in a checkout on disk, or an empty map when there is no skill. `want`: the skill's name, when it is there. */
export function readMap(root: string, want?: string): FeatureMap & { name: string | null } {
  const name = want && SKILL_ROOTS.some((r) => fs.existsSync(path.join(root, r, want, "SKILL.md"))) ? want : skillName(root);
  if (!name) return { name: null, readme: null, features: [] };
  const dir = path.join(root, featuresRel(name));
  const alt = path.join(root, featuresRel(name, ".agents/skills"));
  const d = fs.existsSync(dir) ? dir : alt;
  return { name, ...readMapDir(d) };
}

/** A features/ folder: README.md and every other *.md as a feature. */
export function readMapDir(d: string): FeatureMap {
  if (!fs.existsSync(d)) return { readme: null, features: [] };
  const files = fs.readdirSync(d).filter((f) => f.endsWith(".md"));
  const readme = files.includes("README.md") ? fs.readFileSync(path.join(d, "README.md"), "utf8") : null;
  const features = files
    .filter((f) => f !== "README.md")
    .sort()
    .map((f) => parseFeature(f.replace(/\.md$/, ""), fs.readFileSync(path.join(d, f), "utf8")));
  return { readme, features };
}
