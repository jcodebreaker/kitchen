// W0 review round 3: a `git` planted in the worktree must never run, even when
// PATH has an empty entry (which means "the current directory").
// Usage: node spikes/w0/planted-git.ts   (free, asserts, exit 1 on a miss)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkedWorktree } from "../../src/engine/git.ts";
import { sourceStamp } from "../../src/proof/source-stamp.ts";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-planted-"));
const repo = path.join(T, "repo");
const wt = path.join(T, "wt");
const marker = path.join(T, "pwned");
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
fs.mkdirSync(repo);
git("init", "-q", "-b", "main");
git("-c", "user.email=k@k", "-c", "user.name=k", "commit", "-q", "--allow-empty", "-m", "x");
git("worktree", "add", "-q", wt, "-b", "job");
fs.writeFileSync(path.join(wt, "git"), `#!/bin/sh\necho PLANTED > ${marker}\n`, { mode: 0o755 });

process.env.PATH = `:${process.env.PATH}`; // empty entry first: the risky shape
let ok = true;
try {
  const stamp = await sourceStamp(linkedWorktree(repo, "wt", wt));
  if (!/^[0-9a-f]{40}$/.test(stamp.sha)) {
    console.log("FAIL stamp has no real sha", stamp);
    ok = false;
  }
} catch (e) {
  console.log("FAIL sourceStamp threw", e);
  ok = false;
}
if (fs.existsSync(marker)) {
  console.log("FAIL planted git ran");
  ok = false;
} else console.log("PASS planted git did not run with PATH=':$PATH'");
fs.rmSync(T, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
