// report: report.src.html cites evidence only as {{e<N>}}; the engine renders
// report.html, refusing an unknown id or one not stamped for the final HEAD, then
// publishes the evidence branch and posts the PR comment (once each), and marks
// the draft PR ready for review.
// W4: the report ROLE (an agent writing report.src.html from spec, verify, the
// manifest, reviews and the git log) and report-render.ts (inlining every cited
// file) come in W4. Until then report.src.html is the engine's placeholder
// template below (`placeholderSource`), built from the last verdict, and ids
// render as links into evidence/.
import fs from "node:fs";
import path from "node:path";
import { evidenceDir, sealOf } from "../../proof/job.ts";
import { type Entry, verifyManifest } from "../../proof/manifest.ts";
import { contractOf } from "../contract.ts";

import { once, writeAtomic } from "../store.ts";
import { headOf } from "../worktree.ts";
import type { StageHandler } from "./types.ts";

/** Pure: render or refuse. `stamped` maps id → the sha it was stamped with. */
export function render(src: string, stamped: Map<string, string>, head: string): { html: string } | { refusal: string } {
  const ids = [...src.matchAll(/\{\{\s*(e\d+)\s*\}\}/g)].map((m) => m[1]);
  const unknown = ids.filter((id) => !stamped.has(id));
  if (unknown.length) return { refusal: `unknown evidence id ${unknown.join(", ")}` };
  const stale = ids.filter((id) => stamped.get(id) !== head);
  if (stale.length) return { refusal: `evidence ${stale.join(", ")} is not stamped for ${head.slice(0, 8)}` };
  return { html: src.replace(/\{\{\s*(e\d+)\s*\}\}/g, (_m, id) => `<a href="evidence/${id}/call.json">${id}</a>`) };
}

export type VerdictRow = { id: string; by: string; result: string; evidence: string[]; why: string };

/** Pure: the criterion rows of a verdict file. */
export function verdictRows(text: string): VerdictRow[] {
  const rows: VerdictRow[] = [];
  for (const l of text.split("\n")) {
    const m = /^\|\s*(C\d+)\s*\|\s*(\w+)\s*\|\s*([A-Z-]+)\s*\|\s*([^|]*)\|\s*(.*?)\s*\|\s*$/.exec(l);
    if (m) rows.push({ id: m[1], by: m[2], result: m[3], evidence: m[4].trim().split(/\s+/).filter(Boolean), why: m[5].replace(/\\\|/g, "|") });
  }
  return rows;
}

/** The newest verdict file of the job (highest round, then highest move). */
export function lastVerdict(jobDir: string): { file: string; text: string } | null {
  const rounds = path.join(jobDir, "rounds");
  if (!fs.existsSync(rounds)) return null;
  const files = fs
    .readdirSync(rounds)
    .sort((a, b) => Number(b) - Number(a))
    .flatMap((r) =>
      fs
        .readdirSync(path.join(rounds, r))
        .filter((f) => /^verdict-m\d+\.md$/.test(f))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))
        .map((f) => path.join(rounds, r, f)),
    );
  return files[0] ? { file: files[0], text: fs.readFileSync(files[0], "utf8") } : null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * W4: placeholder for the report role. The engine's own report.src.html: the ticket,
 * each criterion with its Verdict and the evidence ids stamped for `head`. Pure.
 */
export function placeholderSource(o: {
  title: string;
  ticket: string;
  criteria: { id: string; text: string }[];
  rows: VerdictRow[];
  head: string;
  stamped: Map<string, string>;
}): string {
  const byId = new Map(o.rows.map((r) => [r.id, r]));
  const lines = o.criteria.map((c) => {
    const r = byId.get(c.id);
    const ids = (r?.evidence ?? []).filter((id) => o.stamped.get(id) === o.head);
    return `<tr><td>${esc(c.id)}</td><td>${esc(c.text)}</td><td>${esc(r?.result ?? "—")}</td><td>${esc(r?.by ?? "")}</td><td>${ids.map((id) => `{{${id}}}`).join(" ")}</td></tr>`;
  });
  return [
    "<!doctype html><meta charset=utf-8>",
    `<title>Kitchen report: ${esc(o.title)}</title>`,
    "<!-- W4: placeholder template. The report role (W4) writes this file. -->",
    `<h1>${esc(o.title)}</h1>`,
    `<p>Proven on <code>${o.head.slice(0, 12)}</code>. Every proof below was run by the engine through <code>kitchen drive</code>; judged criteria were decided by the verifier citing stamped evidence.</p>`,
    "<h2>Ticket</h2>",
    `<pre>${esc(o.ticket.trim())}</pre>`,
    "<h2>Criteria</h2>",
    "<table><tr><th>criterion</th><th>what</th><th>verdict</th><th>decided by</th><th>evidence</th></tr>",
    ...lines,
    "</table>",
  ].join("\n");
}

/** Pure: the PR comment's table. `link` turns an evidence id into a URL (or null). */
export function commentBody(o: {
  job: string;
  head: string;
  rows: VerdictRow[];
  folder: string | null;
  link: (id: string) => string | null;
  thumb: (id: string) => string | null;
}): string {
  const t = o.rows.map((r) => {
    const ev = r.evidence.map((id) => (o.link(id) ? `[${id}](${o.link(id)})` : id)).join(" ");
    const th = r.evidence.map((id) => o.thumb(id)).find(Boolean);
    return `| ${r.id} | ${r.result} | ${r.by} | ${ev} | ${th ? `<img src="${th}" width="160">` : ""} |`;
  });
  return [
    `### Kitchen report for \`${o.job}\``,
    `Proven on \`${o.head.slice(0, 12)}\`.${o.folder ? ` Report and evidence: [${o.job}](${o.folder}).` : ""}`,
    "",
    "| criterion | verdict | decided by | evidence | |",
    "|---|---|---|---|---|",
    ...t,
  ].join("\n");
}

export const report: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const entries: Entry[] = verifyManifest(evidenceDir(ctx.jobDir), job.manifestHead, sealOf(job));
  const stamped = new Map(entries.map((e) => [e.id, e.sha]));
  const head = await headOf(job);
  const v = lastVerdict(ctx.jobDir);
  const rows = v ? verdictRows(v.text) : [];
  const criteria = (contractOf(ctx.jobDir)?.criteria ?? []).map((c) => ({ id: c.id, text: c.text }));
  // W4: the report role writes this; the placeholder is engine-made (no agent run).
  const src = placeholderSource({ title: job.title, ticket: fs.readFileSync(path.join(ctx.jobDir, "ticket.md"), "utf8"), criteria, rows, head, stamped });
  const attempt = job.attempts.render + 1;
  writeAtomic(path.join(ctx.jobDir, `report.src-${attempt}.html`), src);
  const out = render(src, stamped, head);
  const localForge = ctx.forge.kind === "local";
  if ("refusal" in out) {
    const facts = { report: { rendered: false, idsResolved: false, evidencePushed: false, commented: false, localForge, refusal: out.refusal } };
    return { to: job.attempts.render + 1 < 2 ? "report" : "needs-human", facts, note: `render refused: ${out.refusal}` };
  }
  writeAtomic(path.join(ctx.jobDir, "report.html"), out.html);
  fs.copyFileSync(path.join(ctx.jobDir, `report.src-${attempt}.html`), path.join(ctx.jobDir, "report.src.html"));
  if (localForge) return { to: "done", facts: { report: { rendered: true, idsResolved: true, evidencePushed: false, commented: false, localForge } } };
  const pushed = await once(ctx.repo, job.id, "evidence-branch", () => ctx.forge.pushEvidence({ key: `${job.id}/evidence`, job: job.id, dir: ctx.jobDir }));
  const folder = pushed.value ?? null;
  const files = new Map(entries.map((e) => [e.id, e.files.map((f) => f.path)]));
  const fileUrl = (id: string, f: string) => (folder ? `${folder.replace("/tree/", "/blob/")}/evidence/${id}/${f}` : null);
  const body = commentBody({
    job: job.id,
    head,
    rows,
    folder,
    link: (id) => fileUrl(id, "call.json"),
    thumb: (id) => {
      const png = (files.get(id) ?? []).find((f) => /\.png$/i.test(f));
      return png && folder ? `${folder.replace("/tree/", "/raw/")}/evidence/${id}/${png}` : null;
    },
  });
  await once(ctx.repo, job.id, "report-comment", () => ctx.forge.comment({ key: `${job.id}/report-comment`, pr: job.pr, body }));
  await once(ctx.repo, job.id, "pr-ready", () => ctx.forge.markReady(job.pr));
  return { to: "done", facts: { report: { rendered: true, idsResolved: true, evidencePushed: !!folder, commented: true, localForge } } };
};
