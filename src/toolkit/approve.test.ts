// ADR 0015: the person's approval, not a merge, is the Toolkit's trust gate. The trust predicate
// (sandboxed vs not), which Toolkit a job uses, approve/revoke, waking waiting jobs, the words in each
// state, and the dashboard's Approve action behind the same POST checks as every other.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { renderVerdict } from "../checks/verdict.ts";
import { dashboardServer } from "../dashboard/server.ts";
import { ensureJobToolkit, resolveToolkitRef } from "../engine/job-toolkit.ts";
import { move } from "../engine/machine.ts";
import { toolkitDropped } from "../engine/no-toolkit.ts";
import { createJob, jobDirOf, readJobAt, updateJob } from "../engine/store.ts";
import { approveToolkit, commitToolkit, noToolkitWords, revokeToolkit, toolkitLabel, toolkitState } from "./approve.ts";
import { toolkitCheckout } from "./checkout.ts";
import { sandboxedBin } from "./sandbox.ts";
import { binFor, ensureIgnored, hasPassed, readApproval, recordPassed, trustOf } from "./trust.ts";

let root = "";
const saved = process.env.KITCHEN_HOME;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-approve-"));
  process.env.KITCHEN_HOME = path.join(root, "home");
});
afterAll(() => {
  if (saved === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

/** A repo on main with no Toolkit, and kitchen/setup one commit ahead holding one (a describe-only bin/dev). */
function repo(name: string): { dir: string; base: string; setup: string } {
  const dir = fs.realpathSync(fs.mkdirSync(path.join(root, name), { recursive: true }) ?? path.join(root, name));
  fs.writeFileSync(path.join(dir, "server.js"), "export const ok = true;\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".kitchen/jobs/\n.worktrees/\n");
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "kitchen/setup");
  fs.mkdirSync(path.join(dir, ".kitchen", "toolkit", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".kitchen", "toolkit", "bin", "dev"), '#!/bin/sh\necho \'{"status":"ok","primitives":[]}\'\n', { mode: 0o755 });
  git(dir, "add", "-f", ".kitchen/toolkit/bin/dev");
  git(dir, "commit", "-q", "-m", "toolkit");
  const setup = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  return { dir, base, setup };
}

test("trust predicate: on the base or approved runs unsandboxed; anything else under the sandbox", async () => {
  const r = repo("trust");
  assert.equal(await trustOf(r.dir, r.base), "base");
  assert.equal(await trustOf(r.dir, r.setup), null, "proven or not, an unapproved sha is not trusted");
  assert.equal(await trustOf(r.dir, ""), null);
  const sb = sandboxedBin("/x/.kitchen/toolkit/bin/dev").sandboxed; // false only where the OS has no sandbox (Linux)
  let co = await toolkitCheckout(r.dir, r.setup);
  co.release();
  assert.equal(co.trust, null);
  assert.equal(co.sandboxed, sb);
  if (sb) assert.notEqual(co.bin, path.join(co.dir, ".kitchen/toolkit/bin/dev"), "the sandbox wrapper, not bin/dev itself");
  await recordPassed(r.dir, r.setup);
  assert.equal(await approveToolkit(r.dir, {}), 0);
  assert.equal(await trustOf(r.dir, r.setup), "approved");
  co = await toolkitCheckout(r.dir, r.setup);
  co.release();
  assert.deepEqual([co.trust, co.sandboxed, co.bin], ["approved", false, path.join(co.dir, ".kitchen/toolkit/bin/dev")]);
  // The setup bridge runs uncommitted code: never trusted.
  assert.equal(binFor("/x/.kitchen/toolkit/bin/dev", null).sandboxed, sb);
  assert.deepEqual(binFor("/x/.kitchen/toolkit/bin/dev", "approved"), { bin: "/x/.kitchen/toolkit/bin/dev", sandboxed: false });
  revokeToolkit(r.dir);
  assert.equal(await trustOf(r.dir, r.setup), null, "revoked: sandboxed again");
});

test("which Toolkit a job uses: the base's first, then the approved sha, else none", async () => {
  const r = repo("resolve");
  assert.deepEqual(await resolveToolkitRef(r.dir, r.base), { ref: "" }, "nothing on the base, nothing approved");
  await recordPassed(r.dir, r.setup);
  await approveToolkit(r.dir, {});
  assert.deepEqual(await resolveToolkitRef(r.dir, r.base), { ref: r.setup, from: "approved" }, "the approved sha");
  git(r.dir, "merge", "-q", "--ff-only", "kitchen/setup");
  const tip = git(r.dir, "rev-parse", "HEAD");
  assert.deepEqual(await resolveToolkitRef(r.dir, tip), { ref: tip, from: "base" }, "the base has one: it wins over the approval");
});

test("approve refuses a sha that never passed toolkit check, one with no Toolkit, and an unknown one", async () => {
  const r = repo("refuse");
  const lines: string[] = [];
  assert.equal(await approveToolkit(r.dir, {}, (l) => lines.push(l)), 1);
  assert.match(lines.at(-1) ?? "", /hasn't passed kitchen toolkit check/);
  assert.equal(readApproval(r.dir), null);
  assert.equal(await approveToolkit(r.dir, { sha: r.base }, (l) => lines.push(l)), 1, "no Toolkit at that sha");
  assert.match(lines.at(-1) ?? "", /has no Toolkit/);
  git(r.dir, "commit", "-q", "--allow-empty", "-m", "later");
  assert.equal(await approveToolkit(r.dir, { sha: "nope" }, (l) => lines.push(l)), 1);
  assert.equal(readApproval(r.dir), null);
  await recordPassed(r.dir, r.setup);
  assert.ok(hasPassed(r.dir, r.setup));
  assert.equal(await approveToolkit(r.dir, {}, (l) => lines.push(l)), 0);
  assert.equal(readApproval(r.dir)?.sha, r.setup);
  assert.match(lines.at(-1) ?? "", /^Approved Toolkit [0-9a-f]{12}: every job runs your app with it\. Undo: kitchen toolkit revoke$/);
  // Kitchen's state stays out of the person's history, without touching their .gitignore.
  assert.equal(git(r.dir, "status", "--porcelain"), "");
});

test("approving wakes a job waiting no-toolkit; a job on a revoked approval loses it, on a newer one follows it", async () => {
  const r = repo("wake");
  const { job } = await createJob(r.dir, { title: "List books", ticket: { source: "prompt", id: "p1" }, body: "x", roundLimit: 3, base: r.base });
  await updateJob(r.dir, job.id, (j) => ({ ...j, stage: "paused", pausedFrom: "intake", waitFor: "no-toolkit", pausedReason: "x" }));
  await recordPassed(r.dir, r.setup);
  const lines: string[] = [];
  assert.equal(await approveToolkit(r.dir, {}, (l) => lines.push(l)), 0);
  assert.match(lines.at(-1) ?? "", /1 waiting job woke/);
  let j = readJobAt(jobDirOf(r.dir, job.id));
  assert.deepEqual([j.stage, j.toolkitRef, j.base], ["intake", r.setup, r.base], "woke with the approved sha; its base stays");
  // Revoked: at its next step the job has no Toolkit (it waits again where it needs the app).
  revokeToolkit(r.dir);
  j = await ensureJobToolkit(r.dir, j);
  assert.deepEqual([j.toolkitRef, j.toolkitBin], ["", ""]);
  // A rebuild: approve the new sha, and a job on the old one takes it at its next step.
  await updateJob(r.dir, job.id, (x) => ({ ...x, toolkitRef: r.setup, toolkitFrom: "approved" }));
  git(r.dir, "checkout", "-q", "kitchen/setup");
  fs.writeFileSync(path.join(r.dir, ".kitchen", "toolkit", "SKILL.md"), "rebuilt\n");
  git(r.dir, "add", "-f", ".kitchen/toolkit/SKILL.md");
  git(r.dir, "commit", "-q", "-m", "rebuild");
  const next = git(r.dir, "rev-parse", "HEAD");
  git(r.dir, "checkout", "-q", "main");
  await approveToolkit(r.dir, { sha: r.setup });
  j = await ensureJobToolkit(r.dir, readJobAt(jobDirOf(r.dir, job.id)));
  assert.equal(j.toolkitRef, r.setup, "the new sha isn't approved: the job keeps the old one");
  await recordPassed(r.dir, next, "kitchen/setup");
  // In verify the job keeps the sha it is proving with (review M4); it switches on entering build or drives.
  await updateJob(r.dir, job.id, (x) => ({ ...x, stage: "verify" }));
  await approveToolkit(r.dir, {});
  assert.equal((await ensureJobToolkit(r.dir, readJobAt(jobDirOf(r.dir, job.id)))).toolkitRef, r.setup, "pinned through verify");
  await updateJob(r.dir, job.id, (x) => ({ ...x, stage: "drives" }));
  j = await ensureJobToolkit(r.dir, readJobAt(jobDirOf(r.dir, job.id)));
  assert.equal(j.toolkitRef, next, "approved: it follows");
});

test("the words in each state: build it, being built, approve it; the sidebar label", () => {
  const none = noToolkitWords({ state: "none" });
  assert.match(none, /run `kitchen toolkit build`.*then approve it/);
  const building = noToolkitWords({ state: "building" });
  assert.match(building, /being built/);
  const waiting = noToolkitWords({ state: "waiting", sha: "a".repeat(40) });
  assert.match(waiting, /approve it \(kitchen toolkit approve\), or commit it to share with your team \(kitchen toolkit commit\)/);
  for (const w of [none, building, waiting]) assert.doesNotMatch(w, /merge/i);
  assert.equal(toolkitLabel({ state: "waiting" }), "proven · waiting for approval");
  assert.equal(toolkitLabel({ state: "approved" }), "approved");
  assert.equal(toolkitLabel({ state: "none" }), "not built");
});

test("toolkitState reads the build, the passed record and the approval", async () => {
  const r = repo("state");
  assert.equal(toolkitState(r.dir).state, "none");
  const init = path.join(r.dir, ".kitchen", "init");
  fs.mkdirSync(init, { recursive: true });
  fs.writeFileSync(
    path.join(init, "state.json"),
    JSON.stringify({
      version: 1,
      startedAt: "",
      steps: { template: { copied: true, existing: false }, check: { ok: true, sha: r.setup, secs: 1, parallel: true } },
      fixes: 0,
      runs: [],
    }),
  );
  assert.equal(toolkitState(r.dir).state, "none", "a check the passed record doesn't know of is not offered for approval");
  await recordPassed(r.dir, r.setup);
  assert.equal(toolkitState(r.dir).state, "none", "a pass that offers nothing (a re-proof of the base) is not offered either");
  await recordPassed(r.dir, r.setup, "kitchen/setup");
  assert.deepEqual(toolkitState(r.dir), { state: "waiting", sha: r.setup, offer: "kitchen/setup" });
  await approveToolkit(r.dir, {});
  assert.equal(toolkitState(r.dir).state, "approved");
  fs.writeFileSync(path.join(init, "status.json"), JSON.stringify({ state: "running", pid: process.ppid, pidStart: null, startedAt: "", at: "", last: [] }));
  assert.equal(toolkitState(r.dir).state, "building");
});

test("dashboard Approve Toolkit: refused without the token, from another origin or host, as a form, with fields; the page's own approves", async () => {
  const r = repo("dash");
  await recordPassed(r.dir, r.setup, "kitchen/setup");
  const TOKEN = "k".repeat(64);
  const server = dashboardServer(r.dir, { token: TOKEN });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const port = (server.address() as { port: number }).port;
  const post = (headers: Record<string, string>, body = "{}") =>
    new Promise<number>((resolve, reject) => {
      const q = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/toolkit-approve", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      q.on("error", reject);
      q.end(body);
    });
  const good = { host: `127.0.0.1:${port}`, "content-type": "application/json", "x-kitchen-token": TOKEN };
  try {
    const { "x-kitchen-token": _, ...noToken } = good;
    assert.equal(await post(noToken), 403, "no token");
    assert.equal(await post({ ...good, "x-kitchen-token": "x".repeat(64) }), 403, "wrong token");
    assert.equal(await post({ ...good, origin: "https://evil.example" }), 403, "another origin");
    assert.equal(await post({ ...good, host: "evil.example" }), 403, "DNS rebinding");
    assert.equal(await post({ ...good, "content-type": "text/plain" }), 415, "a cross-site form's type");
    const expect = (sha: string) => JSON.stringify({ expect: sha });
    assert.equal(await post(good, JSON.stringify({ sha: r.setup, expect: r.setup })), 400, "the page can't name a sha");
    assert.equal(await post(good, "{}"), 400, "nor approve without saying what it was shown");
    assert.equal(await post(good, expect("abc")), 400, "a sha, not a word");
    assert.equal(await post(good, expect(r.base)), 409, "stale: the Toolkit waiting is another one by now");
    assert.equal(readApproval(r.dir), null, "nothing approved by any of those");
    assert.equal(await post({ ...good, origin: `http://127.0.0.1:${port}` }, expect(r.setup.slice(0, 12))), 200);
    assert.equal(readApproval(r.dir)?.sha, r.setup);
  } finally {
    server.close();
  }
});

test("toolkit commit: only after a yes, one Kitchen commit of only the Toolkit paths, the person's checkout clean", async () => {
  const r = repo("commit");
  // kitchen/setup also carries a dev-environment file: it is not shared.
  git(r.dir, "checkout", "-q", "kitchen/setup");
  fs.writeFileSync(path.join(r.dir, "docker-compose.dev.yml"), "services: {}\n");
  fs.writeFileSync(path.join(r.dir, ".env.kitchen"), "PORT=1\n");
  git(r.dir, "add", "-A");
  git(r.dir, "commit", "-q", "-m", "dev env");
  const setup = git(r.dir, "rev-parse", "HEAD");
  git(r.dir, "checkout", "-q", "main");
  await recordPassed(r.dir, setup);
  const lines: string[] = [];
  assert.equal(await commitToolkit(r.dir, { confirm: async () => false }, (l) => lines.push(l)), 1);
  assert.equal(git(r.dir, "rev-parse", "HEAD"), r.base, "no: nothing committed");
  assert.equal(await commitToolkit(r.dir, { confirm: async () => true }, (l) => lines.push(l)), 0, lines.join("\n"));
  assert.equal(git(r.dir, "rev-parse", "HEAD^"), r.base, "one commit on the base");
  assert.deepEqual(git(r.dir, "diff", "--name-only", "HEAD^", "HEAD").split("\n").sort(), [".env.kitchen", ".kitchen/toolkit/bin/dev"]);
  assert.equal(git(r.dir, "log", "-1", "--format=%an"), "Kitchen");
  assert.equal(git(r.dir, "status", "--porcelain"), "", "index and files follow the commit");
  assert.ok(fs.existsSync(path.join(r.dir, ".kitchen/toolkit/bin/dev")));
  const head = git(r.dir, "rev-parse", "HEAD");
  assert.deepEqual(await resolveToolkitRef(r.dir, head), { ref: head, from: "base" }, "jobs now take it from the base");
});

test("a base Toolkit stays when the main checkout switches branches (review H2); revoking leaves it alone too", async () => {
  const r = repo("switch");
  git(r.dir, "merge", "-q", "--ff-only", "kitchen/setup");
  const tip = git(r.dir, "rev-parse", "HEAD");
  const { job } = await createJob(r.dir, {
    title: "x",
    ticket: { source: "prompt", id: "p2" },
    body: "x",
    roundLimit: 3,
    base: tip,
    ...(await resolved(r.dir, tip)),
  });
  assert.deepEqual([job.toolkitRef, job.toolkitFrom], [tip, "base"]);
  git(r.dir, "checkout", "-q", "-b", "elsewhere", r.base); // HEAD no longer has the Toolkit
  await updateJob(r.dir, job.id, (x) => ({ ...x, stage: "build" }));
  const j = await ensureJobToolkit(r.dir, readJobAt(jobDirOf(r.dir, job.id)));
  assert.deepEqual([j.toolkitRef, j.toolkitFrom], [tip, "base"], "never cleared");
  revokeToolkit(r.dir);
  assert.equal((await ensureJobToolkit(r.dir, j)).toolkitRef, tip);
});
const resolved = async (dir: string, base: string) => {
  const t = await resolveToolkitRef(dir, base);
  return { toolkitRef: t.ref, toolkitFrom: t.from };
};

test("revoked mid-job: a job past intake that needs the app (or is high risk) waits no-toolkit, unless it was resumed into checks only (review H3)", async () => {
  const r = repo("drop");
  await recordPassed(r.dir, r.setup, "kitchen/setup");
  await approveToolkit(r.dir, {});
  const { job } = await createJob(r.dir, {
    title: "x",
    ticket: { source: "prompt", id: "p3" },
    body: "x",
    roundLimit: 3,
    base: r.base,
    ...(await resolved(r.dir, r.base)),
  });
  assert.deepEqual([job.toolkitRef, job.toolkitFrom], [r.setup, "approved"]);
  const dir = jobDirOf(r.dir, job.id);
  fs.writeFileSync(
    path.join(dir, "intake.md"),
    "DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n## Requirements\n- R1: lists books\n\n## Criteria\n- [C1] the app lists books\n  proof: toolkit http --method GET --path /books\n  expect: exit 0\n  covers: R1\n- [C2] it parses\n  proof: cmd node --check server.js\n  expect: exit 0\n  covers: R1\n",
  );
  await updateJob(r.dir, job.id, (x) => ({ ...x, stage: "drives", kind: "feature", risk: "low" }));
  revokeToolkit(r.dir);
  const j = await ensureJobToolkit(r.dir, readJobAt(dir));
  assert.equal(j.toolkitRef, "");
  const dropped = toolkitDropped(dir, j);
  assert.deepEqual(dropped, { needsApp: ["C1"], highRisk: false }, "C1 drives the app: C2 alone must not make it PASS");
  const m = move(j, "paused", { toolkitDropped: dropped ?? undefined, now: new Date().toISOString() });
  assert.ok("job" in m, "refused" in m ? m.refused : "");
  assert.deepEqual([m.job.stage, m.job.waitFor, m.job.pausedFrom], ["paused", "no-toolkit", "drives"]);
  assert.equal(toolkitDropped(dir, { ...j, checksOnly: true }), null, "resumed into checks only: it goes on");
  assert.equal(toolkitDropped(dir, { ...j, stage: "intake" }), null, "intake decides that itself");
  assert.notEqual(toolkitDropped(dir, { ...j, checksOnly: true, riskFloor: "high" }), null, "high risk never goes on without one");
});

test("the verdict names the Toolkit its proofs ran with (review M4)", () => {
  const v = renderVerdict(
    { verdict: "PASS", criteria: [], manifestOk: true, nonDiscriminating: [], argsDeltas: [] } as unknown as Parameters<typeof renderVerdict>[0],
    "h",
    1,
    "abc",
  );
  assert.match(v, /^TOOLKIT: abc$/m);
  assert.match(
    renderVerdict({ verdict: "PASS", criteria: [], manifestOk: true, nonDiscriminating: [], argsDeltas: [] } as never, "h", 1, ""),
    /^TOOLKIT: none$/m,
  );
});

test("ensureIgnored is idempotent (review L7)", async () => {
  const r = repo("ignore");
  await ensureIgnored(r.dir);
  await ensureIgnored(r.dir);
  await recordPassed(r.dir, r.setup);
  const ex = fs.readFileSync(path.join(r.dir, ".git", "info", "exclude"), "utf8");
  assert.equal(ex.split("\n").filter((l) => l === ".kitchen/toolkit.approved").length, 1, ex);
  assert.equal(git(r.dir, "status", "--porcelain"), "");
});

test("a trusted checkout runs only as the sha: one a sandboxed run used, or one changed, is made again (review L8)", async () => {
  const r = repo("pristine");
  let co = await toolkitCheckout(r.dir, r.setup); // untrusted: it may write in its checkout
  co.release();
  fs.writeFileSync(path.join(co.dir, ".kitchen", "toolkit", "planted.js"), "evil\n");
  fs.mkdirSync(path.join(co.dir, ".kitchen", "toolkit", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(co.dir, ".kitchen", "toolkit", "node_modules", "x.js"), "evil\n");
  await recordPassed(r.dir, r.setup, "kitchen/setup");
  await approveToolkit(r.dir, {});
  co = await toolkitCheckout(r.dir, r.setup);
  co.release();
  assert.equal(co.trust, "approved");
  assert.equal(fs.existsSync(path.join(co.dir, ".kitchen", "toolkit", "planted.js")), false, "made again from the sha");
  assert.equal(fs.existsSync(path.join(co.dir, ".kitchen", "toolkit", "node_modules")), false, "an untrusted prepare's leftovers too");
  // Trusted and clean: kept (its own prepare's ignored files stay).
  fs.writeFileSync(path.join(co.dir, "keep.txt"), "x\n");
  git(co.dir, "update-index", "--refresh");
  co = await toolkitCheckout(r.dir, r.setup);
  co.release();
  assert.equal(fs.existsSync(path.join(co.dir, "keep.txt")), false, "an untracked file is a change: made again");
});
