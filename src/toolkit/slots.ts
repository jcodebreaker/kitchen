// Slot pool: each slot owns a block of 20 ports in 31000–32767 (below the
// Linux ephemeral range), checked free by probing. The pool lives in
// $KITCHEN_HOME/slots.json, shared across repos, so each slot records which
// Toolkit started it and from which source: reclaiming a stale slot runs *that*
// Toolkit's `down`. A slot is stale when its owner process is gone: the pid is
// dead, or it now belongs to another process (start time differs).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureHome, kitchenHome } from "../home.ts";
import { type Owner, ownerAlive, processStart, withFileLock } from "../lock.ts";
import { runToolkit } from "./run.ts";

export const PORT_LO = 31000;
export const PORT_HI = 32767;
export const BLOCK = 20;

export type Slot = {
  n: number;
  id: string;
  ports: number[];
  pid: number;
  /** Owner process start time (`ps -o lstart`), to tell a reused pid apart. */
  pidStart: string | null;
  /** The bin/dev that runs `up`/`down` for this slot, and the source it serves. */
  toolkitBin: string;
  src: string;
  at: string;
};
type Registry = { slots: Slot[] };

export const blockCount = (lo = PORT_LO, hi = PORT_HI, size = BLOCK) => Math.floor((hi - lo + 1) / size);
export const portsOf = (n: number, lo = PORT_LO, size = BLOCK) => Array.from({ length: size }, (_, i) => lo + n * size + i);

/** First block not taken by the registry whose every port probes free. Pure apart from the probe. */
export async function pickBlock(
  taken: Set<number>,
  isFree: (port: number) => Promise<boolean>,
  lo = PORT_LO,
  hi = PORT_HI,
  size = BLOCK,
): Promise<number | null> {
  for (let n = 0; n < blockCount(lo, hi, size); n++) {
    if (taken.has(n)) continue;
    let ok = true;
    for (const p of portsOf(n, lo, size)) {
      if (!(await isFree(p))) {
        ok = false;
        break;
      }
    }
    if (ok) return n;
  }
  return null;
}

/** Split slots into live and stale by asking whether each owner process lives. */
export function partitionStale(slots: Slot[], isAlive: (o: Owner) => boolean): { live: Slot[]; stale: Slot[] } {
  const live: Slot[] = [];
  const stale: Slot[] = [];
  for (const s of slots) (isAlive({ pid: s.pid, start: s.pidStart ?? null }) ? live : stale).push(s);
  return { live, stale };
}

export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function load(home: string): Registry {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "slots.json"), "utf8")) as Registry;
  } catch {
    return { slots: [] };
  }
}
function save(home: string, reg: Registry) {
  const f = path.join(home, "slots.json");
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(reg, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

/** Runs the slot's own Toolkit `down`, with the untrusted env. */
export async function downSlot(s: Slot): Promise<void> {
  if (!s.toolkitBin || !fs.existsSync(s.toolkitBin)) return;
  await runToolkit(s.toolkitBin, ["down", "--id", s.id], { src: s.src });
}

export type AcquireOpts = {
  id: string;
  toolkitBin: string;
  src: string;
  pid?: number;
  home?: string;
  /** Called for each stale slot before it is dropped (default: its own Toolkit's down). */
  onStale?: (s: Slot) => Promise<void>;
  isFree?: (port: number) => Promise<boolean>;
  isAlive?: (o: Owner) => boolean;
};

export async function acquireSlot(o: AcquireOpts): Promise<{ slot: Slot; reclaimed: Slot[] }> {
  const home = ensureHome(o.home ?? kitchenHome());
  const isAlive = o.isAlive ?? ((x: Owner) => ownerAlive(x));
  return withFileLock(path.join(home, "slots.lock"), async () => {
    const reg = load(home);
    const { live, stale } = partitionStale(reg.slots, isAlive);
    for (const s of stale) await (o.onStale ?? downSlot)(s);
    const mine = live.find((s) => s.id === o.id);
    if (mine) {
      save(home, { slots: live });
      return { slot: mine, reclaimed: stale };
    }
    const n = await pickBlock(new Set(live.map((s) => s.n)), o.isFree ?? probePort);
    if (n === null) throw new Error("no free block of 20 ports in 31000–32767");
    const pid = o.pid ?? process.pid;
    const slot: Slot = {
      n,
      id: o.id,
      ports: portsOf(n),
      pid,
      pidStart: processStart(pid),
      toolkitBin: path.resolve(o.toolkitBin),
      src: path.resolve(o.src),
      at: new Date().toISOString(),
    };
    save(home, { slots: [...live, slot] });
    return { slot, reclaimed: stale };
  });
}

export async function releaseSlot(id: string, home = kitchenHome()): Promise<Slot | null> {
  return withFileLock(path.join(ensureHome(home), "slots.lock"), async () => {
    const reg = load(home);
    const s = reg.slots.find((x) => x.id === id) ?? null;
    save(home, { slots: reg.slots.filter((x) => x.id !== id) });
    return s;
  });
}

export function listSlots(home = kitchenHome()): Slot[] {
  return load(home).slots;
}
