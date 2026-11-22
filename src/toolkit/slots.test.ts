import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireSlot, blockCount, partitionStale, pickBlock, portsOf, releaseSlot } from "./slots.ts";

test("blocks of 20 fit inside 31000–32767", () => {
  assert.equal(blockCount(), 88);
  const last = portsOf(blockCount() - 1);
  assert.equal(last[0], 32740);
  assert.equal(last.at(-1), 32759);
  assert.equal(portsOf(1)[0], 31020);
});

test("pickBlock skips taken blocks and blocks with any busy port", async () => {
  const busy = new Set([31005]); // block 0 has a busy port
  const n = await pickBlock(new Set([1]), async (p) => !busy.has(p));
  assert.equal(n, 2);
  assert.equal(await pickBlock(new Set(), async () => false), null);
});

test("partitionStale splits by owner pid", () => {
  const s = (pid: number) => ({ n: pid, id: `j${pid}`, ports: [], pid, at: "" });
  const { live, stale } = partitionStale([s(1), s(2), s(3)], (pid) => pid !== 2);
  assert.deepEqual(live.map((x) => x.pid), [1, 3]);
  assert.deepEqual(stale.map((x) => x.pid), [2]);
});

test("acquire gives distinct blocks, is idempotent per id, reclaims stale after down", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-slots-"));
  const free = async () => true;
  const dead = new Set<number>();
  const isAlive = (pid: number) => !dead.has(pid);
  const a = await acquireSlot({ id: "a", pid: 100, home, isFree: free, isAlive });
  const b = await acquireSlot({ id: "b", pid: 200, home, isFree: free, isAlive });
  assert.equal(a.slot.n, 0);
  assert.equal(b.slot.n, 1);
  assert.equal((await acquireSlot({ id: "a", pid: 100, home, isFree: free, isAlive })).slot.n, 0);

  dead.add(100);
  const downed: string[] = [];
  const c = await acquireSlot({ id: "c", pid: 300, home, isFree: free, isAlive, onStale: async (s) => void downed.push(s.id) });
  assert.deepEqual(downed, ["a"]);
  assert.equal(c.slot.n, 0); // a's block came back
  assert.equal((await releaseSlot("b", home))?.n, 1);
});
