// Heartbeat: one line to ./hb.log every 2s for 30s. First line also says whether this
// detached process inherited the agent's sandbox (can it write the jobs dir outside the root?).
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const jobs = process.argv[2];
let outside = "skipped";
if (jobs) {
  try {
    writeFileSync(join(jobs, "hb-outside.txt"), "x");
    outside = "WROTE";
  } catch (e) {
    outside = `denied (${e.code})`;
  }
}
appendFileSync("hb.log", `start pid=${process.pid} outside-write=${outside}\n`);
let n = 0;
const t = setInterval(() => {
  appendFileSync("hb.log", `beat ${++n} ${new Date().toISOString()}\n`);
  if (n >= 15) clearInterval(t);
}, 2000);
