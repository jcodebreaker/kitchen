import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseConfig } from "../config.ts";
import { checksPrepareOf, installSteps, isDependencyFile, prepareKey, sameDepsAsBase } from "./run-checks.ts";

test("checks_prepare: off by default; the person's own command has the network only with checks_network, as always (review R2)", () => {
  assert.equal(checksPrepareOf(parseConfig("")), undefined);
  assert.deepEqual(checksPrepareOf(parseConfig("checks_prepare: make deps\nchecks_network: true\n"))?.steps, [
    { name: "checks_prepare", cmd: "make deps", network: true },
  ]);
  assert.deepEqual(checksPrepareOf(parseConfig("checks_prepare: npm ci\n"))?.steps, [{ name: "checks_prepare", cmd: "npm ci", network: false }]);
});

test("checks_install: the download is the only networked step and runs no scripts; the scripts run after, offline by default (review R2)", () => {
  const cfg = parseConfig("checks_install: npm\n");
  assert.equal(cfg.checks_network, false);
  const p = checksPrepareOf(cfg);
  assert.deepEqual(p?.steps, [
    { name: "install", cmd: "npm ci --ignore-scripts", network: true },
    { name: "install-scripts", cmd: "npm rebuild", network: "base-deps" },
  ]);
  assert.equal(p?.cmd, "npm ci --ignore-scripts && npm rebuild");
  assert.equal(installSteps("pnpm", true)[1].network, true, "checks_network: true lets the scripts online too");
  assert.match(installSteps("pnpm", false)[0].cmd, /--frozen-lockfile --ignore-scripts$/);
  assert.match(installSteps("yarn", false)[0].cmd, /--immutable --mode=skip-build$/);
  // Yarn 1 ignores Berry's flags and has no rebuild (review Y1).
  assert.deepEqual(installSteps("yarn-classic", false), [
    { name: "install", cmd: 'test -z "$TMPDIR" || export HOME="$TMPDIR"; yarn install --frozen-lockfile --ignore-scripts', network: true },
    { name: "install-scripts", cmd: "npm rebuild", network: "base-deps" },
  ]);
  assert.deepEqual(installSteps("bun", false), [{ name: "install", cmd: "bun install --frozen-lockfile --ignore-scripts", network: true }]);
  for (const pm of ["npm", "pnpm", "yarn", "bun"] as const)
    for (const s of installSteps(pm, false)) if (s.network === true) assert.match(s.cmd, /--ignore-scripts|--mode=skip-build/);
  // The install, then the person's own step.
  assert.deepEqual(
    checksPrepareOf(parseConfig("checks_install: pnpm\nchecks_prepare: make gen\n"))?.steps.map((s) => s.name),
    ["install", "install-scripts", "checks_prepare"],
  );
});

test("a prepared worktree is prepared again only when the command or a dependency file changes", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-prep-"));
  fs.writeFileSync(path.join(wt, "package.json"), '{"name":"x"}');
  fs.writeFileSync(path.join(wt, "package-lock.json"), '{"v":1}');
  const k = prepareKey("npm ci", wt);
  fs.writeFileSync(path.join(wt, "server.js"), "// app code");
  assert.equal(prepareKey("npm ci", wt), k, "app code doesn't count");
  assert.notEqual(prepareKey("npm install", wt), k, "another command");
  fs.writeFileSync(path.join(wt, "package-lock.json"), '{"v":2}');
  assert.notEqual(prepareKey("npm ci", wt), k, "a lockfile changed");
});

test("the install scripts get the network only while the dependency files are the base's (review N1)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-deps-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x","dependencies":{"bcrypt":"5"}}');
  fs.writeFileSync(path.join(dir, "package-lock.json"), '{"v":1}');
  fs.mkdirSync(path.join(dir, "packages", "a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages", "a", "package.json"), '{"name":"a"}');
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  const repo = { gitDir: path.join(dir, ".git"), workTree: dir };
  assert.equal(await sameDepsAsBase(repo, base), true);
  fs.writeFileSync(path.join(dir, "server.js"), "// app code");
  git("add", "-A");
  git("commit", "-q", "-m", "app");
  assert.equal(await sameDepsAsBase(repo, base), true, "app code doesn't count");
  fs.writeFileSync(path.join(dir, "packages", "a", "package.json"), '{"name":"a","scripts":{"postinstall":"curl x"}}');
  assert.equal(await sameDepsAsBase(repo, base), false, "a workspace manifest changed, uncommitted");
  git("checkout", "-q", "--", ".");
  fs.writeFileSync(path.join(dir, "packages", "b-package.json"), "{}");
  assert.equal(await sameDepsAsBase(repo, base), true, "not a manifest's name");
  fs.mkdirSync(path.join(dir, "packages", "b"));
  fs.writeFileSync(path.join(dir, "packages", "b", "package.json"), "{}");
  assert.equal(await sameDepsAsBase(repo, base), false, "a new, untracked manifest");
  assert.ok(isDependencyFile("a/b/yarn.lock") && !isDependencyFile("src/lock.ts"));
  // With checks_network the rebuild always has the network.
  assert.equal(installSteps("npm", true)[1].network, true);
});
