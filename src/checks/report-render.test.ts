import assert from "node:assert/strict";
import { test } from "vitest";
import { prComment, type ReportEntry, type ReportFacts, renderRefusal, renderReport, sanitize, shortCmd } from "./report-render.ts";

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
