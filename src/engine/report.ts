// The Report (ADR 0016 §4): one self-contained HTML page per job, report.html in its folder, written when the job
// ends up merged, held at Ready, or with a person. It shows what a person must check first, then the proof: each
// criterion with QA's result and the evidence files it cites (screenshots inline, transcripts quoted), the review,
// the checks and the diff stat. Evidence is plain files in the job folder; the Report cites them by name.
import fs from "node:fs";
import path from "node:path";
import { criteriaOf, leftOutOf, qaDir, readQa, readReview } from "./lanes.ts";
import type { Job } from "./machine.ts";
import { readMessages } from "./messages.ts";
import { jobDirOf, roundDir, writeAtomic } from "./store.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const MAX_TEXT = 6000;
const MAX_IMAGE = 3 * 1024 * 1024;

function evidenceHtml(dir: string, f: string): string {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return `<p class="miss">${esc(f)}: missing</p>`;
  if (/\.(png|jpe?g)$/i.test(f)) {
    const b = fs.readFileSync(p);
    if (b.length > MAX_IMAGE) return `<p>${esc(f)} (${Math.round(b.length / 1024)} KB, too large to inline)</p>`;
    return `<figure><img alt="${esc(f)}" src="data:image/${/png$/i.test(f) ? "png" : "jpeg"};base64,${b.toString("base64")}"><figcaption>${esc(f)}</figcaption></figure>`;
  }
  const t = fs.readFileSync(p, "utf8");
  return `<details><summary>${esc(f)}</summary><pre>${esc(t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n…` : t)}</pre></details>`;
}

/** Pure apart from reading the job folder: the Report's HTML. */
export function renderReport(repo: string, job: Job, o: { diff?: { p: string; a: number; d: number }[]; checks?: string } = {}): string {
  const dir = jobDirOf(repo, job.id);
  const crit = criteriaOf(dir);
  const qa = readQa(dir, job.round, crit);
  const review = readReview(dir, job.round);
  const qd = qaDir(dir, job.round);
  const status =
    job.stage === "done" && job.merged
      ? `Merged into ${esc(job.merged.into)} (${esc(job.merged.sha.slice(0, 7))}${job.merged.via === "github" && job.pr ? `, PR #${job.pr}` : ""})`
      : job.stage === "ready"
        ? `Ready for you: ${esc(job.held ?? "a person merges it")}`
        : `${esc(job.stage)}${job.pausedReason ? `: ${esc(job.pausedReason)}` : ""}`;
  const check: string[] = [];
  if (job.held) check.push(esc(job.held));
  if ("findings" in review)
    for (const f of review.findings.filter((x) => !x.blocks)) check.push(`Review note ${esc(f.id)}${f.at ? ` (${esc(f.at)})` : ""}: ${esc(f.why)}`);
  const leftOut = leftOutOf(dir);
  if (leftOut) check.push(`Left out by intake (not in your ticket; file it separately if you want it): ${esc(leftOut)}`);
  if (job.risk === "high") check.push("High risk: read the diff yourself before you merge it anywhere else.");
  const rows = crit
    .map((c) => {
      const r = "criteria" in qa ? qa.criteria.find((x) => x.id === c.id) : undefined;
      return `<tr><td>${esc(c.id)}</td><td>${esc(c.text)}<br><small>${esc(c.check)}</small></td><td class="${r?.result === "PASS" ? "ok" : "bad"}">${esc(r?.result ?? "not checked")}</td><td>${esc(r?.note ?? "")}${(r?.evidence ?? []).map((f) => evidenceHtml(qd, f)).join("")}</td></tr>`;
    })
    .join("\n");
  const findings =
    "findings" in review
      ? review.findings.length
        ? `<ul>${review.findings.map((f) => `<li><b>${esc(f.id)}</b> ${f.blocks ? "blocking" : "note"}${f.at ? ` · ${esc(f.at)}` : ""}: ${esc(f.why)}</li>`).join("")}</ul>`
        : "<p>No findings.</p>"
      : `<p>${esc(review.refused)}</p>`;
  const diff = o.diff?.length
    ? `<table>${o.diff.map((f) => `<tr><td><code>${esc(f.p)}</code></td><td class="ok">+${f.a}</td><td class="bad">−${f.d}</td></tr>`).join("")}</table>`
    : "<p>No diff recorded.</p>";
  const thread = readMessages(dir);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Kitchen ${esc(job.id)}</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#e5e5ea;--ok:#1a7f37;--bad:#c62828;--card:#f6f6f8}
@media (prefers-color-scheme: dark){:root{--bg:#111;--fg:#f2f2f2;--mut:#a1a1a6;--line:#2c2c2e;--ok:#3fb950;--bad:#ff6b6b;--card:#1c1c1e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.st{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}table{width:100%;border-collapse:collapse}td{border-top:1px solid var(--line);padding:8px 6px;vertical-align:top}
img{max-width:100%;border:1px solid var(--line);border-radius:6px}figure{margin:8px 0}figcaption,small{color:var(--mut);font-size:12px}
pre{background:var(--card);padding:8px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap}.box{background:var(--card);border-radius:8px;padding:10px 14px}
</style></head><body><main>
<h1>${esc(job.id)} · ${esc(job.title)}</h1>
<p class="st">${status} · ${esc(job.kind ?? "?")} · risk ${esc(job.risk ?? "?")} · round ${job.round} · branch <code>${esc(job.branch)}</code></p>
<h2>What you must check</h2>
<div class="box">${check.length ? `<ul>${check.map((c) => `<li>${c}</li>`).join("")}</ul>` : "<p>Nothing beyond the proof below.</p>"}</div>
<h2>Criteria, checked against the running app</h2>
<table>${rows || "<tr><td>No criteria.</td></tr>"}</table>
${"refused" in qa ? `<p class="bad">QA: ${esc(qa.refused)}</p>` : ""}
<h2>Review</h2>${"summary" in review && review.summary ? `<p>${esc(review.summary)}</p>` : ""}${findings}
<h2>Checks</h2><pre>${esc(o.checks ?? readChecks(dir, job.round))}</pre>
<h2>What changed</h2>${diff}
${thread.length ? `<h2>Your messages</h2><ul>${thread.map((m) => `<li>${esc(m.at.slice(0, 16).replace("T", " "))} ${esc(m.kind)}: ${esc(m.text)}</li>`).join("")}</ul>` : ""}
<p class="st">Evidence files: ${esc(path.relative(repo, qd))}/</p>
</main></body></html>
`;
}

function readChecks(dir: string, round: number): string {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(roundDir(dir, round), "checks.json"), "utf8")) as { name: string; ok: boolean; exit: number | null }[];
    return r.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : ` (exit ${c.exit ?? "timeout"})`}`).join("\n") || "no checks configured";
  } catch {
    return "not run";
  }
}

export function writeReport(repo: string, job: Job, o: { diff?: { p: string; a: number; d: number }[] } = {}): string {
  const f = path.join(jobDirOf(repo, job.id), "report.html");
  writeAtomic(f, renderReport(repo, job, o));
  return f;
}
