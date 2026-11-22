import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Owner } from "../lock.ts";
import { acquireSlot, blockCount, partitionStale, pickBlock, portsOf, releaseSlot, type Slot } from "./slots.ts";

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

test("partitionStale asks about the owner process, start time included", () => {
  const s = (pid: number, start: string): Slot => ({ n: pid, id: `j${pid}`, ports: [], pid, pidStart: start, toolkitBin: "/t/dev", src: "/s", at: "" });
  // pid 3 is alive but started at another time: the pid was reused, the slot is stale
  const starts: Record<number, string> = { 1: "Mon", 3: "Wed" };
  const alive = (o: Owner) => starts[o.pid] !== undefined && starts[o.pid] === o.start;
  const { live, stale } = partitionStale([s(1, "Mon"), s(2, "Tue"), s(3, "Tue")], alive);
  assert.deepEqual(
    live.map((x) => x.pid),
    [1],
  );
  assert.deepEqual(
    stale.map((x) => x.pid),
    [2, 3],
  );
});

test("acquire records the Toolkit and source, is idempotent per id, reclaims stale through that slot's own Toolkit", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-slots-"));
  const free = async () => true;
  const dead = new Set<number>();
  const isAlive = (o: Owner) => !dead.has(o.pid);
  const a = await acquireSlot({ id: "a", toolkitBin: "/repo-a/dev", src: "/wt-a", pid: 100, home, isFree: free, isAlive });
  const b = await acquireSlot({ id: "b", toolkitBin: "/repo-b/dev", src: "/wt-b", pid: 200, home, isFree: free, isAlive });
  assert.equal(a.slot.n, 0);
  assert.equal(b.slot.n, 1);
  assert.equal(a.slot.toolkitBin, "/repo-a/dev");
  assert.equal(a.slot.src, "/wt-a");
  assert.equal((await acquireSlot({ id: "a", toolkitBin: "/repo-a/dev", src: "/wt-a", pid: 100, home, isFree: free, isAlive })).slot.n, 0);

  dead.add(100);
  const downed: string[] = [];
  const c = await acquireSlot({
    id: "c",
    toolkitBin: "/repo-b/dev",
    src: "/wt-c",
    pid: 300,
    home,
    isFree: free,
    isAlive,
    onStale: async (s) => void downed.push(`${s.toolkitBin} down --id ${s.id}`),
  });
  assert.deepEqual(downed, ["/repo-a/dev down --id a"]); // a's own Toolkit, not the caller's
  assert.equal(c.slot.n, 0); // a's block came back
  assert.equal((await releaseSlot("b", home))?.n, 1);
});
