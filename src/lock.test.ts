import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ownerAlive, withFileLock } from "./lock.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-lock-"));

test("ownerAlive tells a reused pid apart by start time", () => {
  const starts: Record<number, string> = { 10: "Mon" };
  const startOf = (pid: number) => starts[pid] ?? null;
  assert.equal(ownerAlive({ pid: 10, start: "Mon" }, startOf), true);
  assert.equal(ownerAlive({ pid: 10, start: "Sun" }, startOf), false);
  assert.equal(ownerAlive({ pid: 11, start: "Mon" }, startOf), false);
});

test("a lock held by a live owner is never stolen, however old", async () => {
  const f = path.join(tmp(), "x.lock");
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, start: null })); // the test runner's parent: alive
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(f, old, old);
  await assert.rejects(
    withFileLock(f, async () => "got it", { timeoutMs: 300 }),
    /held by/,
  );
});

test("a lock whose owner is gone is taken over; holders run one at a time", async () => {
  const f = path.join(tmp(), "x.lock");
  fs.writeFileSync(f, JSON.stringify({ pid: 2 ** 22 + 12345, start: "never" })); // no such process
  const order: string[] = [];
  const run = (name: string) =>
    withFileLock(f, async () => {
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}-`);
    });
  await Promise.all([run("a"), run("b")]);
  assert.deepEqual(
    order.slice(0, 2).map((s) => s.at(-1)),
    ["+", "-"],
  );
  assert.equal(fs.existsSync(f), false);
});
