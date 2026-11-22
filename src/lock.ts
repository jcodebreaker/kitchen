// Cross-process lock file. The lock is a file created with O_EXCL that names its
// owner (pid + process start time). It is taken over only when that owner is
// gone: dead pid, or a live pid whose start time differs (the pid was reused).
// It is never stolen by age, so a holder running a long `down` keeps it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Owner = { pid: number; start: string | null };

/** Start time of a process as `ps` prints it, or null if there is no such process. */
export function processStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

let selfStart: string | null | undefined;
export const self = (): Owner => {
  if (selfStart === undefined) selfStart = processStart(process.pid);
  return { pid: process.pid, start: selfStart };
};

/** True while the process that `o` names is still the same process. */
export function ownerAlive(o: Owner, startOf: (pid: number) => string | null = processStart): boolean {
  const now = startOf(o.pid);
  if (now === null) return false;
  return o.start === null || o.start === now;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readOwner(file: string): { raw: string; owner: Owner | null } | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    try {
      return { raw, owner: JSON.parse(raw) as Owner };
    } catch {
      return { raw, owner: null };
    }
  } catch {
    return null;
  }
}

export async function withFileLock<T>(file: string, fn: () => Promise<T>, o: { timeoutMs?: number } = {}): Promise<T> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const me = JSON.stringify(self());
  const end = Date.now() + (o.timeoutMs ?? 120_000);
  let emptySince = 0;
  for (;;) {
    try {
      fs.writeFileSync(file, me, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const cur = readOwner(file);
    if (cur) {
      // An empty file is an owner between create and write; give it 2 s.
      if (!cur.owner && !emptySince) emptySince = Date.now();
      const stale = cur.owner ? !ownerAlive(cur.owner) : emptySince < Date.now() - 2000;
      if (stale) {
        const tmp = `${file}.stale-${process.pid}-${Date.now()}`;
        try {
          fs.renameSync(file, tmp);
          // If someone else replaced the stale lock between our read and the rename, put theirs back.
          if (readOwner(tmp)?.raw !== cur.raw) {
            try {
              fs.linkSync(tmp, file);
            } catch {}
          }
          fs.rmSync(tmp, { force: true });
        } catch {}
        emptySince = 0;
        continue;
      }
    }
    if (Date.now() > end) throw new Error(`lock ${file} held by ${cur?.raw ?? "?"}`);
    await sleep(50);
  }
  try {
    return await fn();
  } finally {
    if (readOwner(file)?.raw === me) fs.rmSync(file, { force: true });
  }
}

/** In-process queue per key, so concurrent calls in one process (the MCP server) run in order. */
const queues = new Map<string, Promise<unknown>>();
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}
