// ADR 0015, review H1: an untrusted bin/dev runs under sandbox-exec, and it may not write what makes a Toolkit
// trusted: the approval and proof records, git, or another Toolkit's checkout (where an approved sha runs
// unsandboxed). A real sandboxed bin/dev tries each write. macOS only: elsewhere there is no sandbox (ADR 0008).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { toolkitCheckout } from "./checkout.ts";
import { profileText, repoWrites, SANDBOX_EXEC } from "./sandbox.ts";

const HAS_SANDBOX = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
let root = "";
const saved = process.env.KITCHEN_HOME;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-sbtrust-")));
  process.env.KITCHEN_HOME = path.join(root, "home");
});
afterAll(() => {
  if (saved === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

test("the profile denies writes to the trust records, .git and other Toolkit checkouts; its own checkout stays writable", () => {
  const w = repoWrites("/r", "/r/.worktrees/_toolkit@abc");
  const p = profileText(["/h/.ssh"], [], [], w);
  assert.match(
    p,
    /\(deny file-write\* \(literal "\/r\/\.kitchen\/toolkit\.approved"\) \(literal "\/r\/\.kitchen\/toolkit\.passed"\) \(literal "\/r\/\.kitchen\/toolkit\.proven"\) \(subpath "\/r\/\.git"\) \(subpath "\/r\/\.kitchen\/toolkit-checkouts"\) \(regex #"\^\/r\/\\\.worktrees\/_toolkit@\[\^\/\]\+\(\/\|\$\)"\)\)/,
  );
  // Last match wins: own checkout allowed after the deny, its .git pointer denied after that.
  assert.ok(p.indexOf('(allow file-write* (subpath "/r/.worktrees/_toolkit@abc"))') > p.indexOf("(deny file-write* (literal"));
  assert.ok(p.indexOf('(deny file-write* (literal "/r/.worktrees/_toolkit@abc/.git"))') > p.indexOf("(allow file-write* (subpath"));
});

test.skipIf(!HAS_SANDBOX)("must refuse: a real sandboxed bin/dev can't approve itself, record a pass, touch git or another checkout", async () => {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(root, "init", "-q", "-b", "main", repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "kitchen/setup");
  // The planted Toolkit: every command tries each write and reports which worked.
  const targets: [string, string][] = [
    ["approved", `${repo}/.kitchen/toolkit.approved`],
    ["passed", `${repo}/.kitchen/toolkit.passed`],
    ["proven", `${repo}/.kitchen/toolkit.proven`],
    ["git-ref", `${repo}/.git/refs/heads/evil`],
    ["git-config", `${repo}/.git/config`],
    ["git-head", `${repo}/.git/HEAD`],
    ["checkout-notes", `${repo}/.kitchen/toolkit-checkouts/x.untrusted`],
    ["other-checkout", `${repo}/.worktrees/_toolkit@000000000000/.kitchen/toolkit/bin/dev`],
  ];
  const lines = targets.map(([k, f]) => `if ( : >> '${f}' ) 2>/dev/null; then R="$R\\"${k}\\":true,"; else R="$R\\"${k}\\":false,"; fi`);
  fs.mkdirSync(path.join(repo, ".kitchen", "toolkit", "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".kitchen", "toolkit", "bin", "dev"),
    [
      "#!/bin/bash",
      'own="$(cd "$(dirname "$0")/../../.." && pwd)"',
      'R=""',
      ...lines,
      'if ( : >> "$own/.kitchen/toolkit/scratch.txt" ) 2>/dev/null; then R="$R\\"own-checkout\\":true,"; else R="$R\\"own-checkout\\":false,"; fi',
      'if ( : >> "$own/.git" ) 2>/dev/null; then R="$R\\"own-git\\":true"; else R="$R\\"own-git\\":false"; fi',
      'echo "{\\"status\\":\\"ok\\",\\"wrote\\":{$R}}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  git(repo, "add", "-f", ".kitchen/toolkit/bin/dev");
  git(repo, "commit", "-q", "-m", "planted toolkit");
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  fs.mkdirSync(path.join(repo, ".kitchen"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".worktrees", "_toolkit@000000000000", ".kitchen", "toolkit", "bin"), { recursive: true });
  const co = await toolkitCheckout(repo, sha);
  co.release();
  assert.equal(co.trust, null);
  assert.equal(co.sandboxed, true);
  const out = JSON.parse(execFileSync(co.bin, ["describe"], { encoding: "utf8" }).trim().split("\n").at(-1) as string) as { wrote: Record<string, boolean> };
  for (const [k] of targets) assert.equal(out.wrote[k], false, `${k} must be refused`);
  assert.equal(out.wrote["own-git"], false, "its own .git pointer must be refused");
  assert.equal(out.wrote["own-checkout"], true, "its own checkout stays writable (prepare installs there)");
  for (const f of ["toolkit.approved", "toolkit.passed", "toolkit.proven"]) assert.equal(fs.existsSync(path.join(repo, ".kitchen", f)), false, f);
  // The control: the same bin/dev unsandboxed can write (so the refusals are the sandbox's).
  const real = path.join(co.dir, ".kitchen", "toolkit", "bin", "dev");
  const free = JSON.parse(execFileSync(real, ["describe"], { encoding: "utf8" }).trim()) as { wrote: Record<string, boolean> };
  assert.equal(free.wrote.approved, true);
});
