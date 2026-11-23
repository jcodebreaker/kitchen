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
import { trustHome } from "./trust.ts";

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
  const deny = p.split("\n").find((l) => l.startsWith("(deny file-write* (literal")) ?? "";
  for (const s of [
    '(literal "/r")', // the repo itself can't be renamed …
    '(literal "/r/.kitchen")', // … nor the folders holding what it may not write (review H1, round 2)
    '(literal "/r/.worktrees")',
    '(literal "/r/.kitchen/toolkit.approved")',
    '(subpath "/r/.git")',
    '(subpath "/r/.kitchen/toolkit-checkouts")',
    '(regex #"^/r/\\.worktrees/_toolkit@[^/]+(/|$)")',
  ])
    assert.ok(deny.includes(s), s);
  assert.ok(repoWrites("/r", null, "/k/home").literals.includes("/k"), "the folders above $KITCHEN_HOME can't be renamed either");
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
  // Review H1, round 2: rename a folder aside, write in it, rename it back. Every rename must fail (each is undone if it worked).
  const kh = process.env.KITCHEN_HOME as string;
  const th = trustHome(repo);
  const moves: [string, string][] = [
    ["mv-kitchen", `${repo}/.kitchen`],
    ["mv-worktrees", `${repo}/.worktrees`],
    ["mv-repo", repo],
    ["mv-parent", root],
    ["mv-kitchen-home", kh],
    ["mv-trust-home", th],
  ];
  for (const [k, d] of moves)
    lines.push(`if mv '${d}' '${d}.moved' 2>/dev/null; then R="$R\\"${k}\\":true,"; mv '${d}.moved' '${d}'; else R="$R\\"${k}\\":false,"; fi`);
  lines.push(`if ( : >> '${th}/toolkit.approved' ) 2>/dev/null; then R="$R\\"home-approved\\":true,"; else R="$R\\"home-approved\\":false,"; fi`);
  lines.push(
    `if ( mkdir -p '${th}/checkouts/_trusted@000000000000' && : >> '${th}/checkouts/_trusted@000000000000/x' ) 2>/dev/null; then R="$R\\"home-checkout\\":true,"; else R="$R\\"home-checkout\\":false,"; fi`,
  );
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
  for (const [k] of moves) assert.equal(out.wrote[k], false, `${k} must be refused (a folder renamed aside opens what is under it)`);
  assert.equal(out.wrote["home-approved"], false, "the approval in $KITCHEN_HOME must be refused");
  assert.equal(out.wrote["home-checkout"], false, "a trusted checkout in $KITCHEN_HOME must be refused");
  assert.equal(fs.existsSync(path.join(th, "toolkit.approved")), false);
  assert.equal(out.wrote["own-git"], false, "its own .git pointer must be refused");
  assert.equal(out.wrote["own-checkout"], true, "its own checkout stays writable (prepare installs there)");
  for (const f of ["toolkit.approved", "toolkit.passed", "toolkit.proven"]) assert.equal(fs.existsSync(path.join(repo, ".kitchen", f)), false, f);
  // The control: the same bin/dev unsandboxed can write (so the refusals are the sandbox's).
  const real = path.join(co.dir, ".kitchen", "toolkit", "bin", "dev");
  const free = JSON.parse(execFileSync(real, ["describe"], { encoding: "utf8" }).trim()) as { wrote: Record<string, boolean> };
  assert.equal(free.wrote.approved, true);
});
