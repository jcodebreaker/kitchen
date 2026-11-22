import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { appendEntry, emptyHead, MANIFEST, type ManifestHead, ManifestTampered, verifyManifest } from "./manifest.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-manifest-"));
const seal = { scope: "job-uid-1", key: Buffer.alloc(32, 7), floor: 0 };
const stamp = { sha: "abc123", round: 1, criterion: "C1", cmd: "bin/dev read --id=a", exit: 0 };

/** Two entries, the first citing a file. */
function twoEntries(sha = "abc123") {
  const dir = tmp();
  let head = emptyHead(seal);
  fs.mkdirSync(path.join(dir, "e1"));
  fs.writeFileSync(path.join(dir, "e1/shot.png"), "png-bytes");
  const a = appendEntry(dir, head, { ...stamp, sha, files: ["e1/shot.png"] }, seal, new Date("2026-01-01T00:00:00Z"));
  head = a.head;
  const b = appendEntry(dir, head, { ...stamp, exit: 1 }, seal);
  return { dir, head: b.head, e1: a.entry, e2: b.entry };
}

test("entries are sequential, chained, and cite file hashes", () => {
  const { dir, head, e1, e2 } = twoEntries();
  assert.equal(e1.id, "e1");
  assert.equal(e2.id, "e2");
  assert.equal(e1.prev, "0".repeat(64));
  assert.notEqual(e2.prev, e1.prev);
  assert.equal(e1.files[0].path, "e1/shot.png");
  assert.match(e1.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(head.n, 2);
  assert.equal(verifyManifest(dir, head, seal).length, 2);
});

test("the expected head is required, and must be signed with the engine key", () => {
  const { dir, head } = twoEntries();
  assert.throws(() => verifyManifest(dir, undefined as unknown as ManifestHead, seal), /no expected manifest head/);
  assert.throws(() => verifyManifest(dir, head, { ...seal, key: Buffer.alloc(32, 8) }), /signature/);
  assert.throws(() => verifyManifest(dir, head, { ...seal, scope: "another-job" }), /signature/);
  assert.throws(() => verifyManifest(dir, { ...head, n: 1 }, seal), /signature/);
});

test("a hand-edited line is refused, and the engine will not extend it", () => {
  const { dir, head } = twoEntries();
  const f = path.join(dir, MANIFEST);
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"exit":1', '"exit":0'));
  assert.throws(() => verifyManifest(dir, head, seal), ManifestTampered);
  assert.throws(() => appendEntry(dir, head, stamp, seal), ManifestTampered);
});

test("dropped, appended and reordered lines are refused", () => {
  const { dir, head } = twoEntries();
  const f = path.join(dir, MANIFEST);
  const text = fs.readFileSync(f, "utf8");
  const [l1, l2] = text.trim().split("\n");
  fs.writeFileSync(f, `${l1}\n`);
  assert.throws(() => verifyManifest(dir, head, seal), /has 1 entries/);
  fs.writeFileSync(f, `${text}${JSON.stringify({ ...stamp, id: "e3", prev: "x", files: [], at: "x" })}\n`);
  assert.throws(() => verifyManifest(dir, head, seal), /has 3 entries/);
  fs.writeFileSync(f, `${l2}\n${l1}\n`);
  assert.throws(() => verifyManifest(dir, head, seal), ManifestTampered);
});

test("a changed or missing evidence file is refused", () => {
  const { dir, head } = twoEntries();
  fs.writeFileSync(path.join(dir, "e1/shot.png"), "other-bytes");
  assert.throws(() => verifyManifest(dir, head, seal), /content changed/);
  fs.rmSync(path.join(dir, "e1/shot.png"));
  assert.throws(() => verifyManifest(dir, head, seal), /missing/);
});

test("a deleted manifest is refused when the engine expects entries; ids never restart", () => {
  const { dir, head } = twoEntries();
  fs.rmSync(path.join(dir, MANIFEST));
  assert.throws(() => verifyManifest(dir, head, seal), /missing or empty/);
  assert.throws(() => appendEntry(dir, head, stamp, seal), ManifestTampered);
  // a fresh manifest started from the empty head does not verify against the job's head
  const restarted = appendEntry(dir, emptyHead(seal), stamp, seal);
  assert.equal(restarted.entry.id, "e1");
  assert.throws(() => verifyManifest(dir, head, seal), ManifestTampered);
});

test("a manifest swapped for another consistent chain is refused by the head hash", () => {
  const a = twoEntries();
  const b = twoEntries("def456");
  fs.copyFileSync(path.join(b.dir, MANIFEST), path.join(a.dir, MANIFEST));
  fs.rmSync(path.join(a.dir, "e1"), { recursive: true });
  fs.cpSync(path.join(b.dir, "e1"), path.join(a.dir, "e1"), { recursive: true });
  // b is a valid chain of its own (another sha), just not the one the engine recorded
  assert.throws(() => verifyManifest(a.dir, a.head, seal), /head/);
});

test("an evidence path outside the evidence dir is refused", () => {
  const dir = tmp();
  assert.throws(() => appendEntry(dir, emptyHead(seal), { ...stamp, files: ["../escape.png"] }, seal), /outside/);
});

test("a head older than the engine's counter is a rollback, refused even with its own manifest", () => {
  const dir = tmp();
  const one = appendEntry(dir, emptyHead(seal), stamp, seal);
  const old = fs.readFileSync(path.join(dir, MANIFEST));
  const two = appendEntry(dir, one.head, stamp, seal);
  assert.equal(verifyManifest(dir, two.head, { ...seal, floor: 2 }).length, 2);
  fs.writeFileSync(path.join(dir, MANIFEST), old); // the older pair: validly signed and consistent
  assert.equal(verifyManifest(dir, one.head, seal).length, 1);
  assert.throws(() => verifyManifest(dir, one.head, { ...seal, floor: 2 }), /rolled back/);
});
