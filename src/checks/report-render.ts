// report-render (PLAN §2 "Report"). Pure: no files, no git, no clock.
//
// The report role writes report.src.html: HTML sections, citing proof only as
// {{e<N>}}. The renderer
// - refuses an unknown id, an id not stamped for the final HEAD, and any other
//   {{…}} placeholder;
// - refuses a source without `<section id="summary">`, and, on a path where a human
//   must look (`human: always`), one without `<section id="human-check">`, which
//   then opens the report;
// - strips what a published page must not run or load (scripts, frames, forms,
//   event handlers, javascript: and remote URLs);
// - inlines every cited entry (screenshots as data: URIs, text output as <pre>),
//   so report.html is one self-contained file;
// - adds the engine's own sections from facts it was handed (never from what the
//   agent wrote): requirement → criteria → verdict → evidence, review findings,
//   seed/migration diff, cost and time per stage.
// It also writes the PR comment (`prComment`): the per-criterion table and a link.

export type ReportEntry = {
  id: string;
  sha: string;
  round: number;
  criterion: string;
  role?: unknown;
  cmd: string;
  exit: number;
  files: { path: string }[];
  phase?: unknown;
};

export type CriterionRow = {
  id: string;
  text: string;
  covers: string[];
  decidedBy: "engine" | "verifier";
  result: string;
  why?: string;
  evidence: string[];
  nonDiscriminating: boolean;
};
export type RequirementRow = { id: string; text: string; negative: boolean; outOfScope: boolean };
export type FindingRow = {
  id: string;
  lenses: string[];
  blocks: boolean;
  confidence: string;
  where: string;
  title: string;
  why: string;
  downgraded?: string;
  dismissed?: string;
};
export type StageCost = { stage: string; round: number; secs: number; usd: number; roles: string };

export type ReportFacts = {
  job: { id: string; title: string; kind: string; risk: string; round: number; pr: number | null; branch: string };
  head: string;
  verdict: string;
  /** `human: always` on the job's risk path: the report must open with what a human must check. */
  humanMustCheck: boolean;
  requirements: RequirementRow[];
  criteria: CriterionRow[];
  review: { lenses: string[]; findings: FindingRow[]; blockingRounds: number };
  /** seed-diff.md and the patch of those files, or null. */
  seeds: { files: string[]; patch: string } | null;
  costs: StageCost[];
  argsDeltas: string[];
};

export type RenderInput = {
  src: string;
  facts: ReportFacts;
  /** The verified manifest. */
  entries: ReportEntry[];
  /** An evidence file's bytes (relative to evidence/), or null. */
  file: (rel: string) => Buffer | null;
};

const ID = /\{\{\s*(e\d+)\s*\}\}/g;
const ANY = /\{\{([\s\S]*?)\}\}/g;

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A stamped command as a person reads it: `bin/dev login --id=… --src=… --out=… --as=alice` → `login --as=alice`. Pure. */
export function shortCmd(cmd: string): string {
  return cmd
    .replace(/^\S*bin\/dev\s+/, "")
    .replace(/\s--(id|src|out|ports)=(?:'[^']*'|\S+)/g, "")
    .trim();
}

/** Ids the source cites, in order, once each. */
export function citedIds(src: string): string[] {
  return [...new Set([...src.matchAll(ID)].map((m) => m[1]))];
}

/** Why the source can't be rendered for `head`, or null. */
export function renderRefusal(src: string, entries: Pick<ReportEntry, "id" | "sha">[], head: string, humanMustCheck: boolean): string | null {
  const other = [...src.matchAll(ANY)].map((m) => m[1].trim()).filter((x) => !/^e\d+$/.test(x));
  if (other.length) return `unknown placeholder {{${other[0]}}}: cite evidence only as {{e<N>}}`;
  const ids = citedIds(src);
  const unknown = ids.filter((id) => !entries.some((e) => e.id === id));
  if (unknown.length) return `unknown evidence id ${unknown.join(", ")}`;
  const stale = ids.filter((id) => entries.find((e) => e.id === id)?.sha !== head);
  if (stale.length) return `evidence ${stale.join(", ")} is not stamped for the final HEAD ${head.slice(0, 8)}`;
  if (!sectionOf(src, "summary")) return 'no <section id="summary">';
  if (humanMustCheck && !sectionOf(src, "human-check"))
    return 'this is a human: always path: the report must open with <section id="human-check"> (what a human must check)';
  return null;
}

/** The inner HTML of `<section id="<id>">…</section>`, or null. */
export function sectionOf(src: string, id: string): string | null {
  const m = new RegExp(`<section\\b[^>]*\\bid\\s*=\\s*["']?${id}["']?[^>]*>([\\s\\S]*?)</section>`, "i").exec(src);
  return m ? m[1] : null;
}

/** Strip what a published page must not run or load. Not a general HTML sanitizer: the input is one agent's fragment, and the page is static. */
export function sanitize(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|template|noscript|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|frame|frameset|template|noscript|svg|math)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(src|srcset|href|action|formaction|xlink:href|style)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr: string, v: string) => {
      const val = v.replace(/^["']|["']$/g, "").trim();
      // In-page anchors only: a published report loads nothing and runs nothing.
      return attr.toLowerCase() === "href" && /^#[\w-]+$/.test(val) ? m : "";
    });
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const ext = (p: string) => p.split(".").pop()?.toLowerCase() ?? "";
const isImage = (p: string) => ext(p) in MIME;

function dataUri(rel: string, file: RenderInput["file"]): string | null {
  const b = file(rel);
  return b ? `data:${MIME[ext(rel)]};base64,${b.toString("base64")}` : null;
}

/** A short inline citation: a thumbnail for a screenshot, else the id as a link to the appendix. */
function cite(e: ReportEntry, file: RenderInput["file"]): string {
  const img = e.files.find((f) => isImage(f.path));
  const uri = img ? dataUri(img.path, file) : null;
  return uri
    ? `<a class="ev-thumb" href="#ev-${e.id}" title="${esc(`${e.id} · ${e.criterion} · ${shortCmd(e.cmd)}`)}"><img src="${uri}" alt="${e.id}"><span>${e.id}</span></a>`
    : `<a class="ev" href="#ev-${e.id}" title="${esc(`${e.criterion} · ${shortCmd(e.cmd)}`)}">${e.id}</a>`;
}

const TEXT_FILES = ["stdout.txt", "out.txt", "stderr.txt", "call.json"];
function appendix(e: ReportEntry, file: RenderInput["file"]): string {
  const imgs = e.files.filter((f) => isImage(f.path));
  const texts = e.files
    .filter((f) => !isImage(f.path))
    .sort((a, b) => TEXT_FILES.indexOf(a.path.split("/").pop() ?? "") - TEXT_FILES.indexOf(b.path.split("/").pop() ?? ""))
    .slice(0, 2);
  const body = [
    ...imgs.map((f) => {
      const uri = dataUri(f.path, file);
      return uri ? `<img class="full" src="${uri}" alt="${esc(f.path)}">` : `<p class="muted">${esc(f.path)} (missing)</p>`;
    }),
    ...texts.map((f) => {
      const b = file(f.path);
      const t = b ? b.toString("utf8") : "(missing)";
      return `<p class="muted">${esc(f.path)}</p><pre>${esc(t.length > 4000 ? `${t.slice(0, 4000)}\n… (${t.length - 4000} more characters on the evidence branch)` : t)}</pre>`;
    }),
  ].join("\n");
  return `<details id="ev-${e.id}"><summary><b>${e.id}</b> · ${esc(e.criterion)} · ${esc(String(e.role ?? ""))} · <code>${esc(shortCmd(e.cmd))}</code> · exit ${e.exit} · ${e.sha.slice(0, 8)} r${e.round}</summary>${body}</details>`;
}

const badge = (r: string) => `<span class="badge ${/PASS/.test(r) ? "ok" : /FAIL|BLOCK/.test(r) ? "bad" : "warn"}">${esc(r)}</span>`;

function requirementsSection(f: ReportFacts, byId: Map<string, ReportEntry>, file: RenderInput["file"]): string {
  const rows = f.requirements.map((r) => {
    const cs = f.criteria.filter((c) => c.covers.includes(r.id));
    const head = `<tr class="req"><th colspan="4">${r.id}${r.negative ? " <em>(negative)</em>" : ""}${r.outOfScope ? " <em>(out of scope)</em>" : ""}: ${esc(r.text)}</th></tr>`;
    if (r.outOfScope) return head;
    if (!cs.length) return `${head}<tr><td colspan="4" class="muted">no criterion covers it</td></tr>`;
    return (
      head +
      cs
        .map(
          (c) =>
            `<tr><td><b>${c.id}</b> ${esc(c.text)}${c.nonDiscriminating ? '<br><span class="badge warn">NON-DISCRIMINATING</span> <span class="muted">already held on the base: this PASS says nothing about the change</span>' : ""}</td><td>${c.decidedBy}</td><td>${badge(c.result)}${c.why ? `<br><span class="muted">${esc(c.why)}</span>` : ""}</td><td class="ev-cell">${c.evidence
              .map((id) => byId.get(id))
              .filter((e): e is ReportEntry => !!e)
              .map((e) => cite(e, file))
              .join(" ")}</td></tr>`,
        )
        .join("")
    );
  });
  const orphan = f.criteria.filter((c) => !c.covers.length || c.covers.every((x) => !f.requirements.some((r) => r.id === x)));
  return `<section id="proof"><h2>Requirements and proof</h2><p class="muted">Every requirement intake read in the ticket, the criteria that prove it, who decided each (the engine for mechanical expects, the verifier for judged ones) and the stamped evidence.</p><table><thead><tr><th>criterion</th><th>decided by</th><th>result</th><th>evidence</th></tr></thead><tbody>${rows.join("")}${orphan
    .map((c) => `<tr><td><b>${c.id}</b> ${esc(c.text)}</td><td>${c.decidedBy}</td><td>${badge(c.result)}</td><td>${c.evidence.join(" ")}</td></tr>`)
    .join(
      "",
    )}</tbody></table>${f.argsDeltas.length ? `<p class="muted">Drive args changed from the spec:</p><ul>${f.argsDeltas.map((d) => `<li><code>${esc(d)}</code></li>`).join("")}</ul>` : ""}</section>`;
}

function reviewSection(f: ReportFacts): string {
  const r = f.review;
  const blocking = r.findings.filter((x) => x.blocks);
  const rows = r.findings.map(
    (x) =>
      `<tr><td>${esc(x.id)}</td><td>${esc(x.lenses.join(", "))}</td><td>${x.blocks ? badge("BLOCKED") : "note"}</td><td>${esc(x.confidence)}</td><td><code>${esc(x.where)}</code></td><td><b>${esc(x.title)}</b>${x.why ? `<br>${esc(x.why)}` : ""}${x.downgraded ? `<br><span class="muted">kept as a note: ${esc(x.downgraded)}</span>` : ""}${x.dismissed ? `<br><span class="muted">dismissed: ${esc(x.dismissed)}</span>` : ""}</td></tr>`,
  );
  return `<section id="review"><h2>Review</h2><p>Lenses: ${esc(r.lenses.join(", ") || "none on this path")}. ${
    r.blockingRounds ? `Review sent the job back to build ${r.blockingRounds} time(s); the findings below are from the last round. ` : ""
  }${blocking.length ? `<b>${blocking.length} blocking</b>, ` : ""}${r.findings.length - blocking.length} note(s). A finding blocks only when it is demonstrable (a line at HEAD, a requirement, stamped evidence) and not low confidence.</p>${
    rows.length
      ? `<table><thead><tr><th>id</th><th>lens</th><th></th><th>confidence</th><th>where</th><th>finding</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
      : ""
  }</section>`;
}

function seedsSection(f: ReportFacts): string {
  if (!f.seeds) return "";
  return `<section id="seeds"><h2>Seed data and migrations</h2><p>This change touches what every proof's app is built from: ${f.seeds.files.map((x) => `<code>${esc(x)}</code>`).join(", ")}. Check nothing here seeds an answer a proof reads.</p><pre class="diff">${esc(f.seeds.patch)}</pre></section>`;
}

function costSection(f: ReportFacts): string {
  const t = f.costs.reduce((a, c) => ({ secs: a.secs + c.secs, usd: a.usd + c.usd }), { secs: 0, usd: 0 });
  const mm = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
  return `<section id="cost"><h2>Cost and time</h2><table><thead><tr><th>stage</th><th>round</th><th>time</th><th>cost</th><th>agents</th></tr></thead><tbody>${f.costs
    .map((c) => `<tr><td>${esc(c.stage)}</td><td>${c.round}</td><td>${mm(c.secs)}</td><td>$${c.usd.toFixed(3)}</td><td class="muted">${esc(c.roles)}</td></tr>`)
    .join("")}<tr class="total"><td>total</td><td></td><td>${mm(t.secs)}</td><td>$${t.usd.toFixed(3)}</td><td></td></tr></tbody></table></section>`;
}

const CSS = `
:root{--bg:#fbfaf8;--fg:#1d1d1f;--muted:#6b6b70;--line:#e4e2dd;--card:#fff;--ok:#1f7a4d;--okb:#e6f4ec;--bad:#b42318;--badb:#fdecea;--warn:#8a5a00;--warnb:#fff4d6;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--line:#2c2c31;--card:#1c1c1f;--okb:#12301f;--badb:#3a1512;--warnb:#3a2c0b;--ok:#6fd39b;--bad:#ff8a7a;--warn:#f2c14e;--accent:#8ea2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 20px 64px}h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}h2{font-size:18px;margin:36px 0 10px;padding-top:8px;border-top:1px solid var(--line)}
.meta{color:var(--muted);font-size:13px}.meta code{color:var(--fg)}section{margin:0}.lead{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 20px 14px;margin-top:20px}
#human-check{border-left:4px solid var(--bad)}#human-check h2{border:0;margin-top:14px;color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:14px;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
tr.req th{background:var(--bg);font-weight:600}tr.total td{font-weight:600}.muted{color:var(--muted);font-size:13px}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px}.badge.ok{background:var(--okb);color:var(--ok)}.badge.bad{background:var(--badb);color:var(--bad)}.badge.warn{background:var(--warnb);color:var(--warn)}
a{color:var(--accent)}a.ev{font-family:ui-monospace,Menlo,monospace;font-size:13px}a.ev-thumb{display:inline-flex;flex-direction:column;align-items:center;margin:2px 4px;text-decoration:none;font-size:11px;font-family:ui-monospace,Menlo,monospace}
a.ev-thumb img{width:120px;max-height:90px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:6px;background:#fff}
img.full{max-width:100%;border:1px solid var(--line);border-radius:6px;margin:8px 0;background:#fff}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;font-size:12px;max-height:420px}pre.diff{max-height:520px}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:6px 0}summary{cursor:pointer;font-size:13px}code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}
`;

/** report.html, or why not. */
export function renderReport(i: RenderInput): { html: string; cited: string[] } | { refusal: string } {
  const f = i.facts;
  const why = renderRefusal(i.src, i.entries, f.head, f.humanMustCheck);
  if (why) return { refusal: why };
  const byId = new Map(i.entries.map((e) => [e.id, e]));
  const clean = sanitize(i.src);
  const inline = (html: string) => html.replace(ID, (_m, id: string) => cite(byId.get(id) as ReportEntry, i.file));
  const part = (id: string, title: string, cls = "") => {
    const s = sectionOf(clean, id);
    return s === null ? "" : `<section id="${id}" class="${cls}">${/<h2\b/i.test(s) ? "" : `<h2>${title}</h2>`}${inline(s)}</section>`;
  };
  const known = ["human-check", "summary", "changes", "notes"];
  const rest = clean
    .replace(/<section\b[^>]*\bid\s*=\s*["']?([\w-]+)["']?[^>]*>[\s\S]*?<\/section>/gi, (m, id: string) => (known.includes(id) ? "" : m))
    .trim();
  const engineCited = f.criteria.flatMap((c) => c.evidence).filter((id) => byId.has(id));
  const cited = [...new Set([...citedIds(i.src), ...engineCited])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const j = f.job;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Kitchen report: ${esc(j.title)}</title><style>${CSS}</style></head>
<body><main>
<header><p class="meta">Kitchen report · <code>${esc(j.id)}</code> · ${esc(j.kind)} · risk ${esc(j.risk)} · round ${j.round} · HEAD <code>${f.head.slice(0, 10)}</code>${j.pr !== null ? ` · PR #${j.pr}` : ""} · branch <code>${esc(j.branch)}</code></p>
<h1>${esc(j.title)}</h1><p>Verdict ${badge(f.verdict)} ${f.review.findings.some((x) => x.blocks) ? badge("REVIEW BLOCKING") : badge("REVIEW PASS")}${f.humanMustCheck ? ` ${badge("HUMAN REVIEW REQUIRED")}` : ""}</p></header>
${f.humanMustCheck ? part("human-check", "What a human must check", "lead") : ""}
${part("summary", "Summary", f.humanMustCheck ? "" : "lead")}
${part("changes", "What changed")}
${f.humanMustCheck ? "" : part("human-check", "What a human must check")}
${requirementsSection(f, byId, i.file)}
${reviewSection(f)}
${seedsSection(f)}
${part("notes", "Notes")}
${rest ? `<section id="more">${inline(rest)}</section>` : ""}
${costSection(f)}
<section id="evidence"><h2>Evidence</h2><p class="muted">Every entry cited above, as stamped in the job's hash-chained manifest (sha, round, criterion, who ran it). The full folder is on the <code>kitchen-evidence</code> branch.</p>${cited
    .map((id) => appendix(byId.get(id) as ReportEntry, i.file))
    .join("\n")}</section>
</main></body></html>
`;
  return { html, cited };
}

/** The PR comment: the per-criterion table and a link to the published report. Markdown. */
export function prComment(f: ReportFacts, o: { url: string; entries: ReportEntry[] }): string {
  const byId = new Map(o.entries.map((e) => [e.id, e]));
  const shot = (id: string) => byId.get(id)?.files.find((x) => isImage(x.path))?.path;
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const blocking = f.review.findings.filter((x) => x.blocks).length;
  /** Screenshots first (linked into the published folder, up to 3), then a count of the other entries. */
  const evidenceCell = (ids: string[]) => {
    const shots = ids.filter((id) => shot(id));
    const rest = ids.length - Math.min(shots.length, 3);
    const linked = shots.slice(0, 3).map((id) => `[${id}](${o.url}evidence/${shot(id)})`);
    const plain = shots.length ? [] : ids.slice(0, 3);
    const more = rest - plain.length;
    return [...linked, ...plain, ...(more > 0 ? [`+${more} more`] : [])].join(" ");
  };
  return [
    `### Kitchen report: ${f.job.title}`,
    "",
    `**Verdict ${f.verdict}** · ${f.job.kind} · risk ${f.job.risk} · round ${f.job.round} · HEAD \`${f.head.slice(0, 10)}\``,
    ...(f.humanMustCheck ? ["", "**Human review required** (`kitchen:review-required`): the report opens with what a human must check."] : []),
    "",
    "| criterion | covers | decided by | result | evidence |",
    "|---|---|---|---|---|",
    ...f.criteria.map(
      (c) =>
        `| ${c.id} ${cell(c.text)}${c.nonDiscriminating ? " (NON-DISCRIMINATING)" : ""} | ${c.covers.join(", ")} | ${c.decidedBy} | ${c.result} | ${evidenceCell(c.evidence)} |`,
    ),
    "",
    `Review (${f.review.lenses.join(", ") || "no lenses"}): ${blocking} blocking, ${f.review.findings.length - blocking} note(s).`,
    "",
    `Full report: ${o.url}report.html`,
  ].join("\n");
}
