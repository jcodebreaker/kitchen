#!/usr/bin/env node
// A fake `gh` for the W3b spikes: records every call and serves canned JSON from a
// state file, so the GitHub forge and ticket source run end to end with no network
// and no GitHub account. Only the subcommands Kitchen uses are implemented; any
// other call exits 2 (so a new one shows up as a failure, not a silent pass).
//   $GH_SHIM_STATE/state.json   PRs, issues, labels (the spikes edit it to merge a PR, turn CI red…)
//   $GH_SHIM_STATE/calls.jsonl  {argv, stdin, token, at} per call
import fs from "node:fs";
import path from "node:path";

const dir = process.env.GH_SHIM_STATE;
if (!dir) {
  console.error("gh-shim: GH_SHIM_STATE is not set");
  process.exit(2);
}
const stateFile = path.join(dir, "state.json");
const argv = process.argv.slice(2);
const stdin = argv.includes("-") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(
  path.join(dir, "calls.jsonl"),
  `${JSON.stringify({ argv, stdin, token: process.env.GH_TOKEN ? "set" : "unset", at: new Date().toISOString() })}\n`,
);

const load = () =>
  fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { next: 1, prs: [], issues: [], labels: [], defaultChecks: [] };
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);
const pick = (o, fields) =>
  Object.fromEntries(
    (fields ?? "")
      .split(",")
      .filter(Boolean)
      .map((f) => [f, o[f]]),
  );
const out = (x) => process.stdout.write(typeof x === "string" ? `${x}\n` : `${JSON.stringify(x)}\n`);
const fail = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
const repo = flag("repo") ?? "owner/repo";
const now = () => new Date().toISOString();
const [a, b] = argv;
const num = () => Number(argv[2]);

const s = load();
const prOf = (n) => s.prs.find((p) => p.number === n) ?? fail(`no pull request ${n}`);
const issueOf = (n) => s.issues.find((i) => i.number === n) ?? fail(`no issue ${n}`);
const view = (p) => ({
  ...p,
  mergedAt: p.state === "MERGED" ? (p.mergedAt ?? now()) : null,
  labels: (p.labels ?? []).map((name) => ({ name })),
  author: { login: p.author ?? "kitchen-bot" },
});

if (a === "auth" && b === "token") out("gho_shimtoken");
else if (a === "label" && b === "create") {
  if (!s.labels.includes(argv[2])) s.labels.push(argv[2]);
  save(s);
} else if (a === "pr" && b === "list") {
  const rows = s.prs.filter((p) => !flag("head") || p.head === flag("head")).filter((p) => flag("state") === "all" || p.state === "OPEN");
  out(rows.map((p) => pick(view(p), flag("json"))));
} else if (a === "pr" && b === "create") {
  if (s.prs.some((p) => p.head === flag("head") && p.state === "OPEN")) fail(`a pull request for branch "${flag("head")}" already exists`);
  const n = s.next++;
  s.prs.push({
    number: n,
    head: flag("head"),
    base: flag("base"),
    title: flag("title"),
    body: stdin,
    state: "OPEN",
    isDraft: has("draft"),
    labels: [],
    checks: structuredClone(s.defaultChecks ?? []),
    comments: [],
  });
  save(s);
  out(`https://github.com/${repo}/pull/${n}`);
} else if (a === "pr" && b === "view") out(pick(view(prOf(num())), flag("json")));
else if (a === "pr" && b === "checks") {
  const rows = prOf(num()).checks ?? [];
  if (!rows.length) fail("no checks reported on the 'x' branch", 1);
  out(rows.map((r) => pick({ ...r, state: r.bucket === "pass" ? "SUCCESS" : r.bucket === "fail" ? "FAILURE" : "PENDING" }, flag("json"))));
  process.exitCode = rows.some((r) => r.bucket === "fail") ? 1 : rows.some((r) => r.bucket === "pending") ? 8 : 0;
} else if (a === "pr" && b === "ready") {
  prOf(num()).isDraft = false;
  save(s);
} else if (a === "pr" && b === "edit") {
  const p = prOf(num());
  const l = flag("add-label");
  if (l && !s.labels.includes(l)) fail(`'${l}' not found`);
  if (l && !p.labels.includes(l)) p.labels.push(l);
  save(s);
} else if ((a === "pr" || a === "issue") && b === "comment") {
  const t = a === "pr" ? prOf(num()) : issueOf(num());
  t.comments.push({ body: stdin, user: "kitchen-bot", created_at: now() });
  save(s);
  out(`https://github.com/${repo}/${a === "pr" ? "pull" : "issues"}/${num()}#issuecomment-${t.comments.length}`);
} else if (a === "api" && b === "graphql") {
  // The issue's edit/label history (sources/github.ts). An issue without `events` was labelled when it was made.
  const f = (k) => argv[argv.findIndex((x, i) => argv[i - 1] === "-F" && x.startsWith(`${k}=`))]?.slice(k.length + 1);
  const i = issueOf(Number(f("n")));
  const events = i.events ?? (i.labels ?? []).map((name) => ({ type: "labeled", label: name, at: i.createdAt ?? "2000-01-01T00:00:00Z" }));
  out({
    data: {
      repository: {
        issue: {
          lastEditedAt: i.lastEditedAt ?? null,
          timelineItems: {
            nodes: events.map((e) =>
              e.type === "labeled"
                ? { __typename: "LabeledEvent", createdAt: e.at, label: { name: e.label } }
                : { __typename: "RenamedTitleEvent", createdAt: e.at },
            ),
          },
        },
      },
    },
  });
} else if (a === "api") {
  // conversation comments (issues/N/comments, PRs share it) and inline review comments (pulls/N/comments)
  const m = /^repos\/[^/]+\/[^/]+\/(issues|pulls)\/(\d+)\/comments$/.exec(b);
  if (!m) fail(`gh-shim: api ${b} not implemented`, 2);
  const n = Number(m[2]);
  const t = m[1] === "pulls" ? prOf(n) : (s.prs.find((p) => p.number === n) ?? issueOf(n));
  const rows = m[1] === "pulls" ? (t.reviewComments ?? []) : t.comments;
  out(
    rows.map((c, i) => ({
      id: c.id ?? n * 1000 + i,
      body: c.body,
      user: { login: c.user },
      author_association: c.author_association ?? (c.user === "kitchen-bot" ? "NONE" : "CONTRIBUTOR"),
      created_at: c.created_at,
    })),
  );
} else if (a === "issue" && b === "list") {
  const label = flag("label");
  const st = flag("state") ?? "open";
  const rows = s.issues.filter((i) => (!label || (i.labels ?? []).includes(label)) && (st === "all" || i.state === st.toUpperCase()));
  out(
    rows.map((i) =>
      pick(
        { ...i, url: `https://github.com/${repo}/issues/${i.number}`, author: { login: i.author }, labels: (i.labels ?? []).map((name) => ({ name })) },
        flag("json"),
      ),
    ),
  );
} else if (a === "issue" && b === "view") {
  const i = issueOf(num());
  out(
    pick(
      {
        ...i,
        author: { login: i.author },
        comments: i.comments.map((c) => ({ body: c.body, createdAt: c.created_at, author: { login: c.user } })),
      },
      flag("json"),
    ),
  );
} else if (a === "issue" && b === "create") {
  const n = s.next++;
  s.issues.push({
    number: n,
    title: flag("title"),
    body: stdin,
    state: "OPEN",
    author: "kitchen-bot",
    labels: flag("label") ? [flag("label")] : [],
    comments: [],
  });
  save(s);
  out(`https://github.com/${repo}/issues/${n}`);
} else fail(`gh-shim: ${argv.slice(0, 2).join(" ")} not implemented`, 2);
