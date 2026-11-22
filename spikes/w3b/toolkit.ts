// W3b exit, the toolkit stage: a job that needs a new primitive, on fixture A with the
// GitHub forge (gh shim + a local bare remote), the real Toolkit, Docker and engine.
//   node spikes/w3b/toolkit.ts fake|claude <scratch>
// fake:   the scripted agent (fake-agent.ts, scenario primitive: its smith writes a real `sql` primitive)
// claude: every role on Claude Code (sonnet for strong roles, haiku for medium), the smith included
// Walk: intake → spec (names the missing `sql`) → toolkit (smith on its own Toolkit branch in an
// engine worktree; the engine checks base + that branch, sandboxed; Toolkit PR via the forge) →
// spec → … → review → ready → paused(toolkit-pr) → the shim merges the PR on the remote → ready
// (sync: toolkitRef moves to the new base) → gate → drives → verify → review → ready → report → done.
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_BIN, check, finish, jobDir, jobOf, kitchenContainers, ledger, stagesOf, stepUntil, ticket } from "../w3a/lib.ts";
import { editShim, git, githubFixture, HERE, mergeOnRemote, shimState } from "./lib.ts";

const tool = process.argv[2];
if (tool !== "fake" && tool !== "claude" && tool !== "buggy") throw new Error("usage: toolkit.ts fake|claude|buggy <scratch>");
const root = path.resolve(process.argv[3] ?? path.join(HERE, ".work"));
fs.mkdirSync(root, { recursive: true });
if (tool === "buggy") {
  await buggyBase(root);
  finish("w3b toolkit (buggy base)");
  process.exit(0);
}

/**
 * Review fix B1 (+ the toolkit → toolkit retry), scripted smith. The base has fixture A's planted
 * dark-mode bug, which the base's own `settings.toggle-dark` drive exercises: that drive fails on the
 * base with or without any Toolkit change. The smith's first try leaves a stub `sql` (the contract
 * probe refuses it) → toolkit → toolkit; the second try, started from the stub and told why, writes
 * the real one. Its check passes with the base's failing drive tolerated as known → Toolkit PR → paused.
 */
async function buggyBase(root: string) {
  const agent = `{ tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-agent.ts"))} }`;
  const { r, shim } = githubFixture(root, "toolkit-buggy", { agent, bug: true });
  const id = ticket(
    r,
    "Record when each user last signed in: every successful sign-in stores the time on the user (a last_login_at timestamp).\n\nscenario: primitive-retry",
  );
  const log = path.join(root, "toolkit-buggy.log");
  fs.writeFileSync(log, "");
  const base0 = jobOf(r, id).base;
  stepUntil(r, id, ["paused", "done", "needs-human", "rejected", "needs-info"], { max: 40, log });
  const j = jobOf(r, id);
  const w = stagesOf(r, id).join(" → ");
  check(
    "buggy: spec → toolkit → toolkit (the second try) → spec … → ready → paused(toolkit-pr)",
    /spec → toolkit → toolkit → spec/.test(w) && j.stage === "paused" && j.waitFor === "toolkit-pr",
    `${w} [${j.stage} ${j.waitFor ?? ""} ${j.pausedReason ?? ""}]`,
  );
  const baseFile = path.join(r.dir, ".kitchen", "toolkit-base-checks", `${base0}.json`);
  const bc = fs.existsSync(baseFile) ? (JSON.parse(fs.readFileSync(baseFile, "utf8")) as { ok: boolean; failing: string[] }) : null;
  check(
    "buggy: the base's own check ran once per base sha and lists the drive the planted bug fails",
    !!bc?.failing.includes("settings.toggle-dark"),
    JSON.stringify(bc),
  );
  const ran = (fs.readFileSync(log, "utf8").match(/the base's own check at/g) ?? []).length;
  check("buggy: cached: the second try reused it (one base run for two smith tries)", ran === 1, `${ran} runs`);
  const rd = (n: number) => {
    const f = path.join(jobDir(r, id), "rounds", "1", `toolkit-check-${n}.json`);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as { ok: boolean; failed?: string; known?: string[]; sha: string }) : null;
  };
  const c1 = rd(1);
  const c2 = rd(2);
  check(
    "buggy: try 1 (the stub) failed the engine's check at the contract probe, not at the base's bug",
    c1?.ok === false && c1.failed === "contract probe",
    JSON.stringify({ ok: c1?.ok, failed: c1?.failed, known: c1?.known }),
  );
  check(
    "buggy: try 2 passed with settings.toggle-dark tolerated as known (it fails on the base too)",
    c2?.ok === true && !!c2.known?.includes("settings.toggle-dark") && c2.sha === j.toolkitRef,
    JSON.stringify({ ok: c2?.ok, known: c2?.known }),
  );
  check(
    "buggy: try 2's branch starts from try 1's commit",
    (() => {
      try {
        git(r.dir, "merge-base", "--is-ancestor", `kitchen/toolkit/${id}-1`, `kitchen/toolkit/${id}-2`);
        return true;
      } catch {
        return false;
      }
    })(),
  );
  check("buggy: two smith attempts", j.smith.attempts === 2, String(j.smith.attempts));
  const tpr = shimState(shim).prs.find((p) => p.head === `kitchen/toolkit/${id}-2`);
  check(
    "buggy: the Toolkit PR names the drive that already fails on the base",
    !!tpr && /Known on the base:.*settings\.toggle-dark/.test(tpr.body),
    tpr?.body.split("\n").find((l) => l.includes("Known")) ?? "no PR",
  );
  check("buggy: no container of this job left running", kitchenContainers(j.slotId).length === 0);
}
const agent =
  tool === "fake"
    ? `{ tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-agent.ts"))} }`
    : `{ tool: claude, command: [${JSON.stringify(CLAUDE_BIN)}], models: { strong: sonnet, medium: haiku }, timeout_sec: 1800, max_turns: 80 }`;
const { r, shim, bare } = githubFixture(root, `toolkit-${tool}`, { agent });
const text =
  "Record when each user last signed in: every successful sign-in stores the time on the user (a last_login_at timestamp). Nothing shows it in the UI yet; a later ticket will." +
  (tool === "fake" ? "\n\nscenario: primitive" : "");
const id = ticket(r, text);
const log = path.join(root, `toolkit-${tool}.log`);
fs.writeFileSync(log, "");
const walk = () => stagesOf(r, id).join(" → ");
const t0 = Date.now();
const at = (stop: string[], max = 40) => stepUntil(r, id, stop, { max, log });
const base0 = jobOf(r, id).base;
check("the job is pinned to the base's Toolkit at creation (toolkitRef = the base sha)", jobOf(r, id).toolkitRef === base0, jobOf(r, id).toolkitRef);

at(["paused", "done", "needs-human", "rejected", "needs-info"], 60);
let j = jobOf(r, id);
const w1 = walk();
check("→ toolkit: the job needed a primitive it didn't have", /→ toolkit → /.test(w1), w1);
const smithSha = j.toolkitRef;
const branches = git(r.dir, "branch", "--list", "kitchen/toolkit/*").trim();
check("the smith worked on its own Toolkit branch (kitchen/toolkit/<job>-<n>)", branches.includes(`kitchen/toolkit/${id}-1`), branches);
check(
  "toolkitRef is the smith's real commit sha on that branch (not a describe hash)",
  /^[0-9a-f]{40}$/.test(smithSha) && git(r.dir, "rev-parse", `kitchen/toolkit/${id}-1`).trim() === smithSha,
  smithSha,
);
const smithFiles = git(r.dir, "diff", "--name-only", base0, smithSha).trim().split("\n");
check(
  "the Toolkit branch changes only .kitchen/toolkit/ (outside features/)",
  smithFiles.every((f) => f.startsWith(".kitchen/toolkit/") && !f.includes("/features/")),
  smithFiles.join(", "),
);
const jobFiles = git(r.dir, "diff", "--name-only", base0, j.branch).trim().split("\n");
check(
  "the job branch carries no Toolkit primitive edit",
  !jobFiles.some((f) => f.startsWith(".kitchen/toolkit/") && !f.includes("/features/")),
  jobFiles.join(", "),
);
const checkFile = path.join(jobDir(r, id), "rounds", "1", "toolkit-check-1.json");
const tc = fs.existsSync(checkFile) ? (JSON.parse(fs.readFileSync(checkFile, "utf8")) as { ok: boolean; sha: string }) : null;
check("the engine proved base + the Toolkit branch with toolkit check (sandboxed: unmerged)", tc?.ok === true && tc.sha === smithSha, JSON.stringify(tc));
check(
  "its describe lists the new primitive (sql)",
  fs.readFileSync(log, "utf8").includes("toolkit check of") && git(r.dir, "show", `${smithSha}:.kitchen/toolkit/bin/dev`).includes("sql"),
);
const st = shimState(shim);
const tpr = st.prs.find((p) => p.head === `kitchen/toolkit/${id}-1`);
check(
  "Toolkit PR opened through the forge (branch pushed to the remote, labelled kitchen-toolkit)",
  !!tpr && tpr.labels.includes("kitchen-toolkit") && git(bare, "rev-parse", `refs/heads/kitchen/toolkit/${id}-1`).trim() === smithSha,
  `#${tpr?.number}`,
);
check("job.smith.toolkitPr names it", j.smith.toolkitPr === tpr?.number);
check(
  "the job's Toolkit ran from the engine-owned checkout _toolkit@<smith sha>, sandboxed",
  /_toolkit@[0-9a-f]{12}/.test(j.toolkitBin) || /sandbox/.test(j.toolkitBin),
  j.toolkitBin,
);
check("Ready waits: paused(toolkit-pr)", j.stage === "paused" && j.waitFor === "toolkit-pr" && j.pausedFrom === "ready", `${j.stage} ${j.waitFor} (${w1})`);

// A human merges the Toolkit PR on GitHub: the shim marks it merged, the remote's main gets the merge commit.
const merged = mergeOnRemote(bare, `kitchen/toolkit/${id}-1`, root);
editShim(shim, (s) => {
  const p = s.prs.find((x) => x.number === tpr?.number);
  if (p) p.state = "MERGED";
});
at(["done", "needs-human", "rejected"], 40);
j = jobOf(r, id);
const w2 = walk();
check("→ done", j.stage === "done", w2);
check(
  "toolkitRef moved to the new base (the merge of the Toolkit PR)",
  j.toolkitRef === merged && j.base === merged,
  `${j.toolkitRef.slice(0, 12)} vs ${merged.slice(0, 12)}`,
);
check(
  "after the merge: paused → ready → gate → drives → verify → review → ready → report → done",
  /paused → ready → gate → drives → verify → review → ready → report → done$/.test(w2),
  w2,
);
check(
  "the job ran from the merged base's checkout, no longer sandboxed",
  j.toolkitBin.includes(`_toolkit@${merged.slice(0, 12)}`) && !j.toolkitBin.includes("sandbox"),
  j.toolkitBin,
);
const pr = st.prs.find((p) => p.head === j.branch) ?? shimState(shim).prs.find((p) => p.head === j.branch);
const final = shimState(shim).prs.find((p) => p.number === pr?.number);
check("job PR: report comment posted and marked ready", !!final?.comments.some((c) => c.body.includes("report-comment")) && final.isDraft === false);
check("evidence branch has the job's folder", git(bare, "ls-tree", "--name-only", "kitchen-evidence").includes(id));
check("no container of this job left running", kitchenContainers(j.slotId).length === 0);
const agents = ledger(r).filter((l) => l.job === id && l.event === "agent");
const usd = agents.reduce((n, a) => n + (a.usd ?? 0), 0);
const smith = agents.filter((a) => a.role === "smith");
console.log(`    path: ${w2}`);
console.log(
  `    agents: ${agents.map((a) => `${a.role}${a.model ? `(${a.model})` : ""} ${Math.round(a.secs ?? 0)}s${a.usd ? ` $${a.usd.toFixed(3)}` : ""}`).join(", ")}`,
);
console.log(
  `    smith: ${smith.map((a) => `${Math.round(a.secs ?? 0)}s $${(a.usd ?? 0).toFixed(3)}`).join(", ")}; total ${Math.round((Date.now() - t0) / 1000)}s, $${usd.toFixed(3)}`,
);
fs.writeFileSync(
  path.join(root, `toolkit-${tool}.json`),
  JSON.stringify({ tool, job: id, path: w2, usd, secs: Math.round((Date.now() - t0) / 1000), smithSha, merged, agents }, null, 2),
);
finish(`w3b toolkit (${tool})`);
