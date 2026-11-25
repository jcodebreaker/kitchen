// The Report (ADR 0016 §4): one self-contained HTML page per job, report.html in its folder, written when the job
// ends up merged, held at Ready, or with a person. It shows what a person must check first, then the proof: each
// criterion with QA's result and the evidence files it cites (screenshots inline, transcripts quoted), the review,
// the checks and the diff stat. Evidence is plain files in the job folder; the Report cites them by name.
import fs from "node:fs";
import path from "node:path";
import { type Config, loadConfig } from "../config.ts";
import { readMapChanges } from "../verify/admit.ts";
import { checkLines, type FeatureLines, featureLines, testedLine, versionsLine } from "./checked.ts";
import { failureOf } from "./diagnose.ts";
import { criteriaOf, leftOutOf, qaDir, readQa, readReview, regressDir } from "./lanes.ts";
import { isCheck, type Job, prOpen } from "./machine.ts";
import { readMessages } from "./messages.ts";
import { findJob, JOB_ID, jobDirOf, writeAtomic } from "./store.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const MAX_TEXT = 6000;
const MAX_IMAGE = 3 * 1024 * 1024;

/** `named`: images by name only (a PR body: GitHub drops data: images and caps the body's size). */
function evidenceHtml(dir: string, f: string, named = false): string {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return `<p class="miss">${esc(f)}: missing</p>`;
  if (/\.(png|jpe?g)$/i.test(f)) {
    if (named) return `<p>Screenshot <code>${esc(f)}</code> (in the job's evidence folder)</p>`;
    const b = fs.readFileSync(p);
    if (b.length > MAX_IMAGE) return `<p>${esc(f)} (${Math.round(b.length / 1024)} KB, too large to inline)</p>`;
    return `<figure><img alt="${esc(f)}" src="data:image/${/png$/i.test(f) ? "png" : "jpeg"};base64,${b.toString("base64")}"><figcaption>${esc(f)}</figcaption></figure>`;
  }
  const t = fs.readFileSync(p, "utf8");
  return `<details><summary>${esc(f)}</summary><pre>${esc(t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n…` : t)}</pre></details>`;
}

/** ADR 0032 §3: a lane's file that isn't there yet is no error to show: the lane hasn't run on this round. */
const notYet = (why: string) => /ENOENT/.test(why);

/** Pure apart from reading the job folder: the Report's HTML. */
export function renderReport(repo: string, job: Job, o: { diff?: { p: string; a: number; d: number }[]; named?: boolean } = {}): string {
  const dir = jobDirOf(repo, job.id);
  const crit = criteriaOf(dir);
  const check = isCheck(job);
  const qa = readQa(dir, job.round, crit, { check });
  const review = readReview(dir, job.round);
  const qd = qaDir(dir, job.round);
  let cfg: Config | null = null;
  try {
    cfg = loadConfig(repo);
  } catch {}
  // ADR 0032 §3: a step that failed says what, the line that matters and what to do, with its raw output one click away.
  const fail = failureOf(dir, job, cfg ?? undefined);
  const fl = cfg
    ? featureLines(
        repo,
        cfg,
        job,
        o.diff?.map((f) => f.p),
      )
    : null;
  const status =
    check && job.stage === "done" && job.check?.result
      ? `${esc(job.check.result)}${job.check.onto ? ` (${esc(job.check.onto.slice(0, 7))}) · nothing changed` : ""}`
      : job.stage === "done" && job.verified
        ? `${esc(job.verified.words)}: QA passed on <code>${esc(job.branch)}</code> (${esc(job.verified.head.slice(0, 7))}); the branch stays, <code>kitchen promote ${esc(job.id)}</code> reviews and merges it`
        : job.stage === "done" && job.merged
          ? `${job.mergedBy === "person" ? `Merged by you on ${esc(job.merged.at.slice(0, 10))} into` : job.mergedBy === "github" ? `Merged on GitHub on ${esc(job.merged.at.slice(0, 10))} into` : "Merged into"} ${esc(job.merged.into)} (${esc(job.merged.sha.slice(0, 7))}${job.merged.via === "github" && job.pr ? `, PR #${job.pr.number}` : ""})`
          : prOpen(job) && job.pr
            ? `PR #${job.pr.number} open${job.target ? ` into ${esc(job.target)}` : ""} · waiting for review`
            : job.stage === "ready"
              ? fail
                ? "Ready for you"
                : `Ready for you: ${esc(job.held ?? "a person merges it")}`
              : // ADR 0032 §3: a failed step is said once, under What you must check; the header names the stage.
                `${esc(job.stage)}${!fail && job.pausedReason ? `: ${esc(job.pausedReason)}` : ""}`;
  const checks: string[] = [];
  // ADR 0029 §2: criteria QA couldn't test carry their why in their rows; the diagnosis then says what and next only.
  const rowsSayWhy = "criteria" in qa && qa.criteria.some((r) => r.result === "NOT_RUN");
  if (fail)
    checks.push(
      `<b>${esc(fail.what)}</b>${fail.line && !(fail.kind === "app" && rowsSayWhy) ? `: <code>${esc(fail.line)}</code>` : ""}<br>${esc(fail.next)}.${fail.log ? `<details><summary>Raw output (${esc(fail.log)})</summary><pre>${esc(fail.raw)}</pre></details>` : ""}`,
    );
  if (job.held && !(fail && job.stage === "ready"))
    checks.push(job.mergedBy === "person" ? `Kitchen held it for you (${esc(job.held)}); you merged it.` : esc(job.held));
  if ("findings" in review)
    for (const f of review.findings.filter((x) => !x.blocks)) checks.push(`Review note ${esc(f.id)}${f.at ? ` (${esc(f.at)})` : ""}: ${esc(f.why)}`);
  // ADR 0020: the reading was settled with you, not picked by intake.
  for (const r of job.refined ?? [])
    checks.push(
      `Refined with you on ${esc(r.at.slice(0, 10))} (${esc(r.reason)}): the criteria come from your refined ticket. Check they say what you agreed.`,
    );
  // ADR 0020: the later slices of a ticket split with you, which Kitchen filed as their own tickets.
  if (job.slices?.length)
    checks.push(
      `Split with you: the rest is filed as ${job.slices.map((x) => `${esc(JOB_ID.exec(x.id)?.[1] ?? x.id)} “${esc(titleOf(repo, x.id) ?? x.text)}”`).join(", ")}.`,
    );
  if (job.approved) checks.push(`Criteria approved by you on ${esc(job.approved.slice(0, 10))}, before the build.`);
  const leftOut = leftOutOf(dir);
  if (leftOut) checks.push(`Left out by intake (not in your ticket; file it separately if you want it): ${esc(leftOut)}`);
  // ADR 0017 §4: every earlier check this job changed on purpose (its CHANGES: line), as it was and as it is now.
  for (const c of readMapChanges(dir))
    checks.push(`Changed earlier check (${esc(c.by)}): ${esc(c.item)}: was “${esc(c.was)}”, now ${c.now === "(removed)" ? "removed" : `“${esc(c.now)}”`}`);
  // ADR 0027 §3: the change moved on; the map didn't learn what QA wrote.
  if (job.mapSkipped)
    checks.push(`map update skipped: ${esc(job.mapSkipped)}. QA's map files are still in <code>rounds/*/qa/map/</code> of this job's folder.`);
  if (job.risk === "high" && !check) checks.push("High risk: read the diff yourself before you merge it anywhere else.");
  // ADR 0028: what a check found, each proposed in the Inbox for the person to Run, Hold or set aside.
  if ("findings" in qa && qa.findings.length)
    checks.push(
      `Found ${qa.findings.length} problem${qa.findings.length === 1 ? "" : "s"}${job.check?.proposals?.length ? `, proposed in the Inbox as ${esc(job.check.proposals.join(", "))}` : ""}: ${qa.findings.map((f) => `<b>${esc(f.title)}</b>${f.criterion ? ` (${esc(f.criterion)})` : ""}: ${esc(f.seen)}`).join("; ")}`,
    );
  if (job.check?.map) checks.push(esc(job.check.map));
  // ADR 0029 §6: the findings are kept; Kitchen proposes them again on the next wave (said once: the diagnosis above).
  if (job.check?.proposalsFailed && fail?.kind !== "proposals")
    checks.push(
      `<span class="bad">proposals failed: ${esc(job.check.proposalsFailed.error)}</span>. The findings are kept below; Kitchen proposes them again on the next wave.`,
    );
  // QA hasn't run on this round: said once, under the table, not on every row.
  const unrun = "refused" in qa && notYet(qa.refused);
  const rows = crit
    .map((c) => {
      const r = "criteria" in qa ? qa.criteria.find((x) => x.id === c.id) : undefined;
      // ADR 0029 §2: a criterion QA couldn't test is "not tested", with its why: never a fail.
      const not = r?.result === "NOT_RUN";
      return `<tr><td>${esc(c.id)}</td><td>${esc(c.text)}<br><small>${esc(c.check)}</small></td><td class="${r?.result === "PASS" ? "ok" : not || (!r && unrun) ? "st" : "bad"}">${esc(not ? "not tested" : (r?.result ?? (unrun ? "" : "not checked")))}</td><td>${esc(not ? (r?.why ?? "") : (r?.note ?? ""))}${(r?.evidence ?? []).map((f) => evidenceHtml(qd, f, o.named)).join("")}</td></tr>`;
    })
    .join("\n");
  const findings =
    "findings" in review
      ? review.findings.length
        ? `<ul>${review.findings.map((f) => `<li><b>${esc(f.id)}</b> ${f.blocks ? "blocking" : "note"}${f.at ? ` · ${esc(f.at)}` : ""}: ${esc(f.why)}</li>`).join("")}</ul>`
        : "<p>No findings.</p>"
      : notYet(review.refused)
        ? '<p class="st">Not reviewed yet.</p>'
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
<p class="st">${status} · ${esc(job.kind ?? "?")} · risk ${esc(job.risk ?? "?")} · round ${job.round} · ${check ? `checked ${esc(job.target ?? "staging")} as it is: no branch` : `branch <code>${esc(job.branch)}</code>`}</p>
<h2>What you must check</h2>
<div class="box">${checks.length ? `<ul>${checks.map((c) => `<li>${c}</li>`).join("")}</ul>` : "<p>Nothing beyond the proof below.</p>"}</div>
<h2>Criteria, checked against the running app</h2>
<table>${rows || "<tr><td>No criteria.</td></tr>"}</table>
${"refused" in qa ? (notYet(qa.refused) ? `<p class="st">QA hasn't run on round ${job.round} yet.</p>` : `<p class="bad">QA: ${esc(qa.refused)}</p>`) : ""}
${!check ? blockedHtml(qa, qd, o.named, fail?.kind === "app") : ""}
${drives(dir, job.round, o.named, fl?.none.filter((x) => fl.looked.includes(x)) ?? [])}
${
  check
    ? findingsHtml(qa, qd, o.named)
    : `<h2>Review</h2>${"summary" in review && review.summary ? `<p>${esc(review.summary)}</p>` : ""}${findings}
<h2>What changed</h2>${diff}`
}
${checkedHtml(repo, cfg, job, fl)}
${thread.length ? `<h2>Your messages</h2><ul>${thread.map((m) => `<li>${esc(m.at.slice(0, 16).replace("T", " "))} ${esc(m.kind)}: ${esc(m.text)}</li>`).join("")}</ul>` : ""}
<p class="st">Evidence files: ${esc(path.relative(repo, qd))}/</p>
</main></body></html>
`;
}

/** ADR 0029 §2: why QA couldn't test a job at all (BLOCKED), with the files it cites; "" otherwise. */
function blockedHtml(qa: ReturnType<typeof readQa>, qd: string, named = false, said = false): string {
  if (!("criteria" in qa) || !qa.blocked) return "";
  // `said`: the diagnosis above already says why and what to do (ADR 0032 §3); only the evidence is left to show.
  const ev = (qa.evidence ?? []).map((f) => evidenceHtml(qd, f, named)).join("");
  if (said) return ev ? `<h2>QA's evidence</h2>${ev}` : "";
  return `<h2>QA couldn't test it</h2><p>${esc(qa.blocked ?? "")}</p>${ev}<p class="st">The environment, not the change.</p>`;
}

/** ADR 0028: a check's problems, each as the proposed bug (what was seen, the repro, the evidence). */
function findingsHtml(qa: ReturnType<typeof readQa>, qd: string, named = false): string {
  if (!("findings" in qa)) return "";
  if (qa.blocked) return `<h2>The check couldn't run</h2><p class="st">${esc(qa.blocked)}</p>`;
  if (!qa.findings.length) return "<h2>Problems found</h2><p>None.</p>";
  return `<h2>Problems found</h2>${qa.findings
    .map(
      (f) =>
        `<h3>${esc(f.title)}${f.criterion ? ` <small>(${esc(f.criterion)})</small>` : ""}</h3><p>${esc(f.seen)}</p><ol>${f.repro.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>${f.evidence.map((e) => evidenceHtml(qd, e, named)).join("")}`,
    )
    .join("")}`;
}

function titleOf(repo: string, id: string): string | null {
  try {
    return findJob(repo, id).title;
  } catch {
    return null;
  }
}

/** ADR 0017 §3: the touched features driven on the trial merge before it landed, newest round first. */
function drives(dir: string, round: number, named = false, looked: string[] = []): string {
  for (let r = round; r >= 1; r--) {
    const f = path.join(regressDir(dir, r), "verdict.json");
    if (!fs.existsSync(f)) continue;
    try {
      const v = JSON.parse(fs.readFileSync(f, "utf8")) as { features?: { id: string; result: string; note?: string; evidence?: string[] }[] };
      // ADR 0032 §4: "no recipe, looked at only" is said once, under What was checked; another note stays.
      const noted = (x: { id: string; note?: string }) => {
        const n = String(x.note ?? "");
        return looked.includes(String(x.id)) && /no recipe|looked at/i.test(n) ? "" : n;
      };
      const rows = (v.features ?? [])
        .map(
          (x) =>
            `<tr><td>${esc(String(x.id))}</td><td class="${String(x.result).toUpperCase() === "PASS" ? "ok" : "bad"}">${esc(String(x.result))}</td><td>${esc(noted(x))}${(x.evidence ?? []).map((e) => evidenceHtml(regressDir(dir, r), String(e), named)).join("")}</td></tr>`,
        )
        .join("");
      return `<h2>Features driven before the merge (round ${r})</h2><p class="st">Kitchen chose them from the verify map: their <code>Code:</code> covers files this merge changed.</p><table>${rows}</table>`;
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * ADR 0032 §4: what the proof stands on: what QA tested and with which versions, each kitchen.yaml check (ran, off,
 * or missing for a language the repo has), and the verify map against the change. A job from before ADR 0032 has no
 * `tested`: those lines are left out.
 */
function checkedHtml(repo: string, cfg: Config | null, job: Job, f: FeatureLines | null): string {
  const dir = jobDirOf(repo, job.id);
  const tested = testedLine(job);
  const versions = versionsLine(job);
  const mark = { ok: "✓", bad: "✗", wait: "·", off: "–", none: "!", unknown: "?" } as const;
  const cls = { ok: "ok", bad: "bad", wait: "st", off: "st", none: "bad", unknown: "st" } as const;
  const items = [tested ? `<li>${esc(tested)}</li>` : "", versions ? `<li class="st">${esc(versions)}</li>` : ""].join("");
  if (!cfg)
    return `<h2>What was checked</h2>${items ? `<ul>${items}</ul>` : ""}<p class="bad">kitchen.yaml couldn't be read: which checks ran and what the verify map covers aren't known.</p>`;
  const rows = !isCheck(job) ? checkLines(cfg, dir, job, repo) : [];
  const checks = rows.length
    ? `<table>${rows.map((c) => `<tr><td class="${cls[c.st]}">${mark[c.st]}</td><td>${esc(c.name)}</td><td class="${c.st === "none" ? "bad" : "st"}">${esc(c.note)}</td></tr>`).join("")}</table>`
    : isCheck(job)
      ? ""
      : '<p class="bad">No checks in kitchen.yaml: nothing ran on the code itself.</p>';
  const map = f
    ? `<ul>${f.recipe.length ? `<li>With a recipe in the verify map (QA drives them): ${f.recipe.map((x) => `<code>${esc(x)}</code>`).join(", ")}</li>` : ""}${f.none.map((x) => (f.looked.includes(x) ? `<li class="st">no recipe: <code>${esc(x)}</code>: looked at only, not driven step by step</li>` : `<li class="bad">no recipe: <code>${esc(x)}</code>: not driven</li>`)).join("")}${
        f.unmapped.length
          ? `<li class="st">Not on the verify map: ${f.unmapped.length} changed file${f.unmapped.length === 1 ? "" : "s"} (${f.unmapped
              .slice(0, 4)
              .map((x) => `<code>${esc(x)}</code>`)
              .join(", ")}${f.unmapped.length > 4 ? ", …" : ""})</li>`
          : ""
      }</ul>`
    : "";
  if (!items && !checks && !map) return "";
  return `<h2>What was checked</h2>${items ? `<ul>${items}</ul>` : ""}${checks}${map}`;
}

/** GitHub's cap on a PR body is 65,536 characters. */
const PR_BODY_MAX = 60_000;

/**
 * ADR 0026 §4: the Report as a PR body: its <main> (GitHub renders the HTML, drops the page's styles), screenshots
 * named rather than inlined, cut to fit GitHub's limit.
 */
export function prReport(repo: string, job: Job, diff?: { p: string; a: number; d: number }[]): string {
  const html = renderReport(repo, job, { diff, named: true });
  const main = /<main>([\s\S]*)<\/main>/.exec(html)?.[1]?.trim() ?? "";
  return main.length > PR_BODY_MAX ? `${main.slice(0, PR_BODY_MAX)}\n\n…(cut: the full Report is report.html in the job's folder)` : main;
}

export function writeReport(repo: string, job: Job, o: { diff?: { p: string; a: number; d: number }[] } = {}): string {
  const f = path.join(jobDirOf(repo, job.id), "report.html");
  writeAtomic(f, renderReport(repo, job, o));
  return f;
}
