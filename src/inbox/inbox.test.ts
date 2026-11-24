// The outer loop's rules (ADR 0022 and its amendment), without network or agents: GitHub read through a stand-in `gh`
// (ETag 304, the since overlap, no duplicates), Slack through a stand-in fetch, one collect at a time, a source that
// fails is unavailable (never empty) and keeps its watermark, the inbox verbs, Run filing jobs with where they came
// from, the merge comment, and Kitchen's own findings.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import type { Gh } from "../engine/staging.ts";
import { findJob, updateJob } from "../engine/store.ts";
import { withFileLock } from "../lock.ts";
import { readState, type SlackSource, saveSource } from "../sources/config.ts";
import { slackToken } from "../sources/secret.ts";
import { BUSY, collect, collectLock } from "./collect.ts";
import { commentOnMerge } from "./comment.ts";
import { addFindings, qaFindings, reviewFindings, runFindings } from "./findings.ts";
import { installSchedule, parseEvery, removeSchedule, scheduleId } from "./schedule.ts";
import * as inbox from "./store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-inbox-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const repo = () => {
  const r = path.join(root, `r${++n}`);
  fs.mkdirSync(path.join(r, ".kitchen"), { recursive: true });
  return r;
};
const quiet = () => {};
const issue = (number: number, updated: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: "it breaks",
  html_url: `https://github.com/o/r/issues/${number}`,
  updated_at: updated,
  user: { login: "lena" },
  ...extra,
});
const http = (status: number, body: unknown, etag = '"e1"') => ({
  code: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} X\r\nEtag: ${etag}\r\nContent-Type: application/json\r\n\r\n${status === 304 ? "" : JSON.stringify(body)}`,
  stderr: "",
});

test("GitHub: the ETag turns an unchanged read into a 304; since overlaps the watermark and adds nothing twice; PRs skipped; an edit is a new sighting", async () => {
  const r = repo();
  saveSource(r, { kind: "github", name: "gh", repo: "o/r", label: "kitchen" });
  const calls: string[][] = [];
  let issues = [issue(17, "2026-11-24T08:00:00Z"), issue(18, "2026-11-24T08:30:00Z", { pull_request: {} })];
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args.includes('If-None-Match: "e1"') && issues.length === 2) return http(304, null);
    return http(200, issues);
  };
  assert.equal(await collect(r, quiet, { readers: { gh }, triage: null }), 0);
  assert.deepEqual(
    inbox.listItems(r).map((i) => [i.key, i.src.label, i.src.by]),
    [["github:o/r#17", "GitHub #17", "lena"]],
  );
  const st = readState(r, "gh");
  assert.equal(st.watermark, "2026-11-24T08:30:00Z", "the newest updated_at seen, PRs included");
  assert.equal(st.etag, '"e1"');
  assert.ok(!calls[0].some((a) => a.includes("since=")), "the first read has no since");

  // The next read asks since the watermark less five minutes: the overlap brings #17 back, not added again.
  await collect(r, quiet, { readers: { gh }, triage: null });
  assert.match(calls[1].at(-1) as string, /since=2026-11-24T08%3A25%3A00\.000Z/, "since = the watermark less five minutes");
  assert.equal(inbox.listItems(r).length, 1);
  // Nothing changed since: the same request again, with its ETag, answered 304.
  await collect(r, quiet, { readers: { gh }, triage: null });
  assert.ok(calls[2].includes('If-None-Match: "e1"'), calls[2].join(" "));
  assert.equal(calls[2].at(-1), calls[1].at(-1));
  assert.equal(inbox.listItems(r).length, 1);
  assert.equal(readState(r, "gh").lastNew, 0);

  // The overlap brings #17 back unchanged (not added again) and #19 new; then #17 edited is a new sighting.
  issues = [issue(17, "2026-11-24T08:00:00Z"), issue(19, "2026-11-24T09:00:00Z"), issue(18, "2026-11-24T08:30:00Z", { pull_request: {} })];
  await collect(r, quiet, { readers: { gh }, triage: null });
  assert.deepEqual(
    inbox.listItems(r).map((i) => i.key),
    ["github:o/r#17", "github:o/r#19"],
  );
  issues = [issue(17, "2026-11-24T10:00:00Z", { body: "it breaks, and worse" })];
  await collect(r, quiet, { readers: { gh }, triage: null });
  const all = inbox.listItems(r);
  assert.equal(all.length, 3);
  assert.equal(all[2].key, "github:o/r#17");
  assert.equal(all[2].sighting, 2);
  assert.equal(readState(r, "gh").watermark, "2026-11-24T10:00:00Z");
});

test("unavailable is never empty: a failed page adds nothing, marks the source unavailable and keeps its watermark", async () => {
  const r = repo();
  saveSource(r, { kind: "github", name: "gh", repo: "o/r", label: "kitchen" });
  const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 1, `2026-11-24T08:${String(i % 60).padStart(2, "0")}:00Z`));
  let fail = false;
  const gh: Gh = async (args) => {
    const p = args.at(-1) as string;
    if (fail && p.includes("page=2")) return { code: 1, stdout: "", stderr: "gh: Bad Gateway (HTTP 502)" };
    return http(200, p.includes("page=2") ? [issue(200, "2026-11-24T09:00:00Z")] : page1);
  };
  await collect(r, quiet, { readers: { gh }, triage: null });
  const before = readState(r, "gh");
  assert.equal(before.status, "available");
  assert.equal(inbox.listItems(r).length, 101);
  fail = true;
  const lines: string[] = [];
  await collect(r, (l) => lines.push(l), {
    readers: { gh: async (a) => (a.at(-1)?.includes("page=2") ? gh(a, "") : http(200, [...page1.slice(1), issue(300, "2026-11-25T00:00:00Z")])) },
    triage: null,
  });
  const after = readState(r, "gh");
  assert.equal(after.status, "unavailable");
  assert.match(after.error ?? "", /502/);
  assert.equal(after.watermark, before.watermark, "the watermark doesn't move after a partial read");
  assert.equal(after.lastAt, before.lastAt);
  assert.equal(inbox.listItems(r).length, 101, "nothing from the partial read");
  assert.match(lines.join("\n"), /gh: unavailable/);
});

test("Slack: the messages with the emoji, each with its thread, through the app's token; a bad token is unavailable", async () => {
  const r = repo();
  const s: SlackSource = { kind: "slack", name: "bugs", channel: "C0BUGS1", channelName: "#bugs", emoji: "kitchen" };
  saveSource(r, s);
  const urls: string[] = [];
  const fake = (async (u: string, init?: { headers?: Record<string, string> }) => {
    urls.push(u);
    const url = new URL(u);
    const ok = (b: unknown) => new Response(JSON.stringify({ ok: true, ...(b as object) }), { status: 200 });
    if (init?.headers?.authorization !== "Bearer xoxb-test") return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
    if (url.pathname.endsWith("auth.test")) return ok({ url: "https://team.slack.com/" });
    if (url.pathname.endsWith("conversations.history"))
      return ok({
        messages: [
          { ts: "1732440000.000100", text: "Covers are grey boxes", user: "U1", reactions: [{ name: "kitchen" }], reply_count: 1 },
          { ts: "1732440100.000200", text: "lunch?", user: "U2" },
          { ts: "1732440200.000300", text: "Search ignores accents", user: "U2", reactions: [{ name: "kitchen::skin-tone-3" }] },
        ],
        has_more: false,
      });
    if (url.pathname.endsWith("conversations.replies"))
      return ok({
        messages: [
          { ts: "1732440000.000100", text: "Covers are grey boxes", user: "U1" },
          { ts: "1732440050.0001", text: "same here", user: "U2" },
        ],
      });
    if (url.pathname.endsWith("users.info")) return ok({ user: { profile: { display_name: url.searchParams.get("user") === "U1" ? "ben" : "ana" } } });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const token = () => slackToken({ env: { KITCHEN_SLACK_TOKEN: "xoxb-test" }, run: () => assert.fail("the keychain is never asked when the env has a token") });
  await collect(r, quiet, { readers: { fetch: fake, slackToken: token }, triage: null, now: () => new Date(1732450000 * 1000) });
  const items = inbox.listItems(r);
  assert.deepEqual(
    items.map((i) => [i.key, i.src.label, i.src.by]),
    [
      ["slack:C0BUGS1:1732440000.000100", "Slack #bugs", "ben"],
      ["slack:C0BUGS1:1732440200.000300", "Slack #bugs", "ana"],
    ],
  );
  assert.match(items[0].text, /Thread:\nana: same here/);
  assert.equal(items[0].src.url, "https://team.slack.com/archives/C0BUGS1/p1732440000000100");
  assert.equal(readState(r, "bugs").watermark, "1732440200.000300");
  assert.ok(
    urls.every((u) => u.startsWith("https://slack.com/api/")),
    "only Slack's API, through the stand-in",
  );
  // A reply in the thread later is not a new sighting; a second collect reads from the watermark less the overlap.
  await collect(r, quiet, { readers: { fetch: fake, slackToken: token }, triage: null, now: () => new Date(1732450000 * 1000) });
  assert.equal(inbox.listItems(r).length, 2);
  const oldest = new URL(urls.filter((u) => u.includes("conversations.history")).at(-1) as string).searchParams.get("oldest");
  assert.equal(Number(oldest), 1732440200.0003 - 2 * 24 * 3600);
  // The wrong token: unavailable, nothing added, the watermark kept.
  await collect(r, quiet, { readers: { fetch: fake, slackToken: () => "xoxb-wrong" }, triage: null });
  assert.equal(readState(r, "bugs").status, "unavailable");
  assert.match(readState(r, "bugs").error ?? "", /invalid_auth/);
  assert.equal(readState(r, "bugs").watermark, "1732440200.000300");
});

test("one collect at a time: a busy collect exits 4 without reading or writing", async () => {
  const r = repo();
  saveSource(r, { kind: "github", name: "gh", repo: "o/r", label: "kitchen" });
  let read = 0;
  const gh: Gh = async () => {
    read++;
    return http(200, [issue(1, "2026-11-24T08:00:00Z")]);
  };
  let inner = -1;
  await withFileLock(collectLock(r), async () => {
    inner = await collect(r, quiet, { readers: { gh }, triage: null });
  });
  assert.equal(inner, BUSY);
  assert.equal(read, 0);
  assert.equal(inbox.listItems(r).length, 0);
  assert.equal(readState(r, "gh").lastAt, undefined);
});

test("triage runs on the untriaged items only, after the reads", async () => {
  const r = repo();
  await inbox.addItems(r, [{ key: "manual:1", text: "a", src: { source: "manual", kind: "manual", label: "Added by hand", ref: "" } }]);
  const seen: string[][] = [];
  await collect(r, quiet, {
    triage: async (_r, o) => {
      seen.push(o.items);
      return 0;
    },
  });
  assert.deepEqual(seen, [["i-1"]]);
  await inbox.verdict(r, ["i-1"], { verdict: "not-ours", reason: "an ad blocker" });
  seen.length = 0;
  await collect(r, quiet, {
    triage: async (_r, o) => {
      seen.push(o.items);
      return 0;
    },
  });
  assert.deepEqual(seen, [], "nothing left to triage");
});

test("inbox verbs: propose, set aside, hold, bring back, remove and undo, edit; Run files jobs at intake by priority, with where they came from", async () => {
  const r = repo();
  await inbox.addItems(r, [
    {
      key: "github:o/r#17",
      text: "Book list slow",
      src: { source: "gh", kind: "github", label: "GitHub #17", ref: "#17", by: "lena", url: "https://github.com/o/r/issues/17" },
    },
    { key: "github:o/r#18", text: "Slow too", src: { source: "gh", kind: "github", label: "GitHub #18", ref: "#18", url: "https://github.com/o/r/issues/18" } },
    { key: "slack:C1:1.1", text: "Renew on returned loans", src: { source: "bugs", kind: "slack", label: "Slack #bugs", ref: "1.1", by: "ben" } },
    { key: "kitchen:003:qa:1.1", text: "Covers grey", src: { source: "kitchen", kind: "kitchen", label: "QA finding in 003", ref: "003" } },
  ]);
  const shot = path.join(r, "shot.png");
  fs.writeFileSync(shot, "png");
  const p3 = await inbox.propose(r, {
    title: "Renew shows on returned loans",
    text: "Hide Renew",
    items: ["i-3"],
    kind: "bug",
    prio: "P2",
    why: "data",
    evidence: [shot],
  });
  const p1 = await inbox.propose(r, {
    title: "Book list is slow",
    text: "Render a page",
    items: ["i-1", "i-2"],
    kind: "bug",
    prio: "P1",
    why: "three reports",
    steps: ["open /books"],
  });
  assert.deepEqual(p3.ev?.files, ["i-3/evidence/p1-1-shot.png"]);
  assert.ok(fs.existsSync(path.join(inbox.itemDir(r, "i-3"), "evidence", "p1-1-shot.png")));
  const aside = await inbox.verdict(r, ["i-4"], { verdict: "fixed", reason: "loads fine on staging" });
  assert.equal(aside.state, "aside");
  await assert.rejects(inbox.verdict(r, ["i-4"], { verdict: "duplicate", reason: "x" }), /--of/);
  assert.deepEqual(inbox.untriaged(r), []);

  assert.equal((await inbox.hold(r, p3.id)).state, "held");
  await assert.rejects(inbox.run(r, [p3.id]), /held/);
  assert.equal((await inbox.bringBack(r, p3.id)).state, "open");
  assert.equal((await inbox.remove(r, p3.id)).state, "removed");
  assert.equal((await inbox.bringBack(r, p3.id)).state, "open", "Undo puts it back where it was");
  assert.equal((await inbox.edit(r, p3.id, { text: "Hide Renew on returned loans; refuse it on the server" })).edited, true);
  assert.equal((await inbox.verdict(r, [aside.id], { verdict: "propose" })).state, "open", "Propose anyway");

  const made = await inbox.run(r, [p3.id, p1.id]);
  assert.deepEqual(
    made.map((m) => m.proposal),
    [p1.id, p3.id],
    "P1 first",
  );
  const j1 = findJob(r, made[0].job);
  assert.equal(j1.stage, "intake");
  assert.equal(j1.title, "Book list is slow");
  assert.deepEqual(j1.from && { ...j1.from }, {
    source: "gh",
    kind: "github",
    ref: "#17",
    url: "https://github.com/o/r/issues/17",
    label: "2 reports",
    proposal: p1.id,
    items: ["i-1", "i-2"],
    refs: [
      { source: "gh", kind: "github", ref: "#17", url: "https://github.com/o/r/issues/17" },
      { source: "gh", kind: "github", ref: "#18", url: "https://github.com/o/r/issues/18" },
    ],
  });
  const ticket = fs.readFileSync(path.join(r, ".kitchen", "jobs", j1.id, "ticket.md"), "utf8");
  assert.match(ticket, /Render a page\n\nHow triage reproduced it:\n1\. open \/books/);
  assert.match(ticket, /GitHub #17 · lena · https:\/\/github.com\/o\/r\/issues\/17\n> Book list slow/);
  assert.equal(findJob(r, made[1].job).from?.label, "Slack #bugs · ben");
  assert.equal(inbox.getProposal(r, p1.id).state, "run");
  assert.equal(inbox.getProposal(r, p1.id).job, j1.id);
  await assert.rejects(inbox.run(r, [p1.id]), /a job already/);
});

test("a job from GitHub issues comments on each when it merges: the sha and the Report, once; never closes", async () => {
  const r = repo();
  await inbox.addItems(r, [
    { key: "github:o/r#17", text: "slow", src: { source: "gh", kind: "github", label: "GitHub #17", ref: "#17", url: "https://github.com/o/r/issues/17" } },
  ]);
  const p = await inbox.propose(r, { title: "Slow list", text: "Faster", items: ["i-1"], kind: "bug", prio: "P1", why: "x" });
  const [m] = await inbox.run(r, [p.id]);
  const calls: string[][] = [];
  const gh: Gh = async (a) => {
    calls.push(a);
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.deepEqual(await commentOnMerge(r, findJob(r, m.job), { gh }), [], "not merged yet: nothing");
  await updateJob(r, m.job, (j) => ({ ...j, stage: "done", merged: { into: "staging", sha: "9b0d3e7aa11", at: "x", via: "local" } }));
  assert.deepEqual(await commentOnMerge(r, findJob(r, m.job), { gh }), ["commented on o/r#17"]);
  assert.deepEqual(calls[0].slice(0, 5), ["issue", "comment", "17", "--repo", "o/r"]);
  assert.match(calls[0][6], /into `staging` as 9b0d3e7 \(job 001-slow-list[\s\S]*Report: `\.kitchen\/jobs\/001-slow-list\/report\.html`/);
  assert.ok(!calls.flat().some((a) => /close|edit|label/.test(a)), "only a comment");
  assert.deepEqual(await commentOnMerge(r, findJob(r, m.job), { gh }), [], "once per merge");
  assert.equal(calls.length, 1);
});

test("Kitchen findings: QA notes, a passing review's notes and failed sweep rows become items once", async () => {
  const r = repo();
  const qa = path.join(r, "qa");
  fs.mkdirSync(qa);
  fs.writeFileSync(path.join(qa, "verdict.json"), JSON.stringify({ verdict: "PASS", criteria: [], notes: [{ text: "The footer link 404s" }, "slow"] }));
  const fs1 = [
    ...qaFindings("003-add-book", 2, qa),
    ...reviewFindings("002-search", 1, [
      { id: "F1", blocks: true, why: "wrong" },
      { id: "F2", blocks: false, at: "lib/loans.js:12", why: "today() duplicated" },
    ]),
    ...runFindings("sweep", "sweep-20261124-090000", [
      { id: "search-books", result: "FAIL", note: "no results for é" },
      { id: "loans", result: "PASS", note: "" },
    ]),
  ];
  assert.equal(await addFindings(r, fs1), 4);
  assert.equal(await addFindings(r, fs1), 0, "finishing again adds nothing");
  assert.deepEqual(
    inbox.listItems(r).map((i) => [i.key, i.src.label]),
    [
      ["kitchen:003-add-book:qa:2.1", "QA finding in 003"],
      ["kitchen:003-add-book:qa:2.2", "QA finding in 003"],
      ["kitchen:002-search:review:1.F2", "Review note in 002"],
      ["kitchen:sweep-20261124-090000:sweep:search-books", "Sweep: search-books"],
    ],
  );
  assert.equal(readState(r, "kitchen").lastNew, 4);
});

test("the schedule: launchd's StartCalendarInterval or a systemd timer with Persistent=true, written without touching the real ones", () => {
  const home = repo();
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
  };
  const lines = installSchedule("/w/shop", "/k/cli.js", parseEvery("30m"), { platform: "darwin", home, run, uid: 501 });
  const plist = fs.readFileSync(path.join(home, "Library", "LaunchAgents", `${scheduleId("/w/shop")}.plist`), "utf8");
  assert.match(
    plist,
    /<key>StartCalendarInterval<\/key>\s*<array>\s*<dict><key>Minute<\/key><integer>0<\/integer><\/dict>\s*<dict><key>Minute<\/key><integer>30<\/integer><\/dict>/,
  );
  assert.match(plist, /<string>collect<\/string>\s*<string>--repo<\/string>\s*<string>\/w\/shop<\/string>/);
  assert.deepEqual(calls.at(-1)?.slice(0, 3), ["launchctl", "bootstrap", "gui/501"]);
  assert.match(lines[1], /every 30 minutes/);
  installSchedule("/w/shop", "/k/cli.js", parseEvery("2h"), { platform: "linux", home, run });
  const timer = fs.readFileSync(path.join(home, ".config", "systemd", "user", `${scheduleId("/w/shop")}.timer`), "utf8");
  assert.match(timer, /OnCalendar=\*-\*-\* 00:00:00\nOnCalendar=\*-\*-\* 02:00:00/);
  assert.match(timer, /Persistent=true/);
  assert.deepEqual(removeSchedule("/w/shop", { platform: "linux", home, run }), [
    `removed ${path.join(home, ".config", "systemd", "user", `${scheduleId("/w/shop")}.timer`)}`,
  ]);
  assert.throws(() => parseEvery("7m"), /at least 15m/);
  assert.throws(() => parseEvery("25m"), /divisor/);
});
