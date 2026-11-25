// ADR 0032 §1: a dashboard is stale once the build on disk differs; a rebuild that writes the same files is no change.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { staleWatch } from "./version.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-version-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("mtime-only rewrites aren't stale; changed contents are, once settled; nothing latches", () => {
  fs.mkdirSync(path.join(root, "dist", "engine"), { recursive: true });
  fs.mkdirSync(path.join(root, "dashboard"));
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.0.0"}');
  fs.writeFileSync(path.join(root, "dashboard", "dashboard.html"), "<p>page</p>");
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "cli");
  const jobs = path.join(root, "dist", "engine", "jobs.js");
  fs.writeFileSync(jobs, "jobs");
  let t = 0;
  const stale = staleWatch({ root, code: "dist", ms: 1000, now: () => t });
  const look = () => {
    t += 1000;
    return stale();
  };
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(jobs, later, later);
  assert.equal(look(), false, "moved: judged at the next look");
  assert.equal(look(), false, "same contents, new mtime");
  fs.writeFileSync(jobs, "jobs, rebuilt");
  t += 500;
  assert.equal(stale(), false, "not looked at again within ms");
  assert.equal(look(), false, "it moved: maybe still being written");
  assert.equal(look(), true, "settled, and a module deep in dist/ changed");
  fs.writeFileSync(jobs, "jobs");
  fs.utimesSync(jobs, later, later);
  assert.equal(look(), true, "moved again: unjudged, the last answer stands");
  assert.equal(look(), false, "put back as it was: not stale");
});
