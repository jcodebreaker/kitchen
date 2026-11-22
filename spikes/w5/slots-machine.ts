// W5 follow-up 1, no Docker, no agent (~2 s): the slot registry is machine-wide.
// Two Kitchen processes with different KITCHEN_HOMEs (a dogfood run and a
// benchmark) acquire slots at the same time: they share one registry (the
// default ~/.kitchen-slots under a scratch HOME, KITCHEN_SLOTS unset) and never
// get overlapping blocks; a port held by a plain node listener on 127.0.0.1 is
// skipped. Searches start at block 80 (32600+), clear of a running benchmark.
//
//   node spikes/w5/slots-machine.ts [scratch]
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIRST = 80;
const SELF = fileURLToPath(import.meta.url);

if (process.argv[2] === "child") {
  const { acquireSlot } = await import("../../src/toolkit/slots.ts");
  const who = process.argv[3];
  const owner = Number(process.argv[4]);
  const got = [];
  for (let i = 0; i < 3; i++) {
    const { slot } = await acquireSlot({ id: `${who}-${i}`, toolkitBin: "/nonexistent/bin/dev", src: "/nonexistent", pid: owner, firstBlock: FIRST });
    got.push(slot.n);
  }
  console.log(JSON.stringify({ who, home: process.env.KITCHEN_HOME, blocks: got }));
  process.exit(0);
}

let fails = 0;
const check = (name: string, ok: boolean, ev = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ev ? `: ${ev}` : ""}`);
};

const scratch = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-slots-spike-")));
const fakeHome = path.join(scratch, "home");
fs.rmSync(fakeHome, { recursive: true, force: true });
fs.mkdirSync(fakeHome, { recursive: true });

// A plain listener on the first port of block 80, loopback only.
const heldPort = 31000 + FIRST * 20;
const srv = net.createServer();
await new Promise<void>((res, rej) => {
  srv.once("error", rej);
  srv.listen({ port: heldPort, host: "127.0.0.1" }, () => res());
});

const env = (home: string): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, KITCHEN_HOME: path.join(scratch, home) };
  delete e.KITCHEN_SLOTS;
  return e;
};
const run = (who: string, home: string) =>
  new Promise<{ who: string; home: string; blocks: number[] }>((resolve, reject) => {
    const p = spawn(process.execPath, [SELF, "child", who, String(process.pid)], { env: env(home), stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(`${who} exited ${code}`))));
  });

const [a, b] = await Promise.all([run("dogfood", "home-dogfood"), run("bench", "home-bench")]);
srv.close();
console.log(JSON.stringify(a));
console.log(JSON.stringify(b));

const reg = path.join(fakeHome, ".kitchen-slots", "slots.json");
const slots = (JSON.parse(fs.readFileSync(reg, "utf8")) as { slots: { id: string; n: number }[] }).slots;
check("two KITCHEN_HOMEs, one registry at ~/.kitchen-slots/slots.json", a.home !== b.home && slots.length === 6, `${slots.length} slots in ${reg}`);
check(
  "neither home holds a slots.json",
  !fs.existsSync(path.join(scratch, "home-dogfood", "slots.json")) && !fs.existsSync(path.join(scratch, "home-bench", "slots.json")),
);
const all = [...a.blocks, ...b.blocks];
check("no block handed out twice across the two processes", new Set(all).size === all.length, all.join(","));
check(`block ${FIRST} (port ${heldPort} held by a node listener on 127.0.0.1) skipped`, !all.includes(FIRST));
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\nslots-machine: ${fails ? `${fails} failed` : "all passed"}`);
process.exitCode = fails ? 1 : 0;
