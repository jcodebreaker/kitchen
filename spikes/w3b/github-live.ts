// W3b, NOT RUN: the GitHub forge and ticket source against a REAL throwaway repository.
// Everything here is outward-facing (pushes, PRs, comments, labels, issues on your
// account), so it only runs when you name the repo and confirm:
//   KITCHEN_GH_TEST_REPO=<owner>/<throwaway> node spikes/w3b/github-live.ts --yes-this-repo-is-throwaway <scratch>
// Needs: `gh auth status` logged in with repo scope (the engine's credentials; no agent
// runs here), and an EMPTY or disposable repo: the script pushes branches kitchen/live-*,
// kitchen/toolkit/live-*, kitchen-evidence, opens two PRs, comments, labels, one issue,
// then closes the PRs and the issue and deletes the branches it pushed (the evidence
// branch is left for you to look at; delete it by hand).
// It is the same sequence spikes/w3b/forge.ts proves against the gh shim, so a FAIL
// here is a difference between the shim and real GitHub (record it in results.md).
import fs from "node:fs";
import path from "node:path";
import { parseConfig } from "../../src/config.ts";
import { baseTip } from "../../src/engine/base.ts";
import { GithubForge, gh, REVIEW_REQUIRED } from "../../src/forge/github.ts";
import { GithubSource } from "../../src/sources/github.ts";
import { check, finish, makeFixtureRepo } from "../w3a/lib.ts";
import { git } from "./lib.ts";

const slug = process.env.KITCHEN_GH_TEST_REPO;
const args = process.argv.slice(2);
if (!slug || !args.includes("--yes-this-repo-is-throwaway")) {
  console.error(
    "github-live.ts pushes, opens PRs and comments on a real GitHub repo.\n" +
      "Run it only against a throwaway repo you own:\n" +
      "  KITCHEN_GH_TEST_REPO=<owner>/<name> node spikes/w3b/github-live.ts --yes-this-repo-is-throwaway <scratch>",
  );
  process.exit(2);
}
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(import.meta.dirname, ".work"), "github-live");
fs.mkdirSync(root, { recursive: true });
const r = makeFixtureRepo(root, "repo", { yaml: "" });
process.env.KITCHEN_HOME = r.home;
const url = `https://github.com/${slug}.git`;
const cfg = parseConfig(`forge: { kind: github, repo: ${slug}, base: main }\nsource: { kind: github, label: kitchen }\n`);
const forge = new GithubForge(r.dir, cfg);
const stamp = Date.now().toString(36);

// main must exist on the remote: push the fixture as main only if the repo is empty.
const remoteMain = await gh(["api", `repos/${slug}/branches/main`], { okExit: [1] });
if (remoteMain.exit !== 0) git(r.dir, "push", "-q", url, "main:main");
const tip = await baseTip(r.dir, cfg);
check("base: fetched main from the real remote into refs/kitchen/base", /^[0-9a-f]{40}$/.test(tip));

git(r.dir, "checkout", "-q", "-b", `kitchen/live-${stamp}`, tip);
fs.writeFileSync(path.join(r.dir, `live-${stamp}.txt`), "kitchen live spike\n");
git(r.dir, "add", "-A");
git(r.dir, "commit", "-qm", "live spike");
const head = git(r.dir, "rev-parse", "HEAD").trim();
const pub = await forge.publish({ branch: `kitchen/live-${stamp}`, title: `Kitchen live spike ${stamp}`, head, labels: [REVIEW_REQUIRED] });
check("publish: draft PR opened with the label", pub.pr !== null, `#${pub.pr}`);
check("publish again: the same PR", (await forge.publish({ branch: `kitchen/live-${stamp}`, title: "x", head })).pr === pub.pr);
check("checks: a state (none on a repo without CI)", ["none", "pending", "pass", "fail"].includes(await forge.checks(pub.pr)));
await forge.comment({ key: `live-${stamp}/c`, pr: pub.pr, body: "Kitchen live spike comment" });
await forge.comment({ key: `live-${stamp}/c`, pr: pub.pr, body: "Kitchen live spike comment" });
check("comment: once per key", (await forge.comments(pub.pr as number)).filter((c) => c.body.includes(`kitchen:live-${stamp}/c`)).length === 1);
await forge.markReady(pub.pr);
const v = (await gh(["pr", "view", String(pub.pr), "--repo", slug, "--json", "isDraft,labels"], { json: true })).data as {
  isDraft: boolean;
  labels: { name: string }[];
};
check("ready for review, labelled kitchen:review-required", !v.isDraft && v.labels.some((l) => l.name === REVIEW_REQUIRED));

git(r.dir, "checkout", "-q", "-b", `kitchen/toolkit/live-${stamp}-1`, tip);
fs.appendFileSync(path.join(r.dir, ".kitchen/toolkit/SKILL.md"), "\nlive spike\n");
git(r.dir, "commit", "-qam", "toolkit live spike");
const th = git(r.dir, "rev-parse", "HEAD").trim();
const tpr = await forge.openToolkitPr({
  key: `live-${stamp}/tk`,
  title: `Toolkit live spike ${stamp}`,
  body: "spike",
  branch: `kitchen/toolkit/live-${stamp}-1`,
  head: th,
});
check("Toolkit PR opened", tpr > 0, `#${tpr}`);
check("not merged", (await forge.prMerged(tpr)) === false);

const jobDir = path.join(r.dir, ".kitchen", "jobs", `live-${stamp}`);
fs.mkdirSync(path.join(jobDir, "evidence", "e1"), { recursive: true });
fs.writeFileSync(path.join(jobDir, "report.html"), "<h1>live</h1>");
fs.writeFileSync(path.join(jobDir, "evidence", "e1", "call.json"), '{"stdout":"token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"}');
const folder = await forge.pushEvidence({ key: `live-${stamp}/ev`, job: `live-${stamp}`, dir: jobDir });
const blob = await gh(["api", `repos/${slug}/contents/live-${stamp}/evidence/e1/call.json?ref=kitchen-evidence`, "--jq", ".content"]);
check("evidence branch: folder pushed, redacted", Buffer.from(blob.out.trim(), "base64").toString("utf8").includes("[redacted]"), folder);

const issue = await gh(["issue", "create", "--repo", slug, "--title", `Kitchen live spike ${stamp}`, "--body", "spike", "--label", "kitchen"], { okExit: [1] });
if (issue.exit !== 0) await gh(["label", "create", "kitchen", "--repo", slug, "--force"]);
const src = new GithubSource(cfg);
check(
  "source: the labelled issue is a ticket",
  (await src.poll()).some((t) => t.title.includes(stamp)),
);

// clean up what this run made (the evidence branch stays for you to inspect)
await gh(["pr", "close", String(pub.pr), "--repo", slug, "--delete-branch"]);
await gh(["pr", "close", String(tpr), "--repo", slug, "--delete-branch"]);
for (const t of await src.poll()) if (t.title.includes(stamp)) await gh(["issue", "close", t.ref.id, "--repo", slug]);
finish("w3b github-live");
