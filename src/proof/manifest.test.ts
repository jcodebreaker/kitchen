import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { HASH_FILE, MANIFEST, ManifestTampered, appendEntry, verifyManifest } from "./manifest.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-manifest-"));
const stamp = { sha: "abc123", round: 1, criterion: "C1", cmd: "bin/dev read --id a", exit: 0 };

test("appends stamped entries with sequential ids and a matching hash", () => {
  const dir = tmp();
  const e1 = appendEntry(dir, stamp, new Date("2026-01-01T00:00:00Z"));
  const e2 = appendEntry(dir, { ...stamp, exit: 1 });
  assert.equal(e1.id, "e1");
  assert.equal(e2.id, "e2");
  assert.deepEqual(Object.keys(e1), ["id", "sha", "round", "criterion", "cmd", "exit", "at"]);
  assert.equal(verifyManifest(dir).length, 2);
});

test("a hand-edited line is refused, and the engine will not extend it", () => {
  const dir = tmp();
  appendEntry(dir, { ...stamp, exit: 1 });
  const f = path.join(dir, MANIFEST);
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"exit":1', '"exit":0'));
  assert.throws(() => verifyManifest(dir), ManifestTampered);
  assert.throws(() => appendEntry(dir, stamp), ManifestTampered);
});

test("an appended forged line and a deleted line are refused", () => {
  const dir = tmp();
  appendEntry(dir, stamp);
  appendEntry(dir, stamp);
  const f = path.join(dir, MANIFEST);
  const text = fs.readFileSync(f, "utf8");
  fs.appendFileSync(f, `${JSON.stringify({ ...stamp, id: "e3", at: "x" })}\n`);
  assert.throws(() => verifyManifest(dir), ManifestTampered);
  fs.writeFileSync(f, text.split("\n")[0] + "\n");
  assert.throws(() => verifyManifest(dir), ManifestTampered);
});

test("a manifest with no recorded hash is refused; an empty one is fine", () => {
  const dir = tmp();
  assert.deepEqual(verifyManifest(dir), []);
  fs.writeFileSync(path.join(dir, MANIFEST), "{}\n");
  assert.throws(() => verifyManifest(dir), /no hash/);
});

test("an expected hash from job.json overrides the hash file", () => {
  const dir = tmp();
  appendEntry(dir, stamp);
  const good = fs.readFileSync(path.join(dir, HASH_FILE), "utf8");
  assert.equal(verifyManifest(dir, good).length, 1);
  assert.throws(() => verifyManifest(dir, "0".repeat(64)), ManifestTampered);
});
