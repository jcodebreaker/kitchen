// W0 review finding: engine git trusted the worktree. No agent call, no Docker.
//   node spikes/w0/git-redirect.ts
// Plants a linked worktree whose `.git` file points at an attacker gitdir with
// `core.fsmonitor` (and a hook) that write $GH_TOKEN to a file, plus a nested
// repo redirected the same way, a filter driver and a hook in the main repo.
// Control: the old `git -C <worktree>` stamp runs the planted command and leaks
// the token. Fixed: `sourceStamp` through src/engine/git.ts runs nothing,
// stamps the real worktree HEAD, and the engine refuses `.git` files and
// symlinks it can't trust. Exits 1 on any miss.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkedWorktree, plainCheckout } from "../../src/engine/git.ts";
import { sourceStamp } from "../../src/proof/source-stamp.ts";

const work = path.join(import.meta.dirname, ".work/git-redirect");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const FAKE = "ghp_kitchenGitRedirectFake000000000000000";
process.env.KITCHEN_HOME = path.join(work, "kitchen-home");
process.env.GH_TOKEN = FAKE; // in the engine's own env: must never reach a planted command

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=kitchen", "-c", "user.email=k@example.invalid", ...a], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const misses: string[] = [];
function expect(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "PASS" : "MISS"} ${label}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  if (!pass) misses.push(label);
}
const pwn = (name: string) => path.join(work, `pwned-${name}`);
const pwned = () =>
  fs
    .readdirSync(work)
    .filter((f) => f.startsWith("pwned-"))
    .map((f) => `${f}: ${fs.readFileSync(path.join(work, f), "utf8").trim().slice(0, 80)}`);
const clearPwned = () => {
  for (const f of fs.readdirSync(work)) if (f.startsWith("pwned-")) fs.rmSync(path.join(work, f));
};
/** A shell command that writes the token it sees to pwned-<name>. */
const leak = (name: string) => `echo PWNED-$GH_TOKEN > ${pwn(name)}; :`;
const hook = (dir: string, name: string, tag: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${leak(tag)}\n`, { mode: 0o755 });
};

// ---------- layout ----------
const repo = path.join(work, "repo");
fs.mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "app.txt"), "the real app\n");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "real");
const wt = path.join(repo, ".worktrees/001");
git(repo, "worktree", "add", "-q", wt, "-b", "kitchen/001");
const realHead = git(wt, "rev-parse", "HEAD");

// The attacker's gitdir: its own history, and config that runs commands.
const evil = path.join(work, "evil");
fs.mkdirSync(evil);
git(evil, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(evil, "x.txt"), "evil\n");
git(evil, "add", "-A");
git(evil, "commit", "-q", "-m", "evil");
const evilHead = git(evil, "rev-parse", "HEAD");
const evilGit = path.join(evil, ".git");
hook(path.join(work, "evil-hooks"), "post-index-change", "evil-hook");
fs.appendFileSync(
  path.join(evilGit, "config"),
  `[core]\n\tfsmonitor = ${JSON.stringify(leak("evil-fsmonitor"))}\n\thooksPath = ${path.join(work, "evil-hooks")}\n`,
);

// What the agent (or app code) writes inside the worktree:
fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${evilGit}\n`); // redirect the worktree
fs.mkdirSync(path.join(wt, "sub"));
fs.writeFileSync(path.join(wt, "sub/.git"), `gitdir: ${evilGit}\n`); // a nested repo, redirected too
fs.writeFileSync(path.join(wt, ".gitattributes"), "* filter=trusted\n"); // selects a driver from the main repo config
fs.writeFileSync(path.join(wt, "app.txt"), "the real app, edited\n");

// Programs defined in the main repo (outside the worktree): neutralized anyway.
fs.appendFileSync(path.join(repo, ".git/config"), `[filter "trusted"]\n\tclean = ${path.join(work, "clean.sh")}\n`);
fs.writeFileSync(path.join(work, "clean.sh"), `#!/bin/sh\n${leak("main-filter")}\ncat\n`, { mode: 0o755 });
hook(path.join(repo, ".git/hooks"), "post-index-change", "main-hook");

// ---------- control: the old stamp (git -C <worktree>, full engine env) ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-old-stamp-"));
const oldStamp = (prefix: string[]) => {
  const run = (...a: string[]) => {
    try {
      return execFileSync("git", [...prefix, ...a], {
        cwd: wt,
        env: { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") },
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    } catch (e) {
      return `error: ${(e as Error).message.split("\n")[0]}`;
    }
  };
  const sha = run("rev-parse", "--verify", "HEAD^{commit}");
  run("read-tree", "HEAD");
  run("add", "-A", ".");
  run("write-tree");
  fs.rmSync(path.join(tmp, "index"), { force: true });
  return sha;
};
const oldSha = oldStamp(["-C", wt]);
const control = pwned();
expect(
  "control: the old stamp follows the redirect and runs the planted fsmonitor, leaking GH_TOKEN",
  control.some((l) => l.startsWith("pwned-evil") && l.includes(FAKE)) && oldSha === evilHead,
  { stampedSha: oldSha === evilHead ? "the attacker's HEAD" : oldSha, ran: control },
);
clearPwned();
// Second control: the explicit gitdir alone (no neutral config) still runs what the main repo defines.
oldStamp([`--git-dir=${path.join(repo, ".git/worktrees/001")}`, `--work-tree=${wt}`]);
fs.rmSync(tmp, { recursive: true, force: true });
const control2 = pwned();
expect(
  "control: an explicit gitdir without the neutral config still runs the main repo's filter driver and hook",
  control2.some((l) => l.startsWith("pwned-main-filter")) && control2.some((l) => l.startsWith("pwned-main-hook")),
  control2,
);
clearPwned();

// ---------- fixed: sourceStamp through the engine git helper ----------
const repoRef = linkedWorktree(repo, "001", wt);
expect("gitdir resolved from the main repo, not the worktree's .git", repoRef.gitDir === fs.realpathSync(path.join(repo, ".git/worktrees/001")), repoRef);
const stamp = await sourceStamp(repoRef);
const ran = pwned();
expect("fixed: nothing planted ran (evil fsmonitor, evil hook, nested repo, main filter, main hook)", ran.length === 0, ran.length ? ran : "no pwned-* files");
expect("fixed: stamps the real worktree HEAD, dirty (app.txt edited)", stamp.sha === realHead && stamp.dirty === true, { stamp, realHead, evilHead });
const treeFiles = git(repo, "ls-tree", "--name-only", stamp.tree).split("\n");
expect("fixed: the tree hash is of the worktree on disk", treeFiles.includes("app.txt") && treeFiles.includes("sub"), treeFiles);

// ---------- the engine refuses what it can't trust ----------
const refused = (label: string, fn: () => unknown, re: RegExp) => {
  try {
    fn();
    expect(label, false, "accepted");
  } catch (e) {
    expect(label, re.test((e as Error).message), (e as Error).message);
  }
};
refused("a worktree id whose back-pointer names another directory", () => linkedWorktree(repo, "001", evil), /belongs to/);
refused("a worktree id that escapes .git/worktrees", () => linkedWorktree(repo, "..", wt), /bad worktree id/);
refused("a plain checkout whose .git is a file", () => plainCheckout(wt), /is a file/);
const linkSrc = path.join(work, "symlinked");
fs.mkdirSync(linkSrc);
fs.symlinkSync(evilGit, path.join(linkSrc, ".git"));
refused("a plain checkout whose .git is a symlink", () => plainCheckout(linkSrc), /symlink/);
refused("no git at all", () => plainCheckout(path.join(work, "evil-hooks")), /not a git checkout/);

console.log(misses.length ? `\n${misses.length} expectation(s) MISSED` : "\nall expectations met");
process.exitCode = misses.length ? 1 : 0;
