// The path job 002 took in library-demo, end to end with a real Toolkit and a scripted smith: an APPROVED
// Toolkit (trusted checkout in $KITCHEN_HOME, not under <repo>/.worktrees) → a Toolkit gap → the toolkit
// stage → the base's own check and the check of the smith's commit. Also: the smith's change to the app is
// refused before its commit and the smith is sent back once with the reason; a job that escalated on an
// engine error resumes with `kitchen resume`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import type { AgentRequest } from "../../agents/adapter.ts";
import { FakeAdapter } from "../../agents/fake.ts";
import { resume } from "../../cli/commands.ts";
import { loadConfig } from "../../config.ts";
import { forgeFor } from "../../forge/forge.ts";
import { approveToolkit } from "../../toolkit/approve.ts";
import { recordPassed } from "../../toolkit/trust.ts";
import { resolveToolkitRef } from "../job-toolkit.ts";
import { createJob, jobDirOf, readJobAt, updateJob } from "../store.ts";
import { toolkit } from "./toolkit.ts";

const KITCHEN = path.resolve(import.meta.dirname, "..", "..", "..");
let root = "";
const saved = process.env.KITCHEN_HOME;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-tk-approved-")));
  process.env.KITCHEN_HOME = path.join(root, "home");
});
afterAll(() => {
  if (saved === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

/** library-demo as it was: the API app on main, an API-only Toolkit (no browser module) on kitchen/setup. */
function libraryRepo(): { dir: string; base: string; setup: string } {
  const dir = path.join(root, "library");
  fs.cpSync(path.join(KITCHEN, "fixtures", "e-library"), dir, { recursive: true });
  fs.appendFileSync(path.join(dir, ".gitignore"), ".kitchen/jobs/\n.worktrees/\n");
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "kitchen/setup");
  const tk = path.join(dir, ".kitchen", "toolkit");
  fs.mkdirSync(path.join(tk, "lib"), { recursive: true });
  for (const f of ["bin/dev", "lib/common.mjs", ".gitignore"]) {
    fs.mkdirSync(path.dirname(path.join(tk, f)), { recursive: true });
    fs.copyFileSync(path.join(KITCHEN, "toolkit-template", f), path.join(tk, f));
  }
  fs.chmodSync(path.join(tk, "bin", "dev"), 0o755);
  fs.cpSync(path.join(KITCHEN, "fixtures", "e-library-toolkit"), tk, { recursive: true });
  git(dir, "add", "-f", ".kitchen/toolkit");
  git(dir, "commit", "-q", "-m", "toolkit");
  const setup = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  return { dir, base, setup };
}

/** The smith's primitive: a read-only `count` of a table's rows, added to app.mjs's primitives. */
const COUNT = `    count: {
      args: { table: "books | loans | members (default books)" },
      does: "how many rows a table holds in the app's data file",
      run(ctx, a) {
        const data = JSON.parse(fs.readFileSync(dataFile(ctx), "utf8"));
        const rows = data[a.table === undefined ? "books" : String(a.table)];
        return Array.isArray(rows) ? { ok: true, out: rows.length } : { ok: false, out: "no such table" };
      },
    },
`;

test("approved Toolkit → Toolkit gap → toolkit stage: the smith's app change is refused and sent back once, the trusted base check and the smith's check pass, the commit is offered", async () => {
  const r = libraryRepo();
  await recordPassed(r.dir, r.setup, "kitchen/setup");
  await approveToolkit(r.dir, {});
  const t = await resolveToolkitRef(r.dir, r.base);
  assert.equal(t.from, "approved");
  const { job: created } = await createJob(r.dir, {
    title: "count rows",
    ticket: { source: "prompt", id: "p-count" },
    body: "x",
    roundLimit: 3,
    base: r.base,
    toolkitRef: t.ref,
    toolkitFrom: t.from,
  });
  const job = await updateJob(r.dir, created.id, (j) => ({
    ...j,
    stage: "toolkit",
    gap: "count",
    returnTo: "drives",
    smith: { attempts: 1, toolkitPr: null },
  }));
  const dir = jobDirOf(r.dir, job.id);
  const prompts: string[] = [];
  const agent = new FakeAdapter((req: AgentRequest) => {
    prompts.push(req.prompt);
    const app = path.join(req.cwd, ".kitchen", "toolkit", "app.mjs");
    if (req.outFile === "smith.md") {
      // First try: the primitive, plus a test route in the app (what the real smith did with /__t).
      fs.writeFileSync(app, fs.readFileSync(app, "utf8").replace("  primitives: {\n", `  primitives: {\n${COUNT}`));
      fs.appendFileSync(path.join(req.cwd, "server.js"), "\n// test page for the smith: /__t\n");
    } else {
      // Sent back: the app change was put back before it saw the reason.
      assert.equal(git(req.cwd, "status", "--porcelain", "--", "server.js"), "", "server.js was put back");
      assert.match(fs.readFileSync(app, "utf8"), /count: \{/, "its Toolkit change stayed");
    }
    return { file: "STATUS: READY\nPRIMITIVE: count\nSUMMARY: count rows of a table\n", line: "READY" };
  });
  const lines: string[] = [];
  const cfg = loadConfig(r.dir);
  const p = await toolkit({
    repo: r.dir,
    job,
    jobDir: dir,
    config: cfg,
    agent,
    forge: forgeFor(r.dir, cfg),
    source: undefined as never,
    now: () => new Date(),
    log: (l) => lines.push(l),
    refresh: () => readJobAt(dir),
    holdsLock: () => true,
  });
  const log = lines.join("\n");
  assert.equal(agent.calls.length, 2, "sent back once");
  assert.match(log, /refused, put back: the smith changed files outside the Toolkit: server\.js: the smith changes the Toolkit only/);
  assert.match(prompts[1], /REFUSED: you changed files outside the Toolkit/);
  assert.match(prompts[1], /`data:` URL/);
  assert.doesNotMatch(log, /neither a git checkout/);
  assert.match(log, /the base's own check at/);
  assert.equal(p.to, "drives", log);
  assert.deepEqual({ ...p.facts.toolkit, sha: undefined }, { checkPassed: true, sha: undefined, pr: null, approvable: true });
  // The smith's commit holds its Toolkit change only.
  const changed = git(r.dir, "diff", "--name-only", `${t.ref}..${p.facts.toolkit?.sha}`);
  assert.equal(changed, ".kitchen/toolkit/app.mjs");
}, 120_000);

test("a job that escalated on an engine error resumes with `kitchen resume`: back to the stage it escalated from", async () => {
  const r = { dir: path.join(root, "library") };
  const { job: created } = await createJob(r.dir, {
    title: "stuck",
    ticket: { source: "prompt", id: "p-stuck" },
    body: "x",
    roundLimit: 3,
    base: git(r.dir, "rev-parse", "main"),
  });
  await updateJob(r.dir, created.id, (j) => ({
    ...j,
    stage: "needs-human",
    escalatedFrom: "toolkit",
    gap: "count",
    smith: { attempts: 1, toolkitPr: null },
    pausedReason: "engine-error: --src /x/checkouts/_trusted@abc is neither a git checkout nor a worktree under /x/.worktrees",
  }));
  const out: string[] = [];
  assert.equal(await resume(r.dir, created.id, (l) => out.push(l)), 0, out.join("\n"));
  assert.equal(readJobAt(jobDirOf(r.dir, created.id)).stage, "toolkit");
  // A needs-human job that is a real question for the person still wants feedback.
  const { job: q } = await createJob(r.dir, {
    title: "limit",
    ticket: { source: "prompt", id: "p-limit" },
    body: "x",
    roundLimit: 3,
    base: git(r.dir, "rev-parse", "main"),
  });
  await updateJob(r.dir, q.id, (j) => ({ ...j, stage: "needs-human", escalatedFrom: "build", pausedReason: "round-limit" }));
  assert.equal(await resume(r.dir, q.id, () => {}), 1);
});
