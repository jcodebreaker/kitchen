import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseConfig } from "../config.ts";
import { checksPrepareOf, prepareKey } from "./run-checks.ts";

test("checks_prepare: off by default; when set it runs with checks_network", () => {
  assert.equal(checksPrepareOf(parseConfig("")), undefined);
  assert.deepEqual(checksPrepareOf(parseConfig("checks_prepare: npm ci\nchecks_network: true\n")), { cmd: "npm ci", network: true });
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
