// W5 newcomer test, the setup half: what a newcomer is handed, and nothing else.
//   node spikes/w5/newcomer-setup.ts <dir>
// <dir>/README.md        this repo's README, alone
// <dir>/devkitchen-0.1.0.tgz   the packed package (npm pack)
// <dir>/tasks/           a fresh clone of fixture B (Python CLI + SQLite), one commit, no Kitchen files
// The person (an agent with no knowledge of this repo) then follows README.md only; what they
// ran, what it cost and every unclear place go into <dir>/NOTES.md (spikes/w5/results.md has the outcome).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work", "newcomer"));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
execFileSync("npm", ["pack", "--pack-destination", dir], { cwd: ROOT, stdio: "ignore" });
fs.copyFileSync(path.join(ROOT, "README.md"), path.join(dir, "README.md"));
const repo = path.join(dir, "tasks");
fs.cpSync(path.join(ROOT, "fixtures", "b-cli"), repo, {
  recursive: true,
  filter: (s) => !/(^|\/)(\.kitchen|__pycache__|\.venv)(\/|$)/.test(path.relative(ROOT, s)),
});
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=dev", "-c", "user.email=dev@example.invalid", ...a], { cwd: repo, stdio: "pipe" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "tasks: a terminal task tracker");
console.log(`newcomer kit in ${dir}: ${fs.readdirSync(dir).join(", ")}; tasks/ at ${String(git("rev-parse", "--short", "HEAD")).trim()}`);
