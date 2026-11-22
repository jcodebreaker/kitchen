// W1 exit, part 3: `kitchen run --detach` survives the shell that started it,
// and `kitchen status` shows it. The runner drains the queue and exits by itself.
//   node spikes/w1/detach.ts <scratch dir>
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLI, check, finish, jobOf, kitchen, makeRepo, sleep, ticket } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"));
fs.mkdirSync(root, { recursive: true });
const r = makeRepo(root, "detach");
const id = ticket(r, "A slow build\nscenario: slow");

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const sh = spawnSync("sh", ["-c", `${quote(process.execPath)} ${quote(CLI)} run --detach --repo ${quote(r.dir)}; echo "shell $$ exits"`], {
  env: r.env,
  encoding: "utf8",
  timeout: 20_000,
});
const pid = Number(/run detached: pid (\d+)/.exec(sh.stdout)?.[1]);
check("the starting shell exits at once", sh.status === 0 && /shell \d+ exits/.test(sh.stdout), sh.stdout.trim().replace(/\n/g, " | "));
check("one line: pid + log path", /run detached: pid \d+, log .*run\.log/.test(sh.stdout));
await sleep(1500);
const alive = (p: number) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
check("the detached runner outlives its shell", alive(pid), `pid ${pid}`);
const ppid = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
check("it was re-parented (its shell is gone)", ppid === "1", `ppid ${ppid}`);
const st = kitchen(r, "status").out;
check("`kitchen status` shows the runner and the job", st.includes(`runner: pid ${pid}`) && st.includes(id), st.trim().split("\n").slice(0, 2).join(" | "));

for (let i = 0; i < 300 && (jobOf(r, id).stage !== "done" || alive(pid)); i++) await sleep(200);
check("the detached runner finished the job and exited", jobOf(r, id).stage === "done" && !alive(pid), jobOf(r, id).stage);
const log = fs.readFileSync(path.join(r.dir, ".kitchen", "run.log"), "utf8");
check("its log has every move", /report → done/.test(log) && /run: done/.test(log), `${log.trim().split("\n").length} lines`);
check("`kitchen status` after: not running", /runner: not running/.test(kitchen(r, "status").out));
finish("w1 detach");
