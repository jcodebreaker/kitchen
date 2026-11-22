// The run lock: .kitchen/run.lock, one `kitchen run` per repo (PLAN §4).
// It names its owner (pid + process start time) and carries a heartbeat the
// owner rewrites every 30 s. Another runner takes it over when the owner is
// gone (dead pid, or the pid now belongs to another process) or its heartbeat
// is older than 120 s (a hung or suspended owner). Take-over renames the file
// aside and puts it back if it changed in between, as src/lock.ts does.
// The owner checks on every beat that the lock still names it, and stops if not.
import fs from "node:fs";
import path from "node:path";
import { type Owner, ownerAlive, self } from "../lock.ts";
import { writeAtomic } from "./store.ts";

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;

export type RunLockInfo = Owner & { heartbeat: string; startedAt: string; log?: string; argv?: string[] };

export const runLockFile = (repo: string) => path.join(repo, ".kitchen", "run.lock");

export function readRunLock(repo: string): { raw: string; info: RunLockInfo | null } | null {
  try {
    const raw = fs.readFileSync(runLockFile(repo), "utf8");
    try {
      return { raw, info: JSON.parse(raw) as RunLockInfo };
    } catch {
      return { raw, info: null };
    }
  } catch {
    return null;
  }
}

/** Pure apart from the liveness probe: why a lock may be taken over, or null if its owner holds it. */
export function staleReason(info: RunLockInfo | null, now: number, isAlive: (o: Owner) => boolean = (o) => ownerAlive(o)): string | null {
  if (!info) return "unreadable lock file";
  if (!isAlive({ pid: info.pid, start: info.start })) return `owner pid ${info.pid} is gone`;
  const age = now - Date.parse(info.heartbeat);
  if (!(age <= STALE_MS)) return `heartbeat ${Math.round(age / 1000)}s old`;
  return null;
}

export class RunLockHeld extends Error {}

export type RunLock = { info: RunLockInfo; takenOver: string | null; previous: RunLockInfo | null; lost: () => boolean; release: () => void };

/** Take the run lock or throw RunLockHeld naming the live owner. */
export function acquireRunLock(repo: string, extra: { log?: string; argv?: string[] } = {}): RunLock {
  const file = runLockFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const me = self();
  const startedAt = new Date().toISOString();
  const info = (): RunLockInfo => ({ ...me, heartbeat: new Date().toISOString(), startedAt, ...extra });
  let takenOver: string | null = null;
  let previous: RunLockInfo | null = null;
  for (let tries = 0; ; tries++) {
    try {
      fs.writeFileSync(file, JSON.stringify(info()), { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const cur = readRunLock(repo);
    if (!cur) continue; // released between our create and read
    const why = staleReason(cur.info, Date.now());
    if (!why) throw new RunLockHeld(`kitchen run is already running (pid ${cur.info?.pid}, heartbeat ${cur.info?.heartbeat})`);
    if (tries > 5) throw new RunLockHeld(`could not take over ${file}`);
    const aside = `${file}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      if (fs.readFileSync(aside, "utf8") !== cur.raw) {
        try {
          fs.linkSync(aside, file); // someone replaced it meanwhile: put theirs back
        } catch {}
      } else {
        takenOver = why;
        previous = cur.info;
      }
      fs.rmSync(aside, { force: true });
    } catch {}
  }
  const mine = (i: RunLockInfo | null | undefined) => !!i && i.pid === me.pid && i.start === me.start;
  let lost = false;
  const beat = setInterval(() => {
    const cur = readRunLock(repo);
    if (!mine(cur?.info)) {
      lost = true;
      clearInterval(beat);
      return;
    }
    writeAtomic(file, JSON.stringify({ ...cur?.info, heartbeat: new Date().toISOString() }));
  }, HEARTBEAT_MS);
  beat.unref();
  return {
    info: info(),
    takenOver,
    previous,
    lost: () => lost || !mine(readRunLock(repo)?.info),
    release: () => {
      clearInterval(beat);
      if (mine(readRunLock(repo)?.info)) fs.rmSync(file, { force: true });
    },
  };
}
