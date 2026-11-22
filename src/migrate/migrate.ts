// `kitchen migrate [--dry-run]` (PLAN §4): bring a repo's Kitchen files up to this Kitchen.
//
// 1. kitchen.yaml: its schema version (`version:`, absent = 0) is raised one step at a time
//    through MIGRATIONS, editing the YAML document so comments and order stay. The result must
//    parse with this Kitchen's schema, or nothing is written. A version newer than this Kitchen
//    knows is refused (upgrade Kitchen instead).
// 2. The Toolkit: the template's generic files (bin/dev, lib/*.mjs: TEMPLATE.md's "generic"
//    rows) that the repo's `.kitchen/toolkit/` has are replaced by this Kitchen's when they
//    differ, which carries the contract version (`CONTRACT` in lib/common.mjs) and the
//    template's fixes. Project files (app.mjs, SKILL.md, features/, package.json) are never
//    touched, and a generic module the project deleted is not brought back.
// Every change is printed as a unified diff first; `--dry-run` stops there. Written files are
// left uncommitted: the person reviews and commits them, and Kitchen re-proves the Toolkit
// when the base moves (reproof.ts).
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { configFile, parseConfig } from "../config.ts";

export const CONFIG_VERSION = 1;
export const TEMPLATE_DIR = path.resolve(import.meta.dirname, "..", "..", "toolkit-template");
/** The template's generic files (TEMPLATE.md): Kitchen owns them; a project owns everything else. */
export const GENERIC = ["bin/dev", "lib/common.mjs", "lib/browser.mjs", "lib/browser-daemon.mjs", "lib/terminal.mjs"];

/**
 * One step: from version `from` to `from + 1`, on the file's text, so comments, spacing and key order
 * stay exactly as the person wrote them. A step that needs structure parses the text itself.
 */
type Migration = { from: number; why: string; run: (text: string) => string };

/** Insert `line` as the first key: after the leading comment lines. */
function asFirstKey(text: string, line: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && /^\s*#/.test(lines[i])) i++;
  lines.splice(i, 0, line);
  return lines.join("\n");
}

export const MIGRATIONS: Migration[] = [
  { from: 0, why: "stamp the schema version (kitchen.yaml before 0.1 had none)", run: (t) => asFirstKey(t, "version: 1") },
];

export type FileChange = { file: string; before: string | null; after: string; why: string };

/** Pure: the kitchen.yaml text at CONFIG_VERSION, with the steps it took. Throws on a version this Kitchen doesn't know. */
export function migrateConfigText(text: string): { after: string; steps: string[]; from: number } {
  const doc = parseDocument(text || "{}\n");
  if (doc.errors.length) throw new Error(`kitchen.yaml: ${doc.errors[0].message.split("\n")[0]}`);
  const raw = doc.get("version");
  const from = raw === undefined || raw === null ? 0 : Number(raw);
  if (!Number.isInteger(from) || from < 0) throw new Error(`kitchen.yaml: version ${String(raw)} is not a schema version`);
  if (from > CONFIG_VERSION)
    throw new Error(`kitchen.yaml is version ${from}; this Kitchen knows up to ${CONFIG_VERSION}: upgrade Kitchen, don't downgrade the file`);
  const steps: string[] = [];
  let after = text;
  for (let v = from; v < CONFIG_VERSION; v++) {
    const m = MIGRATIONS.find((x) => x.from === v);
    if (!m) throw new Error(`no migration from kitchen.yaml version ${v}`);
    after = m.run(after);
    steps.push(`${v} → ${v + 1}: ${m.why}`);
  }
  if (Number(parseDocument(after).get("version") ?? 0) !== CONFIG_VERSION)
    throw new Error(`kitchen.yaml: the migrations did not reach version ${CONFIG_VERSION}`);
  parseConfig(after); // refuses anything this Kitchen can't load
  return { after, steps, from };
}

/** What `kitchen migrate` would change in `repo`. Reads only. */
export function planMigration(repo: string, templateDir = TEMPLATE_DIR): { changes: FileChange[]; notes: string[] } {
  const changes: FileChange[] = [];
  const notes: string[] = [];
  const cf = configFile(repo);
  const text = fs.existsSync(cf) ? fs.readFileSync(cf, "utf8") : null;
  if (text === null) notes.push("no kitchen.yaml (kitchen init writes one)");
  else {
    const c = migrateConfigText(text);
    if (c.steps.length) changes.push({ file: "kitchen.yaml", before: text, after: c.after, why: c.steps.join("; ") });
    else notes.push(`kitchen.yaml: version ${c.from}, up to date`);
  }
  const tk = path.join(repo, ".kitchen", "toolkit");
  if (!fs.existsSync(tk)) notes.push("no .kitchen/toolkit in this checkout (it may still be on the kitchen/setup branch)");
  else {
    const mine = contractOf(path.join(tk, "lib", "common.mjs"));
    const theirs = contractOf(path.join(templateDir, "lib", "common.mjs"));
    for (const f of GENERIC) {
      const at = path.join(tk, f);
      if (!fs.existsSync(at)) continue;
      const before = fs.readFileSync(at, "utf8");
      const after = fs.readFileSync(path.join(templateDir, f), "utf8");
      if (before !== after)
        changes.push({
          file: path.join(".kitchen", "toolkit", f),
          before,
          after,
          why: `the template's ${f} (Toolkit contract v${theirs ?? "?"}, was v${mine ?? "?"})`,
        });
    }
    if (mine !== null && !changes.some((c) => c.file.startsWith(".kitchen")))
      notes.push(`Toolkit: generic files match this Kitchen's template (contract v${mine ?? "?"})`);
    if (!fs.existsSync(path.join(tk, "lib", "common.mjs")))
      notes.push("Toolkit: not made from Kitchen's template (no lib/common.mjs); its contract is checked by `kitchen toolkit check`");
  }
  return { changes, notes };
}

const contractOf = (f: string): number | null => {
  try {
    const m = /export const CONTRACT = (\d+)/.exec(fs.readFileSync(f, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
};

export function applyMigration(repo: string, changes: FileChange[]) {
  for (const c of changes) {
    const f = path.join(repo, c.file);
    const mode = fs.existsSync(f) ? fs.statSync(f).mode : 0o644;
    fs.writeFileSync(f, c.after, { mode });
  }
}

/** Pure: a unified diff of two texts (whole-line LCS, 3 lines of context). Empty when equal. */
export function unifiedDiff(a: string, b: string, name: string): string {
  if (a === b) return "";
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  // ops with the 1-based line each side is at
  const ops: { t: " " | "-" | "+"; s: string; a: number; b: number }[] = [];
  for (let i = 0, j = 0; i < n || j < m; ) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: " ", s: x[i++], a: i, b: ++j });
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ t: "-", s: x[i++], a: i, b: j });
    else ops.push({ t: "+", s: y[j++], a: i, b: j });
  }
  // hunks: every change with 3 lines of context, overlapping ranges merged
  const C = 3;
  const ranges: [number, number][] = [];
  ops.forEach((o, k) => {
    if (o.t === " ") return;
    const lo = Math.max(0, k - C);
    const hi = Math.min(ops.length, k + C + 1);
    const last = ranges.at(-1);
    if (last && lo <= last[1]) last[1] = hi;
    else ranges.push([lo, hi]);
  });
  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (const [lo, hi] of ranges) {
    const h = ops.slice(lo, hi);
    const as = h.filter((o) => o.t !== "+");
    const bs = h.filter((o) => o.t !== "-");
    const aStart = as.length ? as[0].a : h[0].a;
    const bStart = bs.length ? bs[0].b : h[0].b;
    out.push(`@@ -${aStart},${as.length} +${bStart},${bs.length} @@`);
    for (const o of h) out.push(`${o.t}${o.s}`);
  }
  return `${out.join("\n")}\n`;
}
