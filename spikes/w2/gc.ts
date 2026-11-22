// W2 review fix: Toolkit-checkout GC never removes a checkout in use (free: no
// model, no Docker). A checkout is in use while a live process holds its lease
// (toolkitCheckout → release), or while a live slot runs its bin/dev.
//   node spikes/w2/gc.ts [scratch dir]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, finish, git, HERE, ROOT } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work", "gc"));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.KITCHEN_HOME = path.join(root, "kitchen-home");
fs.mkdirSync(process.env.KITCHEN_HOME, { recursive: true, mode: 0o700 });
const { gcCheckouts, toolkitCheckout } = await import("../../src/toolkit/checkout.ts");
const { acquireSlot, releaseSlot } = await import("../../src/toolkit/slots.ts");

const dir = path.join(root, "repo");
fs.mkdirSync(path.join(dir, ".kitchen", "toolkit", "bin"), { recursive: true });
fs.copyFileSync(path.join(HERE, "fake-toolkit.mjs"), path.join(dir, ".kitchen", "toolkit", "bin", "dev"));
fs.writeFileSync(path.join(dir, ".gitignore"), ".worktrees/\n.kitchen/toolkit-checkouts/\n");
git(root, "init", "-q", "-b", "main", dir);
git(dir, "add", "-A");
git(dir, "commit", "-q", "-m", "one");
const sha1 = git(dir, "rev-parse", "HEAD");
fs.writeFileSync(path.join(dir, "x.txt"), "two\n");
git(dir, "add", "-A");
git(dir, "commit", "-q", "-m", "two");
const sha2 = git(dir, "rev-parse", "HEAD");
const s1 = sha1.slice(0, 12);
const s2 = sha2.slice(0, 12);
const there = (s: string) => fs.existsSync(path.join(dir, ".worktrees", `_toolkit@${s}`));
const none = new Set<string>();

const co1 = await toolkitCheckout(dir, sha1);
const co2 = await toolkitCheckout(dir, sha2);
co2.release();
let gone = await gcCheckouts(dir, none);
check("a leased checkout survives GC; a released one is removed", there(s1) && !there(s2) && gone.join() === s2, `removed ${gone.join(", ")}`);

// Another process holds a lease on sha2 (a concurrent check); then dies.
const holder = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `const { toolkitCheckout } = await import(${JSON.stringify(path.join(ROOT, "src/toolkit/checkout.ts"))}); await toolkitCheckout(${JSON.stringify(dir)}, ${JSON.stringify(sha2)}); console.log("leased"); setInterval(() => {}, 1000);`,
  ],
  { stdio: ["ignore", "pipe", "inherit"], env: process.env },
);
await new Promise<void>((r) => holder.stdout?.once("data", () => r()));
gone = await gcCheckouts(dir, none);
check("a checkout leased by another live process survives GC", there(s2) && !gone.includes(s2), `removed ${gone.join(", ") || "none"}`);
holder.kill("SIGKILL");
await new Promise((r) => holder.once("exit", r));
gone = await gcCheckouts(dir, none);
check("its owner killed (-9): the lease is void, the checkout is removed", !there(s2) && gone.includes(s2), `removed ${gone.join(", ")}`);

// A live slot runs the checkout's bin/dev (an `up` app still running from it).
const co3 = await toolkitCheckout(dir, sha2);
co3.release();
const { slot } = await acquireSlot({ id: "gc-spike-slot", toolkitBin: co3.bin, src: co3.dir });
gone = await gcCheckouts(dir, none);
check("a checkout a live slot runs survives GC (no lease)", there(s2) && !gone.includes(s2), `slot ${slot.id}; removed ${gone.join(", ") || "none"}`);
await releaseSlot(slot.id);
co1.release();
gone = await gcCheckouts(dir, none);
check("slot released and lease dropped: both removed", !there(s1) && !there(s2) && gone.length === 2, `removed ${gone.join(", ")}`);
const keep = await toolkitCheckout(dir, sha1);
keep.release();
gone = await gcCheckouts(dir, new Set([s1]));
check("`keep` (the proven sha, a live job's toolkitRef) still wins", there(s1) && !gone.length);
finish("w2 gc");
