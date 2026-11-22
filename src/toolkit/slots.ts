// Slot pool: each slot owns a block of 20 ports in 31000–32767 (below the
// Linux ephemeral range), checked free by probing. The pool lives in
// $KITCHEN_HOME/slots.json (default ~/.kitchen), shared across repos. A slot
// whose owner pid has died is stale: its `down` runs first, then it is reclaimed.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const PORT_LO = 31000;
export const PORT_HI = 32767;
export const BLOCK = 20;

export type Slot = { n: number; id: string; ports: number[]; pid: number; at: string };
type Registry = { slots: Slot[] };

export const kitchenHome = () => process.env.KITCHEN_HOME || path.join(os.homedir(), ".kitchen");

export const blockCount = (lo = PORT_LO, hi = PORT_HI, size = BLOCK) => Math.floor((hi - lo + 1) / size);
export const portsOf = (n: number, lo = PORT_LO, size = BLOCK) => Array.from({ length: size }, (_, i) => lo + n * size + i);

/** First block not taken by the registry whose every port probes free. Pure apart from the probe. */
export async function pickBlock(taken: Set<number>, isFree: (port: number) => Promise<boolean>, lo = PORT_LO, hi = PORT_HI, size = BLOCK): Promise<number | null> {
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

/** Split slots into live and stale by asking whether each owner pid lives. */
export function partitionStale(slots: Slot[], isAlive: (pid: number) => boolean): { live: Slot[]; stale: Slot[] } {
  const live: Slot[] = [];
  const stale: Slot[] = [];
  for (const s of slots) (isAlive(s.pid) ? live : stale).push(s);
  return { live, stale };
}

export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(home, { recursive: true });
  const lock = path.join(home, "slots.lock");
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      // A lock older than 30 s belongs to a dead process.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (i > 200) throw new Error(`slots lock ${lock} busy`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
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

export type AcquireOpts = {
  id: string;
  pid?: number;
  home?: string;
  /** Called for each stale slot before it is reclaimed (runs the Toolkit's down). */
  onStale?: (s: Slot) => Promise<void>;
  isFree?: (port: number) => Promise<boolean>;
  isAlive?: (pid: number) => boolean;
};

export async function acquireSlot(o: AcquireOpts): Promise<{ slot: Slot; reclaimed: Slot[] }> {
  const home = o.home ?? kitchenHome();
  const isAlive = o.isAlive ?? pidAlive;
  return withLock(home, async () => {
    const reg = load(home);
    const { live, stale } = partitionStale(reg.slots, isAlive);
    for (const s of stale) await o.onStale?.(s);
    const mine = live.find((s) => s.id === o.id);
    if (mine) {
      save(home, { slots: live });
      return { slot: mine, reclaimed: stale };
    }
    const n = await pickBlock(new Set(live.map((s) => s.n)), o.isFree ?? probePort);
    if (n === null) throw new Error("no free block of 20 ports in 31000–32767");
    const slot: Slot = { n, id: o.id, ports: portsOf(n), pid: o.pid ?? process.pid, at: new Date().toISOString() };
    save(home, { slots: [...live, slot] });
    return { slot, reclaimed: stale };
  });
}

export async function releaseSlot(id: string, home = kitchenHome()): Promise<Slot | null> {
  return withLock(home, async () => {
    const reg = load(home);
    const s = reg.slots.find((x) => x.id === id) ?? null;
    save(home, { slots: reg.slots.filter((x) => x.id !== id) });
    return s;
  });
}

export function listSlots(home = kitchenHome()): Slot[] {
  return load(home).slots;
}
