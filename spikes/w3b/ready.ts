// W3b exit, Ready: on fixture A with the GitHub forge (gh shim + a local bare remote),
// the scripted agent (fake-agent.ts) and the real Toolkit, Docker and engine.
//   node spikes/w3b/ready.ts <scratch>
// One job walks: … review → ready, CI pending → paused(ci) → CI red → ready → build
// (round 2) → … → ready, the base moved with a conflicting commit → build (round 3, the
// builder resolves the merge the engine left in progress) → … → ready → report → done,
// with the report, the evidence branch, the PR comment and the PR marked ready.
import fs from "node:fs";
import path from "node:path";
import { BUG, check, finish, jobDir, jobOf, kitchenContainers, stagesOf, stepUntil, ticket } from "../w3a/lib.ts";
import { commitOnRemote, editShim, git, githubFixture, HERE, shimState } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work"));
fs.mkdirSync(root, { recursive: true });
const { r, shim, bare } = githubFixture(root, "ready", {
  agent: `{ tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-agent.ts"))} }`,
  bug: true,
  extra: "backoff: { base_sec: 1, max_sec: 2 }\n",
});
fs.writeFileSync(path.join(r.dir, "kitchen.yaml"), fs.readFileSync(path.join(r.dir, "kitchen.yaml"), "utf8").replace("round_limit: 3", "round_limit: 4"));
git(r.dir, "commit", "-qam", "round limit 4");
git(r.dir, "push", "-q", bare, "main:main");
const id = ticket(r, "Dark mode doesn't stick: I turn it on in Settings, it says Saved, but after a reload the app is light again.\n\nscenario: honest");
const log = path.join(root, "ready.log");
fs.writeFileSync(log, "");
const walk = () => stagesOf(r, id).join(" → ");
const at = (stop: string[], max = 40) => stepUntil(r, id, stop, { max, log });

// 1. to review, then CI pending at Ready
at(["review", "needs-human", "done"]);
check("reached review on the GitHub forge (draft PR opened by the engine)", jobOf(r, id).stage === "review" && jobOf(r, id).pr !== null, walk());
const pr = jobOf(r, id).pr as number;
check(
  "the PR is a draft from kitchen/<job> into main",
  (() => {
    const p = shimState(shim).prs.find((x) => x.number === pr);
    return !!p && p.isDraft && p.head === jobOf(r, id).branch && p.base === "main";
  })(),
);
editShim(shim, (s) => {
  const p = s.prs.find((x) => x.number === pr);
  if (p) p.checks = [{ name: "ci/test", bucket: "pending" }];
});
at(["paused", "report", "build", "needs-human"]);
let j = jobOf(r, id);
check(
  "CI pending → paused(ci), the slot released",
  j.stage === "paused" && j.waitFor === "ci" && j.pausedFrom === "ready" && j.slot === null,
  `${j.stage} ${j.waitFor}`,
);

// 2. CI goes red → back to ready → build (a round)
editShim(shim, (s) => {
  const p = s.prs.find((x) => x.number === pr);
  if (p) p.checks = [{ name: "ci/test", bucket: "fail" }];
});
at(["build", "report", "needs-human"], 3);
j = jobOf(r, id);
check("CI red → ready → build, round 2", j.stage === "build" && j.round === 2, `${walk()} (round ${j.round})`);
check("the builder is told CI was red (ci.md)", fs.existsSync(path.join(jobDir(r, id), "rounds", "1", "ci.md")));
editShim(shim, (s) => {
  const p = s.prs.find((x) => x.number === pr);
  if (p) p.checks = [{ name: "ci/test", bucket: "pass" }];
});

// 3. back to review, then someone else's commit lands on main touching the same line
at(["review", "needs-human", "done"]);
const theirs = commitOnRemote(bare, root, "server.js", (t) => t.replace(BUG.to, `${BUG.to} // tracked upstream`), "upstream: annotate the theme update");
at(["build", "report", "needs-human", "done"], 3);
j = jobOf(r, id);
check("the base moved with a conflicting commit → ready → build, round 3", j.stage === "build" && j.round === 3, `${walk()} (round ${j.round})`);
const sync = JSON.parse(fs.readFileSync(path.join(jobDir(r, id), "sync.json"), "utf8")) as { base: string; conflicts: string[] };
check(
  "the conflict is recorded for the builder (sync.json: the base tip and the file)",
  sync.base === theirs && sync.conflicts.includes("server.js"),
  JSON.stringify(sync),
);

// 4. the builder resolves, the engine concludes the merge; everything runs again; done
at(["done", "needs-human", "paused"], 60);
j = jobOf(r, id);
check("→ done", j.stage === "done", walk());
const parents = git(r.dir, "log", "--format=%P", "-1", "--merges", j.branch).trim().split(" ");
const isMerge = git(r.dir, "log", "--merges", "--format=%H", j.branch).split("\n").filter(Boolean).length >= 1 && parents.includes(theirs);
check("the job branch has the merge with the base tip (two parents, one is the upstream commit)", isMerge, parents.join(" "));
const server = git(r.dir, "show", `${j.branch}:server.js`);
check(
  "no conflict markers left, both changes kept",
  !/^(<<<<<<<|=======|>>>>>>>)/m.test(server) && server.includes("// tracked upstream") && server.includes(BUG.from),
);
check("job.base moved to the synced base tip", j.base === theirs);
check("sync.json is gone once the merge is committed", !fs.existsSync(path.join(jobDir(r, id), "sync.json")));
const w = walk();
check("Gate, drives and Verify ran again after the sync", /ready → build → gate → drives → verify → review → ready → report → done$/.test(w), w);
check("report.html rendered (placeholder template, W4)", fs.existsSync(path.join(jobDir(r, id), "report.html")));
const tree = git(bare, "ls-tree", "-r", "--name-only", "kitchen-evidence").split("\n");
check(
  "evidence branch: the job's folder with report.html and the manifest",
  tree.includes(`${id}/report.html`) && tree.includes(`${id}/evidence/manifest.jsonl`),
  `${tree.length} files`,
);
const p = shimState(shim).prs.find((x) => x.number === pr);
const comment = p?.comments.find((c) => c.body.includes(`kitchen:${id}/report-comment`));
check(
  "PR comment: one table of criterion, verdict and evidence links",
  !!comment && /\| C1 [^|]*\|[^|]*\| engine \| PASS \|/.test(comment.body) && comment.body.includes("kitchen-evidence"),
  comment?.body.split("\n").slice(0, 8).join(" / "),
);
check("the PR is marked ready for review", p?.isDraft === false);
check("the branch on the remote is the final head", git(bare, "rev-parse", `refs/heads/${j.branch}`).trim() === git(r.dir, "rev-parse", j.branch).trim());
check("no container of this job left running", kitchenContainers(j.slotId).length === 0);
finish("w3b ready");
