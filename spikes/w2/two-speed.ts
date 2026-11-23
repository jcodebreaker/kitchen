// ADR 0010 (two-speed init), proven with the real CLI and no model, no Docker:
//  1. `kitchen init` on fixtures E (Node) and B (Python): seconds, the checks found
//     and run once, no agent, no worktree, no Toolkit.
//  2. A ticket whose criterion drives the app pauses at intake: no-toolkit, with the
//     message; `kitchen resume` refuses while a built Toolkit waits for approval (ADR 0015).
//  3. `kitchen toolkit build` (scripted setup role copying fixture E's bench Toolkit,
//     real `toolkit check` on a node app): one line per phase, details in init.log.
//  4. Approved (no merge), the job wakes at once: its toolkitRef is the approved commit, its
//     base stays, and intake runs again with it.
//  5. Another repo, no Toolkit: `kitchen resume` goes on with checks and tests only.
//   node spikes/w2/two-speed.ts [scratch dir]
import fs from "node:fs";
import path from "node:path";
import { check, finish, fixtureRepo, git, HERE, kitchen, ROOT, readJson } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work", "two-speed"));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const show = (label: string, out: string) => console.log(`\n$ kitchen ${label}\n${out.trimEnd().replace(/^/gm, "  ")}\n`);
const ledger = (dir: string) =>
  fs.existsSync(path.join(dir, ".kitchen", "ledger.jsonl"))
    ? fs
        .readFileSync(path.join(dir, ".kitchen", "ledger.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; stage: string; result: string })
    : [];

// ---------- 1. quick init ----------
for (const fx of ["e-library", "b-cli"]) {
  const r = fixtureRepo(root, fx, `${fx}-quick`);
  const t0 = Date.now();
  const x = kitchen(r, ["init"]);
  const secs = (Date.now() - t0) / 1000;
  show(`init   (${fx}, ${secs.toFixed(1)}s)`, x.out);
  check(`${fx}: kitchen init exits 0 in seconds`, x.code === 0 && secs < 20, `${secs.toFixed(1)}s`);
  check(`${fx}: the checks were found and passed on the base`, /✓ Ran the checks +\S+ passed/.test(x.out), x.out.match(/Ran the checks.*/)?.[0]);
  check(`${fx}: no agent ran`, !ledger(r.dir).some((e) => e.event === "agent") && /no agent$/m.test(x.out));
  check(
    `${fx}: no worktree, no Toolkit, no setup branch`,
    !fs.existsSync(path.join(r.dir, ".worktrees")) && !fs.existsSync(path.join(r.dir, ".kitchen", "toolkit")) && !git(r.dir, "branch", "--list", "kitchen/*"),
  );
}

// ---------- 2–4. a ticket that needs the app, the build, the wake ----------
const yaml = `agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-setup.ts"))} }\nconcurrency: 1\n`;
const r = fixtureRepo(root, "e-library", "e-library-jobs", { yaml });
Object.assign(r.env, { W2_TOOLKIT_DIR: path.join(ROOT, "bench", "toolkits", "e-library"), W2_NO_QUESTIONS: "1", W2_INTAKE_APP: "1" });
check(
  "init on a repo with its own kitchen.yaml keeps it and adds the checks",
  kitchen(r, ["init"]).code === 0 && /checks:/.test(fs.readFileSync(path.join(r.dir, "kitchen.yaml"), "utf8")),
);
git(r.dir, "add", "-A");
git(r.dir, "commit", "-q", "-m", "kitchen: config and skill");
const t = kitchen(r, ["ticket", "List Dune on GET /books"]);
const id = /ticket (\S+)/.exec(t.out)?.[1] ?? "?";
kitchen(r, ["run", "--once"]);
const job = () =>
  readJson<{ stage: string; waitFor?: string; pausedReason?: string; pausedFrom?: string; base: string; toolkitRef: string; checksOnly?: boolean }>(
    path.join(r.dir, ".kitchen", "jobs", id, "job.json"),
  );
let j = job();
check(
  "the ticket needs the app: paused no-toolkit at intake",
  j.stage === "paused" && j.waitFor === "no-toolkit" && j.pausedFrom === "intake",
  `${j.stage} ${j.waitFor} from ${j.pausedFrom}`,
);
check(
  "with the message",
  j.pausedReason === "This ticket needs Kitchen to drive the app; run `kitchen toolkit build` (about 3–15 min), then approve it. The job wakes by itself.",
  j.pausedReason,
);
const st = kitchen(r, ["status"]);
show("status", st.out);
check("kitchen status shows paused(no-toolkit)", /paused\(no-toolkit, from intake\)/.test(st.out));

const b = kitchen(r, ["toolkit", "build"]);
show("toolkit build", b.out);
check("toolkit build: done, one line per phase", b.code === 0 && b.out.trim().split("\n").length <= 8, `${b.out.trim().split("\n").length} lines`);
check(
  "toolkit build: Read the repo, Wrote the Toolkit, Proved it",
  /✓ Read the repo/.test(b.out) && /✓ Wrote the Toolkit/.test(b.out) && /✓ Proved it +4 drives × 2/.test(b.out),
);
check("toolkit build: without a terminal it ends waiting for approval", /Proven, waiting for your approval: approve it \(kitchen toolkit approve\)/.test(b.out));
check("toolkit build: no per-drive lines on the terminal", !/toolkit check: drive/.test(b.out));
const initLog = fs.readFileSync(path.join(r.dir, ".kitchen", "init", "init.log"), "utf8");
check("init.log holds the details", /toolkit check: drive books.list ok/.test(initLog) && /toolkit build: committed on kitchen\/setup/.test(initLog));
const v = kitchen(r, ["toolkit", "build", "--status"]);
check("toolkit build --status: done, waiting for approval", /^toolkit build: done: proven, waiting for your approval/.test(v.out), v.out.split("\n")[0]);

const early = kitchen(r, ["resume", id]);
show(`resume ${id}  (before the approval)`, early.out);
check(
  "resume before the approval: refused, says to approve it",
  early.code === 1 && /kitchen toolkit approve/.test(early.out) && job().stage === "paused",
);

const before = git(r.dir, "rev-parse", "HEAD");
const setupTip = git(r.dir, "rev-parse", "kitchen/setup");
const a = kitchen(r, ["toolkit", "approve"]);
show("toolkit approve", a.out);
check("approved: one line, and the waiting job woke", a.code === 0 && /1 waiting job woke/.test(a.out), a.out.trim());
const w = kitchen(r, ["run", "--once"]);
j = job();
check("no merge, no commit: the base branch is where it was", git(r.dir, "rev-parse", "HEAD") === before);
check(
  "its toolkitRef is the approved commit; its base stays",
  j.base === before && j.toolkitRef === setupTip,
  `${j.base.slice(0, 8)} ${j.toolkitRef.slice(0, 8)} vs ${setupTip.slice(0, 8)}; ${w.code}`,
);
check(
  "intake ran again with the Toolkit and went on to build",
  ledger(r.dir).some((e) => e.event === "move" && e.stage === "intake" && e.result === "build"),
);

// ---------- 5. going on without a Toolkit ----------
const s = fixtureRepo(root, "e-library", "e-library-checks-only", { yaml });
Object.assign(s.env, { W2_INTAKE_APP: "1" });
kitchen(s, ["init"]);
const t2 = kitchen(s, ["ticket", "List Dune on GET /books"]);
const id2 = /ticket (\S+)/.exec(t2.out)?.[1] ?? "?";
kitchen(s, ["run", "--once"]);
const res = kitchen(s, ["resume", id2]);
show(`resume ${id2}  (no Toolkit anywhere)`, res.out);
check("resume without a Toolkit: goes on with checks and tests only", res.code === 0 && /goes on without a Toolkit/.test(res.out));
kitchen(s, ["run", "--once"]);
const j2 = readJson<{ stage: string; checksOnly?: boolean; toolkitRef: string }>(path.join(s.dir, ".kitchen", "jobs", id2, "job.json"));
check(
  "the job is checksOnly and got past intake",
  j2.checksOnly === true && j2.toolkitRef === "" && ledger(s.dir).some((e) => e.event === "move" && e.stage === "intake" && e.result === "build"),
);

finish("w2 two-speed (ADR 0010)");
