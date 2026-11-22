// Stand-in for `kitchen run --detach`: start hb.mjs fully detached, print its pid, exit at once.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const hb = fileURLToPath(new URL("./hb.mjs", import.meta.url));
const child = spawn(process.execPath, [hb, process.argv[2] ?? ""], { detached: true, stdio: "ignore" });
child.unref();
console.log(`detached pid ${child.pid}`);
