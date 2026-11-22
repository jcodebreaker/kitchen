// report: the report role writes report.src.html citing evidence only as {{e<N>}};
// the engine renders report.html, refusing an unknown id or one not stamped for
// the final HEAD, then pushes the evidence and posts the PR comment (once each).
// W1: ids become links into evidence/; report-render.ts (W4) inlines everything.
import fs from "node:fs";
import path from "node:path";
import { evidenceDir, sealOf } from "../../proof/job.ts";
import { verifyManifest } from "../../proof/manifest.ts";
import { once, writeAtomic } from "../store.ts";
import { headOf } from "../worktree.ts";
import { prompt } from "./prompts.ts";
import { runRole } from "./role.ts";
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

export const report: StageHandler = async (ctx) => {
  const r = await runRole(ctx, {
    role: "report",
    file: "report.src.html",
    tier: "read",
    prompt: prompt({ role: "report", job: ctx.job, jobDir: ctx.jobDir, extra: [`Job folder: ${ctx.jobDir}`] }),
    dest: path.join(ctx.jobDir, `report.src-${ctx.job.attempts.render + 1}.html`),
  });
  const job = ctx.refresh();
  const entries = verifyManifest(evidenceDir(ctx.jobDir), job.manifestHead, sealOf(job));
  const out = render(r.text, new Map(entries.map((e) => [e.id, e.sha])), await headOf(job));
  const localForge = ctx.forge.kind === "local";
  if ("refusal" in out) {
    const facts = { report: { rendered: false, idsResolved: false, evidencePushed: false, commented: false, localForge, refusal: out.refusal } };
    return { to: job.attempts.render + 1 < 2 ? "report" : "needs-human", facts, note: `render refused: ${out.refusal}` };
  }
  writeAtomic(path.join(ctx.jobDir, "report.html"), out.html);
  fs.copyFileSync(path.join(ctx.jobDir, `report.src-${job.attempts.render + 1}.html`), path.join(ctx.jobDir, "report.src.html"));
  const pushed = localForge
    ? { value: false }
    : await once(ctx.repo, job.id, "evidence-branch", () => ctx.forge.pushEvidence({ key: `${job.id}/evidence`, job: job.id, dir: ctx.jobDir }));
  if (!localForge)
    await once(ctx.repo, job.id, "report-comment", () =>
      ctx.forge.comment({ key: `${job.id}/report-comment`, pr: job.pr, body: `Kitchen report for ${job.id}` }),
    );
  return { to: "done", facts: { report: { rendered: true, idsResolved: true, evidencePushed: !!pushed.value, commented: !localForge, localForge } } };
};
