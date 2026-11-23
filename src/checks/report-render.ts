// report-render (PLAN §2 "Report"). Pure: no files, no git, no clock.
//
// The report role writes report.src.html: HTML sections, citing proof only as
// {{e<N>}}. The renderer
// - refuses an unknown id, an id not stamped for the final HEAD, and any other
//   {{…}} placeholder;
// - refuses a source without `<section id="summary">`, and, on a path where a human
//   must look (`human: always`), one without `<section id="human-check">`, which
//   then opens the report;
// - keeps only an allow-list of tags and attributes (sanitize: a small tokenizer,
//   not regex stripping): no scripts, styles, media, frames, handlers or links out;
//   images come only from the engine's own {{e<N>}} citations;
// - warns (in the page) when the text cites an id that no verdict row or view cites;
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
  /** Findings of other lenses (or the same) on the same line, merged into this one. */
  members?: { id: string; lens: string; title: string; why: string }[];
};
export type StageCost = { stage: string; round: number; secs: number; usd: number; roles: string };

export type ReportFacts = {
  job: { id: string; title: string; kind: string; risk: string; round: number; pr: number | null; branch: string };
  head: string;
  verdict: string;
  /** `human: always` on the job's risk path: the report must open with what a human must check. */
  humanMustCheck: boolean;
  /** The job ran without a Toolkit (ADR 0010): proven by checks and tests only, no app driven. */
  noToolkit?: boolean;
  requirements: RequirementRow[];
  criteria: CriterionRow[];
  /** `earlier`: what blocked in earlier rounds (the findings that sent the job back to build), oldest first. */
  review: { lenses: string[]; findings: FindingRow[]; blockingRounds: number; earlier?: (FindingRow & { round: number })[] };
  /** seed-diff.md and the patch of those files, or null. */
  seeds: { files: string[]; patch: string } | null;
  costs: StageCost[];
  argsDeltas: string[];
  /** Role skills (ADR 0014), per role in run order: each skill quoted into its prompt (sha256 pinned), the optional ones it went without. */
  skills?: {
    role: string;
    used: { name: string; sha256: string; chars: number; of: number; truncated: boolean }[];
    leftOut: string[];
    skipped: string[];
    degraded: boolean;
  }[];
};

export type RenderInput = {
  src: string;
  facts: ReportFacts;
  /** The verified manifest. */
  entries: ReportEntry[];
  /** An evidence file's bytes (relative to evidence/), or null. */
  file: (rel: string) => Buffer | null;
  /** Ids the report may cite as proof (the verdict's and the views'); a cited id outside them is rendered with a warning. */
  citable?: readonly string[];
};

/** Cited ids that are stamped for HEAD but that no verdict row or view cites (a builder's self-check, a drives-stage run): context, not proof. Pure. */
export function citationWarnings(src: string, entries: Pick<ReportEntry, "id" | "role" | "criterion">[], citable: readonly string[]): string[] {
  return citedIds(sanitize(src))
    .filter((id) => !citable.includes(id))
    .map((id) => {
      const e = entries.find((x) => x.id === id);
      return `${id}${e ? ` (${String(e.role ?? "?")}, ${e.criterion})` : ""} is cited but no verdict row or view cites it: context, not proof`;
    });
}

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

/** Why the source can't be rendered for `head`, or null. Judged on the sanitized source: what the page will show (a section hidden in a comment doesn't count). */
export function renderRefusal(raw: string, entries: Pick<ReportEntry, "id" | "sha">[], head: string, humanMustCheck: boolean): string | null {
  const src = sanitize(raw);
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

/** Tags an agent's fragment may keep. Everything else is dropped; images come only from the engine ({{e<N>}}). */
const ALLOWED = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "strong",
  "em",
  "b",
  "i",
  "code",
  "pre",
  "blockquote",
  "a",
  "section",
  "div",
  "span",
]);
const VOID = new Set(["br"]);
/** Dropped with everything inside them (what they hold is code, media or a document of its own). */
const DROP_CONTENT = new Set([
  "script",
  "style",
  "svg",
  "math",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "template",
  "noscript",
  "noembed",
  "noframes",
  "video",
  "audio",
  "picture",
  "canvas",
  "title",
  "textarea",
  "select",
  "head",
  "xmp",
  "plaintext",
]);
const CLASS = /^[\w -]{1,80}$/;
/** The attributes an allowed tag may keep, and the values each may have. */
function keepAttr(tag: string, name: string, value: string): boolean {
  if (tag === "a" && name === "href") return /^#[\w-]+$/.test(value); // in-page anchors only
  if (tag === "section" && name === "id") return /^[\w-]+$/.test(value);
  if ((tag === "section" || tag === "div" || tag === "span") && name === "class") return CLASS.test(value);
  if ((tag === "td" || tag === "th") && (name === "colspan" || name === "rowspan")) return /^\d{1,2}$/.test(value);
  return false;
}

/** Character references in an attribute value, decoded (so `&#35;x` is checked as `#x`). */
function decodeRefs(v: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", num: "#" };
  return v.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, r: string) => {
    if (r[0] === "#") {
      const c = r[1] === "x" || r[1] === "X" ? Number.parseInt(r.slice(2), 16) : Number(r.slice(1));
      return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : "";
    }
    return named[r.toLowerCase()] ?? m;
  });
}

/**
 * The agent's fragment through an allow-list, by a small HTML tokenizer (the way a browser reads tags:
 * `/` separates attributes like a space, a value may be quoted or bare, comments and `<!…>` vanish).
 * Kept: the tags in ALLOWED with only the attributes keepAttr allows; dropped: every other tag (its text
 * stays), and DROP_CONTENT tags with what they hold. Text keeps its entities; a stray `<` becomes `&lt;`.
 * Open tags are closed at the end and a close tag that closes nothing is dropped, so the fragment can't
 * swallow the engine's sections. The page is static and its CSP loads nothing; this is what an agent can put in it.
 */
export function sanitize(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  const n = html.length;
  const text = (t: string) => t.replace(/>/g, "&gt;");
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(text(html.slice(i)));
      break;
    }
    out.push(text(html.slice(i, lt)));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const e = html.indexOf("-->", i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const e = html.indexOf(">", i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(html.slice(i, i + 80));
    if (!m) {
      out.push("&lt;");
      i++;
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    // Attributes, as a browser splits them.
    let j = i + m[0].length;
    const attrs: [string, string][] = [];
    for (;;) {
      while (j < n && /[\s/]/.test(html[j])) j++;
      if (j >= n || html[j] === ">") break;
      let name = html[j] === "=" ? "=" : "";
      if (name) j++;
      while (j < n && !/[\s/>=]/.test(html[j])) name += html[j++];
      let k = j;
      while (k < n && /\s/.test(html[k])) k++;
      let value = "";
      if (html[k] === "=") {
        k++;
        while (k < n && /\s/.test(html[k])) k++;
        const q = html[k];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, k + 1);
          value = html.slice(k + 1, e < 0 ? n : e);
          k = e < 0 ? n : e + 1;
        } else while (k < n && !/[\s>]/.test(html[k])) value += html[k++];
        j = k;
      }
      attrs.push([name.toLowerCase(), decodeRefs(value).trim()]);
    }
    if (j >= n) break; // a tag never closed: a browser drops it with the rest
    i = j + 1;
    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at >= 0) while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (DROP_CONTENT.has(tag)) {
      const end = new RegExp(`</${tag}[\\s/>]`, "i").exec(html.slice(i));
      if (!end) {
        i = n;
        continue;
      }
      const gt = html.indexOf(">", i + end.index);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (!ALLOWED.has(tag)) continue;
    const kept = attrs.filter(([k, v], x) => keepAttr(tag, k, v) && attrs.findIndex(([k2]) => k2 === k) === x);
    out.push(`<${tag}${kept.map(([k, v]) => ` ${k}="${esc(v)}"`).join("")}>`);
    if (!VOID.has(tag)) open.push(tag);
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("");
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

const badge = (r: string) =>
  r === "NO-TOOLKIT"
    ? '<span class="badge warn">NOT PROVEN (NO TOOLKIT)</span>'
    : `<span class="badge ${/PASS/.test(r) ? "ok" : /FAIL|BLOCK/.test(r) ? "bad" : "warn"}">${esc(r)}</span>`;

/** What a job without a Toolkit can claim (ADR 0010), in the page and the PR comment. */
export const NO_TOOLKIT_CLAIM =
  "Proven by checks and tests only: no app was driven, because this repository has no Toolkit yet. Criteria that need the running app are marked not proven (no Toolkit), never passed. `kitchen toolkit build` teaches Kitchen to drive the app.";

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
      `<tr><td>${esc(x.id)}</td><td>${esc(x.lenses.join(", "))}</td><td>${x.blocks ? badge("BLOCKED") : "note"}</td><td>${esc(x.confidence)}</td><td><code>${esc(x.where)}</code></td><td><b>${esc(x.title)}</b>${x.why ? `<br>${esc(x.why)}` : ""}${(x.members ?? []).map((m) => `<br><span class="muted">+ ${esc(m.id)} (${esc(m.lens)}):</span> ${esc(m.title)}${m.why ? `: ${esc(m.why)}` : ""}`).join("")}${x.downgraded ? `<br><span class="muted">kept as a note: ${esc(x.downgraded)}</span>` : ""}${x.dismissed ? `<br><span class="muted">dismissed: ${esc(x.dismissed)}</span>` : ""}</td></tr>`,
  );
  return `<section id="review"><h2>Review</h2><p>Lenses: ${esc(r.lenses.join(", ") || "none on this path")}. ${
    r.blockingRounds ? `Review sent the job back to build ${r.blockingRounds} time(s); the findings below are from the last round. ` : ""
  }${blocking.length ? `<b>${blocking.length} blocking</b>, ` : ""}${r.findings.length - blocking.length} note(s). A finding blocks only when it is demonstrable (a line at HEAD, a requirement, stamped evidence) and not low confidence.</p>${
    rows.length
      ? `<table><thead><tr><th>id</th><th>lens</th><th></th><th>confidence</th><th>where</th><th>finding</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
      : ""
  }${
    r.earlier?.length
      ? `<p class="muted">What blocked earlier rounds (the builder fixed these, then review ran again):</p><ul>${r.earlier
          .map(
            (x) =>
              `<li>round ${x.round} · <code>${esc(x.id)}</code> ${esc(x.lenses.join("+"))} · <code>${esc(x.where)}</code> · <b>${esc(x.title)}</b>${x.why ? `: ${esc(x.why)}` : ""}${x.dismissed ? ` <span class="muted">(dismissed: ${esc(x.dismissed)})</span>` : ""}</li>`,
          )
          .join("")}</ul>`
      : ""
  }</section>`;
}

function seedsSection(f: ReportFacts): string {
  if (!f.seeds) return "";
  return `<section id="seeds"><h2>Seed data and migrations</h2><p>This change touches what every proof's app is built from: ${f.seeds.files.map((x) => `<code>${esc(x)}</code>`).join(", ")}. Check nothing here seeds an answer a proof reads.</p><pre class="diff">${esc(f.seeds.patch)}</pre></section>`;
}

/** "Skills used", one line per role that ran: the skills quoted into its prompt, pinned by sha256. Pure. */
export function skillsSection(f: Pick<ReportFacts, "skills">): string {
  if (!f.skills?.length) return "";
  const used = (u: NonNullable<ReportFacts["skills"]>[number]["used"][number]) =>
    `<code>${esc(u.name)}</code> <span class="muted">${esc(u.sha256.slice(0, 12))}${u.truncated ? `, cut at ${u.chars} of ${u.of} characters` : ""}</span>`;
  const rows = f.skills.map(
    (s) =>
      `<tr><td>${esc(s.role)}</td><td>${s.used.length ? s.used.map(used).join(", ") : '<span class="muted">none</span>'}${
        s.leftOut.length ? `<br><span class="muted">left out (cap): ${s.leftOut.map(esc).join(", ")}</span>` : ""
      }${s.skipped.length ? `<br><span class="muted">not found, skipped: ${s.skipped.map(esc).join(", ")}</span>` : ""}${
        s.degraded ? ` ${badge("DEGRADED")}` : ""
      }</td></tr>`,
  );
  return `<section id="skills"><h2>Skills used</h2><p class="muted">Skills are guidance quoted into a role's prompt (sha256 of the SKILL.md as used); they never decide a verdict.</p><table><thead><tr><th>role</th><th>skills</th></tr></thead><tbody>${rows.join("")}</tbody></table></section>`;
}

export function costSection(f: Pick<ReportFacts, "costs">): string {
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
export function renderReport(i: RenderInput): { html: string; cited: string[]; warnings: string[] } | { refusal: string } {
  const f = i.facts;
  const why = renderRefusal(i.src, i.entries, f.head, f.humanMustCheck);
  if (why) return { refusal: why };
  const byId = new Map(i.entries.map((e) => [e.id, e]));
  const clean = sanitize(i.src);
  const warnings = i.citable ? citationWarnings(i.src, i.entries, i.citable) : [];
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
  const cited = [...new Set([...citedIds(clean), ...engineCited])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const j = f.job;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Kitchen report: ${esc(j.title)}</title><style>${CSS}</style></head>
<body><main>
<header><p class="meta">Kitchen report · <code>${esc(j.id)}</code> · ${esc(j.kind)} · risk ${esc(j.risk)} · round ${j.round} · HEAD <code>${f.head.slice(0, 10)}</code>${j.pr !== null ? ` · PR #${j.pr}` : ""} · branch <code>${esc(j.branch)}</code></p>
<h1>${esc(j.title)}</h1><p>Verdict ${badge(f.verdict)} ${f.review.findings.some((x) => x.blocks) ? badge("REVIEW BLOCKING") : badge("REVIEW PASS")}${f.humanMustCheck ? ` ${badge("HUMAN REVIEW REQUIRED")}` : ""}</p></header>
${f.noToolkit ? `<section id="no-toolkit" class="lead"><p><span class="badge warn">CHECKS AND TESTS ONLY</span> ${esc(NO_TOOLKIT_CLAIM).replace(/`([^`]+)`/g, "<code>$1</code>")}</p></section>` : ""}
${warnings.length ? `<section id="citation-warnings" class="lead"><p><span class="badge warn">CITATION</span> The engine checked the text's citations: ${warnings.map(esc).join("; ")}.</p></section>` : ""}
${f.humanMustCheck ? part("human-check", "What a human must check", "lead") : ""}
${part("summary", "Summary", f.humanMustCheck ? "" : "lead")}
${part("changes", "What changed")}
${f.humanMustCheck ? "" : part("human-check", "What a human must check")}
${requirementsSection(f, byId, i.file)}
${reviewSection(f)}
${seedsSection(f)}
${part("notes", "Notes")}
${rest ? `<section id="more">${inline(rest)}</section>` : ""}
${skillsSection(f)}
${costSection(f)}
<section id="evidence"><h2>Evidence</h2><p class="muted">Every entry cited above, as stamped in the job's hash-chained manifest (sha, round, criterion, who ran it). The full folder is on the <code>kitchen-evidence</code> branch.</p>${cited
    .map((id) => appendix(byId.get(id) as ReportEntry, i.file))
    .join("\n")}</section>
</main></body></html>
`;
  return { html, cited, warnings };
}

/** Marks every comment Kitchen posts, so reading PR comments back never takes Kitchen's own for a person's. */
export const KITCHEN_MARKER = "<!-- kitchen:report -->";

/** Agent or ticket text inside markdown: no images, links, autolinks, HTML or table breaks. Pure. */
export function mdText(s: string): string {
  return s
    .replace(/[\\`*_[\]()!<>|#~]/g, (c) => `\\${c}`)
    .replace(/(https?|ftp|mailto):/gi, "$1&#58;")
    .replace(/\bwww\./gi, "www&#46;")
    .replace(/\s*\n\s*/g, " ");
}

/** The PR comment: the per-criterion table and a link to the published report. Markdown. */
export function prComment(f: ReportFacts, o: { url: string; entries: ReportEntry[] }): string {
  const byId = new Map(o.entries.map((e) => [e.id, e]));
  const shot = (id: string) => byId.get(id)?.files.find((x) => isImage(x.path))?.path;
  const cell = mdText;
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
    KITCHEN_MARKER,
    `### Kitchen report: ${mdText(f.job.title)}`,
    "",
    `**Verdict ${f.verdict}** · ${f.job.kind} · risk ${f.job.risk} · round ${f.job.round} · HEAD \`${f.head.slice(0, 10)}\``,
    ...(f.humanMustCheck ? ["", "**Human review required** (`kitchen:review-required`): the report opens with what a human must check."] : []),
    ...(f.noToolkit ? ["", `**${NO_TOOLKIT_CLAIM.split(":")[0]}:**${NO_TOOLKIT_CLAIM.slice(NO_TOOLKIT_CLAIM.indexOf(":") + 1)}`] : []),
    "",
    "| criterion | covers | decided by | result | evidence |",
    "|---|---|---|---|---|",
    ...f.criteria.map(
      (c) =>
        `| ${c.id} ${cell(c.text)}${c.nonDiscriminating ? " (NON-DISCRIMINATING)" : ""} | ${c.covers.join(", ")} | ${c.decidedBy} | ${c.result === "NO-TOOLKIT" ? "not proven (no Toolkit)" : c.result} | ${evidenceCell(c.evidence)} |`,
    ),
    "",
    `Review (${f.review.lenses.join(", ") || "no lenses"}): ${blocking} blocking, ${f.review.findings.length - blocking} note(s).`,
    "",
    `Full report: ${o.url}report.html`,
  ].join("\n");
}
