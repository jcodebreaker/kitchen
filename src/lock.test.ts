import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { localStart, lockFs, lockOwner, ownerAlive, processStart, self, tryFileLock, withFileLock } from "./lock.ts";

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

test("ADR 0030: a process's start reads the same whatever the caller's locale and time zone", () => {
  const fr = processStart(process.pid, { ...process.env, LANG: "fr_FR.UTF-8", LC_ALL: "fr_FR.UTF-8", TZ: "Asia/Tokyo" });
  const us = processStart(process.pid, { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "", TZ: "America/New_York" });
  assert.ok(fr);
  assert.equal(fr, us);
  assert.match(String(fr), /^[A-Z][a-z]{2} [A-Z][a-z]{2} /, "the C locale's names");
});

test("ADR 0030: tryFileLock takes a free lock, refuses a live one, takes over a dead or garbled one", () => {
  const f = path.join(tmp(), "run.lock");
  const a = tryFileLock(f);
  assert.ok("release" in a);
  assert.deepEqual(lockOwner(f), self());
  const b = tryFileLock(f);
  assert.ok("heldBy" in b && b.heldBy.pid === process.pid, "held by this live process");
  a.release();
  assert.equal(lockOwner(f), null);
  // An empty lock this young may be another process's, mid-write: held. Older: garbage.
  fs.writeFileSync(f, "");
  assert.ok("heldBy" in tryFileLock(f));
  const old = new Date(Date.now() - 10_000);
  for (const junk of ["", "{not json", JSON.stringify({ pid: 999_999, start: "never" })]) {
    fs.writeFileSync(f, junk);
    fs.utimesSync(f, old, old);
    const c = tryFileLock(f);
    assert.ok("release" in c, `taken over from ${JSON.stringify(junk)}`);
    c.release();
  }
  assert.deepEqual(
    fs.readdirSync(path.dirname(f)).filter((x) => x !== "run.lock"),
    [],
    "no temp file left",
  );
});

test("ADR 0030: a start an earlier Kitchen stored in its own locale is still its live owner's: never taken over", async () => {
  const fr = { ...process.env, LANG: "fr_FR.UTF-8", LC_ALL: "fr_FR.UTF-8", TZ: "Asia/Tokyo" };
  const en = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "America/New_York" };
  const live = (args: string[]) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", ...args], { stdio: "ignore" });
  const run = live(["kitchen", "run"]); // a pre-upgrade `kitchen run`
  const other = live(["something-else"]);
  await new Promise((r) => setTimeout(r, 300));
  try {
    const pid = run.pid as number;
    const stored = localStart(pid, fr) as string;
    assert.notEqual(stored, processStart(pid), "the old format, not today's");
    assert.equal(ownerAlive({ pid, start: stored }, processStart, en), true, "French text, read from an English caller");
    assert.equal(ownerAlive({ pid, start: localStart(pid, en) }, processStart, en), true, "the caller's own locale");
    // A local-time C text from another time zone can't be judged either.
    assert.equal(ownerAlive({ pid, start: localStart(pid, { ...en, LC_ALL: "C", TZ: "Asia/Tokyo" }) }, processStart, en), true);
    // A start that is plainly another process's (C text, not whole quarter-hours off) is a reused pid.
    assert.equal(ownerAlive({ pid, start: "Mon Jan  1 00:00:07 2001" }, processStart, en), false);
    // A live process that isn't Kitchen's, with a start that can't be judged, is no owner: its lock is taken over.
    const o = other.pid as number;
    assert.equal(ownerAlive({ pid: o, start: localStart(o, fr) }, processStart, en), false);
  } finally {
    run.kill();
    other.kill();
  }
});

test("ADR 0030: tryFileLock on a file system without hard links: exclusive create and write instead", () => {
  const f = path.join(tmp(), "run.lock");
  const was = lockFs.link;
  lockFs.link = () => {
    throw Object.assign(new Error("no links here"), { code: "EPERM" });
  };
  try {
    const a = tryFileLock(f);
    assert.ok("release" in a);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), self());
    assert.ok("heldBy" in tryFileLock(f), "a second one is refused");
    a.release();
    assert.ok(!fs.existsSync(f));
  } finally {
    lockFs.link = was;
  }
});
