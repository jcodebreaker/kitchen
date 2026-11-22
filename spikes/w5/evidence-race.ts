// Found by dashboard.ts's first run: two jobs reaching `report` at once both moved the
// `kitchen-evidence` branch, and the second update-ref failed. Now one commit at a time.
//   node spikes/w5/evidence-race.ts [scratch]
// Six jobs' bundles committed at once in one process (as the runner does with concurrency):
// every call succeeds, and the branch ends with all six folders.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { commitEvidence, EVIDENCE_BRANCH } from "../../src/forge/evidence-branch.ts";
import { check, finish } from "../w1/lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"), "evidence-race");
fs.rmSync(root, { recursive: true, force: true });
const repo = path.join(root, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "x\n");
git("add", "-A");
git("commit", "-qm", "init");
const jobs = ["001-a", "002-b", "003-c", "004-d", "005-e", "006-f"];
const results = await Promise.allSettled(
  jobs.map((job) => {
    const bundle = path.join(root, "bundles", job);
    fs.mkdirSync(path.join(bundle, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "report.html"), `<html>${job}</html>\n`);
    return commitEvidence({ repo, job, bundle, keepDays: 30 });
  }),
);
const failed = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason).split("\n")[0]);
check("six evidence commits at once: none fails", failed.length === 0, failed.join("; "));
const tree = git("ls-tree", "--name-only", EVIDENCE_BRANCH).split("\n").filter(Boolean);
check(
  "the branch holds all six job folders",
  jobs.every((j) => tree.includes(j)),
  tree.join(" "),
);
finish("w5 evidence-race");
