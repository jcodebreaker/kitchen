// W2 review blocker: a bin/dev timeout fires even when a child holds stdout
// (free: no model, no Docker). Before the fix, execa's timeout killed only the
// shell and then waited for stdout to close: a 2 s timeout returned after 146 s.
//   - bin/dev backgrounds `sleep` holding stdout and hangs: the 2 s timeout
//     returns in ~2 s with a clear timeout result, and the whole group is dead;
//   - bin/dev prints its line, backgrounds a child holding stdout and exits: the
//     call returns at once with its JSON (the child is left, as `up` leaves the app);
//   - stall: bin/dev prints once and then nothing: killed after `stallMs`.
//   node spikes/w2/timeout.ts [scratch dir]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, finish, HERE } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work", "timeout"));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.KITCHEN_HOME = path.join(root, "kitchen-home");
const { runToolkit, TIMEOUT_EXIT } = await import("../../src/toolkit/run.ts");

const tag = `kitchen-timeout-spike-${process.pid}`;
const script = (name: string, body: string) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return f;
};
// `exec -a` names the sleeper so we can find it; it inherits stdout.
const hold = script("hold.sh", `(exec -a ${tag}-hold sleep 300) &\necho '{"status":"ok","secs":0}'\nsleep 300`);
const bgExit = script("bg-exit.sh", `(exec -a ${tag}-left sleep 300) &\necho '{"status":"ok","secs":0}'`);
const stall = script("stall.sh", `echo 'downloading…' >&2\nsleep 300`);
const alive = (name: string) => spawnSync("pgrep", ["-f", name]).stdout.toString().trim().split("\n").filter(Boolean).length;

let t = Date.now();
let r = await runToolkit(hold, ["prepare"], { src: root, timeoutMs: 2000 });
let secs = (Date.now() - t) / 1000;
check("timeout fires although a child holds stdout", secs < 5 && r.exit === TIMEOUT_EXIT && r.timedOut === "timeout", `${secs.toFixed(1)}s, exit ${r.exit}`);
check("a clear timeout result", /timed out after 2s: its process group was killed/.test(r.stderr), r.stderr.trim().split("\n").pop());
await new Promise((res) => setTimeout(res, 2500));
check("the whole process group is gone (the shell and the backgrounded child)", alive(`${tag}-hold`) === 0, `${alive(`${tag}-hold`)} left`);

t = Date.now();
r = await runToolkit(bgExit, ["up"], { src: root, timeoutMs: 60_000 });
secs = (Date.now() - t) / 1000;
check("bin/dev exits but leaves a child on stdout: returns at once with its JSON", secs < 3 && r.exit === 0 && r.json?.status === "ok", `${secs.toFixed(1)}s`);
check("that child is left running (up's app; the slot's down owns it)", alive(`${tag}-left`) === 1);
spawnSync("pkill", ["-f", `${tag}-left`]);

t = Date.now();
r = await runToolkit(stall, ["prepare"], { src: root, timeoutMs: 60_000, stallMs: 1500 });
secs = (Date.now() - t) / 1000;
check(
  "stall: no output for stallMs fails fast, named",
  secs < 5 && r.timedOut === "stall" && /printed nothing for 2s \(stalled\)/.test(r.stderr),
  `${secs.toFixed(1)}s: ${r.stderr.trim().split("\n").pop()}`,
);
finish("w2 timeout");
