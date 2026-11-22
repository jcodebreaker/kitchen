import assert from "node:assert/strict";
import { test } from "vitest";
import { KITCHEN_MARKER, mdText, prComment, type ReportEntry, type ReportFacts, renderRefusal, renderReport, sanitize, shortCmd } from "./report-render.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const entries: ReportEntry[] = [
  { id: "e1", sha: OLD, round: 1, criterion: "C1", role: "engine", cmd: "bin/dev read", exit: 0, files: [{ path: "e1/call.json" }] },
  { id: "e2", sha: HEAD, round: 2, criterion: "C1", role: "engine", cmd: "bin/dev read --target body", exit: 0, files: [{ path: "e2/call.json" }] },
  {
    id: "e3",
    sha: HEAD,
    round: 2,
    criterion: "C2",
    role: "engine",
    cmd: "bin/dev screenshot",
    exit: 0,
    files: [{ path: "e3/shot.png" }, { path: "e3/call.json" }],
  },
];
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const file = (rel: string) => (rel.endsWith(".png") ? PNG : rel.endsWith("call.json") ? Buffer.from('{"ok":true,"out":"Dark"}') : null);

const facts = (o: Partial<ReportFacts> = {}): ReportFacts => ({
  job: { id: "007-dark", title: "Dark <mode>", kind: "feature", risk: "medium", round: 2, pr: 3, branch: "kitchen/007-dark" },
  head: HEAD,
  verdict: "PASS",
  humanMustCheck: false,
  requirements: [
    { id: "R1", text: "dark mode persists", negative: false, outOfScope: false },
    { id: "R2", text: "email me", negative: false, outOfScope: true },
  ],
  criteria: [
    { id: "C1", text: "theme is Dark after reload", covers: ["R1"], decidedBy: "engine", result: "PASS", evidence: ["e2"], nonDiscriminating: false },
    { id: "C2", text: "looks right", covers: ["R1"], decidedBy: "verifier", result: "PASS", evidence: ["e3"], nonDiscriminating: true },
  ],
  review: {
    lenses: ["code"],
    blockingRounds: 1,
    findings: [{ id: "code-2-1", lenses: ["code"], blocks: false, confidence: "medium", where: "server.js:9", title: "naming", why: "" }],
  },
  seeds: null,
  costs: [{ stage: "build", round: 1, secs: 120, usd: 0.21, roles: "builder (sonnet)" }],
  argsDeltas: [],
  ...o,
});
const SRC = '<section id="summary"><p>Done, see {{e2}} and {{ e3 }}.</p></section><section id="changes"><p>server.js</p></section>';

test("every cited id must exist and be stamped for the final HEAD", () => {
  assert.equal(renderRefusal(SRC, entries, HEAD, false), null);
  assert.match(renderRefusal(`${SRC}{{e99}}`, entries, HEAD, false) ?? "", /unknown evidence id e99/);
  assert.match(renderRefusal(`${SRC}{{e1}}`, entries, HEAD, false) ?? "", /e1 is not stamped for the final HEAD aaaaaaaa/);
  assert.match(renderRefusal(`${SRC}{{verdict}}`, entries, HEAD, false) ?? "", /unknown placeholder \{\{verdict\}\}/);
  assert.match(renderRefusal("<p>{{e2}}</p>", entries, HEAD, false) ?? "", /no <section id="summary">/);
});

test("a human: always report must open with what a human must check", () => {
  assert.match(renderRefusal(SRC, entries, HEAD, true) ?? "", /human-check/);
  const src = `${SRC}<section id="human-check"><ul><li>the auth check on /api/x</li></ul></section>`;
  const r = renderReport({ src, facts: facts({ humanMustCheck: true }), entries, file });
  assert.ok("html" in r);
  const html = r.html;
  assert.ok(html.indexOf('id="human-check"') < html.indexOf('id="summary"'), "human-check comes first");
  assert.match(html, /HUMAN REVIEW REQUIRED/);
});

test("render inlines evidence (screenshots as data URIs), adds the engine's sections, escapes the title", () => {
  const r = renderReport({ src: SRC, facts: facts(), entries, file });
  assert.ok("html" in r);
  assert.deepEqual(r.cited, ["e2", "e3"]);
  assert.match(r.html, /<img src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(r.html, /<a class="ev" href="#ev-e2"/);
  assert.match(r.html, /<details id="ev-e2">/);
  assert.match(r.html, /Dark &lt;mode&gt;/);
  assert.match(r.html, /R2.*out of scope/);
  assert.match(r.html, /NON-DISCRIMINATING/);
  assert.match(r.html, /sent the job back to build 1 time/);
  assert.match(r.html, /\$0\.210/);
  assert.doesNotMatch(r.html, /\{\{/);
  assert.doesNotMatch(r.html, /https?:\/\//, "self-contained: nothing remote");
});

test("sanitize: no scripts, handlers, frames, remote loads or javascript: links", () => {
  const dirty =
    '<p onclick="x()">hi<script>steal()</script><img src="https://evil/x.png" onerror=alert(1)><a href="javascript:alert(1)">a</a><a href="#ev-e2">ok</a><iframe src="//x"></iframe><style>body{}</style></p>';
  const s = sanitize(dirty);
  for (const bad of ["onclick", "script", "steal", "https://evil", "onerror", "javascript:", "iframe", "<style"]) assert.ok(!s.includes(bad), `${bad} in ${s}`);
  assert.match(s, /<a href="#ev-e2">ok<\/a>/);
});

test("sanitize: an allow-list, read the way a browser tokenizes (the review's bypasses)", () => {
  const cases: [string, RegExp[], RegExp?][] = [
    ['<a/href="https://evil">x</a>', [/evil/, /href/], /<a>x<\/a>/],
    ['<img/src="data:image/png;base64,AAAA">', [/<img/, /data:/]],
    ["<img/onerror=alert(1)/src=x>", [/<img/, /onerror/, /alert/]],
    ["<div/style=background:url(https://evil/x)>t</div>", [/style/, /url\(/, /evil/], /<div>t<\/div>/],
    ['<video poster="https://evil/p.png"><source src="x"></video>ok', [/video/, /poster/, /evil/, /source/], /^ok$/],
    ['<table background="https://evil/b.png"><tr><td>c</td></tr></table>', [/background/, /evil/], /<table><tr><td>c<\/td><\/tr><\/table>/],
    ['<a href="&#106;avascript:alert(1)">j</a>', [/javascript/i, /&#106;/, /href/]],
    ['<a href="#ev-e2" onclick="x()">ok</a>', [/onclick/], /<a href="#ev-e2">ok<\/a>/],
    ["<svg><a href=x><script>alert(1)</script></a></svg>after", [/svg/, /script/, /alert/], /^after$/],
    [
      '<p>1 < 2 and <3</p><link rel=stylesheet href="https://evil/c.css"><meta http-equiv=refresh content="0;url=https://evil">',
      [/<link/, /<meta/, /evil/],
      /<p>1 &lt; 2 and &lt;3<\/p>/,
    ],
    ['<section id="summary" class="lead" style="x" data-x="1">s</section>', [/style/, /data-x/], /<section id="summary" class="lead">s<\/section>/],
    ["<p>unclosed <strong>bold", [], /<p>unclosed <strong>bold<\/strong><\/p>$/],
    ["</section></main><p>x</p>", [/<\/section>/, /<\/main>/], /^<p>x<\/p>$/],
    ['<img src="x" alt="never closed', [/<img/]],
  ];
  for (const [src, gone, keep] of cases) {
    const s = sanitize(src);
    for (const g of gone) assert.doesNotMatch(s, g, `${src} → ${s}`);
    if (keep) assert.match(s, keep, `${src} → ${s}`);
  }
});

test("a human-check section hidden in a comment doesn't count; refusal runs on what the page shows", () => {
  const hidden = `${SRC}<!-- <section id="human-check"><p>look at auth</p></section> -->`;
  assert.match(renderRefusal(hidden, entries, HEAD, true) ?? "", /human-check/);
  assert.match(renderRefusal(`<!-- ${SRC} -->`, entries, HEAD, false) ?? "", /no <section id="summary">/);
  assert.equal(renderRefusal(`${SRC}<!-- {{e99}} -->`, entries, HEAD, false), null, "an id the page won't show is not cited");
});

test("the review section lists what blocked earlier rounds", () => {
  const earlier = [
    {
      round: 1,
      id: "security-1-1",
      lenses: ["security"],
      blocks: true,
      confidence: "high",
      where: "server.js:264",
      title: "description rendered raw",
      why: "XSS",
    },
  ];
  const r = renderReport({ src: SRC, facts: facts({ review: { ...facts().review, earlier } }), entries, file });
  assert.ok("html" in r);
  assert.match(
    r.html,
    /What blocked earlier rounds.*round 1 · <code>security-1-1<\/code> security · <code>server\.js:264<\/code> · <b>description rendered raw<\/b>: XSS/,
  );
});

test("a cited id outside the verdict's and views' ids renders with a warning", () => {
  const src = `${SRC.replace("{{ e3 }}", "")}<section id="notes"><p>{{e3}}</p></section>`;
  const r = renderReport({ src, facts: facts(), entries, file, citable: ["e2"] });
  assert.ok("html" in r);
  assert.deepEqual(r.warnings, ["e3 (engine, C2) is cited but no verdict row or view cites it: context, not proof"]);
  assert.match(r.html, /id="citation-warnings"/);
  const ok = renderReport({ src: SRC, facts: facts(), entries, file, citable: ["e2", "e3"] });
  assert.ok("html" in ok && ok.warnings.length === 0 && !/citation-warnings/.test(ok.html));
});

test("the PR comment carries Kitchen's marker and escapes agent text (no images, links or table breaks)", () => {
  const evil = facts({
    job: { ...facts().job, title: "Fix ![x](https://evil/t.png)" },
    criteria: [
      {
        id: "C1",
        text: "shows ![p](https://evil/p.png) [click](https://evil) | x",
        covers: ["R1"],
        decidedBy: "engine",
        result: "PASS",
        evidence: [],
        nonDiscriminating: false,
      },
    ],
  });
  const c = prComment(evil, { url: "https://x/", entries });
  assert.ok(c.startsWith(KITCHEN_MARKER));
  assert.doesNotMatch(c, /!\[|\]\(https|https:\/\/evil/);
  assert.match(c, /\| C1 shows \\!\\\[p\\\]\\\(https&#58;\/\/evil\/p\.png\\\) .* \\\| x \| R1 \|/);
  assert.equal(mdText("a\nb"), "a b");
});

test("the PR comment: one row per criterion, screenshot links into the published folder, the report link", () => {
  const c = prComment(facts({ humanMustCheck: true }), { url: "https://x/blob/kitchen-evidence/007-dark/", entries });
  assert.match(
    c,
    /\| C2 looks right \(NON-DISCRIMINATING\) \| R1 \| verifier \| PASS \| \[e3\]\(https:\/\/x\/blob\/kitchen-evidence\/007-dark\/evidence\/e3\/shot\.png\) \|/,
  );
  assert.match(c, /\| C1 theme is Dark after reload \| R1 \| engine \| PASS \| e2 \|/);
  assert.match(c, /Human review required/);
  assert.match(c, /Full report: https:\/\/x\/blob\/kitchen-evidence\/007-dark\/report\.html/);
});

test("stamped commands read without the engine's own flags", () => {
  assert.equal(shortCmd("/r/.kitchen/toolkit/bin/dev read --id=7 --src=/w --out=/o/e1 --target=body"), "read --target=body");
  assert.equal(shortCmd("bin/dev login --id=001-ab --src=/a --out=/x --as=alice"), "login --as=alice");
  assert.equal(shortCmd("node --check server.js"), "node --check server.js");
});
