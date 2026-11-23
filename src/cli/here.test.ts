// Bare `kitchen` starts with one line about the folder (ADR 0011): not a repo, not set up, or set up
// with its jobs, Toolkit and runner. Files only, so it is instant.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { acquireRunLock } from "../engine/lock.ts";
import { createJob } from "../engine/store.ts";
import { trustFile } from "../toolkit/trust.ts";
import { hereLine } from "./here.ts";

let root: string;
const savedHome = process.env.KITCHEN_HOME;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-here-"));
  process.env.KITCHEN_HOME = path.join(root, "home"); // the trust records live there (ADR 0015)
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const repo = (name: string) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  return dir;
};

test("not a git repository", () => {
  const dir = path.join(root, "plain");
  fs.mkdirSync(dir);
  assert.equal(hereLine(dir), "Not a git repository; Kitchen works inside one.");
});

test("a repo without kitchen.yaml: not set up, and how to start (from a subfolder too)", () => {
  const dir = repo("bare");
  fs.mkdirSync(path.join(dir, "src"));
  const want = "Kitchen isn't set up here. Start with: kitchen init (or kitchen init --skill, then /kitchen set up Kitchen in Claude Code)";
  assert.equal(hereLine(dir), want);
  assert.equal(hereLine(path.join(dir, "src")), want);
});

test("set up: jobs, the Toolkit and the runner", async () => {
  const dir = repo("setup");
  fs.writeFileSync(path.join(dir, "kitchen.yaml"), "version: 1\n");
  assert.equal(hereLine(dir), "Kitchen is set up here · 0 jobs · Toolkit: not built · runner: stopped");
  await createJob(dir, { title: "one", ticket: { source: "prompt", id: "p" }, body: "one", roundLimit: 3, base: "HEAD" });
  fs.mkdirSync(path.join(dir, ".kitchen", "toolkit", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".kitchen", "toolkit", "bin", "dev"), "");
  assert.equal(hereLine(dir), "Kitchen is set up here · 1 job · Toolkit: built, not proven · runner: stopped");
  fs.mkdirSync(path.dirname(trustFile(dir, "toolkit.proven")), { recursive: true });
  fs.writeFileSync(trustFile(dir, "toolkit.proven"), "{}");
  const lock = acquireRunLock(dir);
  try {
    assert.equal(hereLine(dir), "Kitchen is set up here · 1 job · Toolkit: proven · runner: running");
  } finally {
    lock.release();
  }
  assert.match(hereLine(dir), /runner: stopped$/);
});

test("bare `kitchen` prints the line first, then the command list", () => {
  const dir = path.join(root, "plain2");
  fs.mkdirSync(dir);
  let out = "";
  try {
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, "..", "cli.ts")], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  assert.match(out, /^Not a git repository; Kitchen works inside one\.\n\nkitchen: turns tickets/);
});
