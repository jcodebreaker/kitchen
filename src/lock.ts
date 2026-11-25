// Cross-process lock file. The lock is a file created with O_EXCL that names its
// owner (pid + process start time). It is taken over only when that owner is
// gone: dead pid, or a live pid whose start time differs (the pid was reused).
// It is never stolen by age, so a holder running a long `down` keeps it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Owner = { pid: number; start: string | null };

/** `ps -o <field>=` for one process, in `env`; null if there is no such process. */
function psField(pid: number, field: string, env: NodeJS.ProcessEnv): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Start time of a process as `ps` prints it, or null if there is no such process. ADR 0030: in the C locale and UTC,
 * whatever the caller's LANG, LC_ALL or TZ (a run woken from the dashboard and a terminal must read the same text,
 * or one takes the other's lock over).
 */
export function processStart(pid: number, env: NodeJS.ProcessEnv = process.env): string | null {
  return psField(pid, "lstart", { ...env, LC_ALL: "C", LANG: "C", TZ: "UTC" });
}

/** The start as an earlier Kitchen stored it: `ps` in the caller's own locale and time zone. */
export const localStart = (pid: number, env: NodeJS.ProcessEnv = process.env): string | null => psField(pid, "lstart", env);

let selfStart: string | null | undefined;
export const self = (): Owner => {
  if (selfStart === undefined) selfStart = processStart(process.pid);
  return { pid: process.pid, start: selfStart };
};

/** `ps -o lstart=` in the C locale: "Wed Nov 25 03:02:25 2026". */
const C_START = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d\d:\d\d:\d\d \d{4}$/;

/**
 * ADR 0030: a stored start an earlier Kitchen wrote can't say whether it is this process: it was read in a locale
 * (another language) or a time zone (C text, whole quarter-hours off) the caller can't reproduce.
 */
function unjudged(stored: string, now: string): boolean {
  if (!C_START.test(stored)) return true;
  const d = (Date.parse(`${stored} UTC`) - Date.parse(`${now} UTC`)) / 1000;
  return Number.isFinite(d) && d !== 0 && d % 900 === 0 && Math.abs(d) <= 14 * 3600;
}

/**
 * True while the process that `o` names is still the same process. ADR 0030: a start stored by an earlier Kitchen (in
 * its caller's locale and time zone, before starts were read in C and UTC) is the same process if this caller reads
 * it the same way; if it can't be judged at all, a live pid running Kitchen or Claude is taken as its owner, so a live
 * run is never taken over (its lanes would double).
 */
/**
 * ADR 0030: positively the process `o` names, as anything that kills it needs: its stored start matches, read in C and
 * UTC or in the caller's own locale. Never on a bare pid, and never on ownerAlive's benefit of the doubt.
 */
export function sameProcess(o: Owner, env: NodeJS.ProcessEnv = process.env): boolean {
  if (o.start === null) return false;
  return processStart(o.pid) === o.start || localStart(o.pid, env) === o.start;
}

/** ADR 0030: the line when a kill is held back because the pid can't be confirmed as `what` (ownerAlive's doubt). */
export const unconfirmed = (pid: number, what: string) => `can't confirm pid ${pid} is ${what}: stop it yourself (kill ${pid})`;

export function ownerAlive(o: Owner, startOf: (pid: number) => string | null = processStart, env: NodeJS.ProcessEnv = process.env): boolean {
  const now = startOf(o.pid);
  if (now === null) return false;
  if (o.start === null || o.start === now) return true;
  if (startOf !== processStart) return false;
  if (localStart(o.pid, env) === o.start) return true;
  return unjudged(o.start, now) && /kitchen|claude/i.test(psField(o.pid, "command", env) ?? "");
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

/**
 * ADR 0030: the lock without waiting. Taken and `release` returned, or the live owner that holds it. The lock appears
 * whole (written to a temp file, then linked into place), so an empty or unreadable lock is never one being written:
 * like a lock whose owner is gone (a dead pid, or a reused one), it is taken over.
 */
/** link() errors of a file system without hard links. */
const NO_LINK = ["EPERM", "ENOTSUP", "ENOSYS", "EXDEV", "EOPNOTSUPP"];
/** How long an empty lock may be one another process is writing. */
const WRITING_MS = 3_000;
const mtimeOf = (f: string) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};
/** O_EXCL create, write, fsync; false if it exists already. */
function writeExclusive(file: string, text: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** ADR 0030: the link() tryFileLock uses; a seam for a file system without hard links. */
export const lockFs = { link: (a: string, b: string) => fs.linkSync(a, b) };

export function tryFileLock(file: string): { release: () => void } | { heldBy: Owner } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const me = JSON.stringify(self());
  const mine = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(mine, me);
  try {
    for (let i = 0; i < 3; i++) {
      const taken = {
        release: () => {
          if (readOwner(file)?.raw === me) fs.rmSync(file, { force: true });
        },
      };
      try {
        lockFs.link(mine, file);
        return taken;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && !NO_LINK.includes(code ?? "")) throw e;
        // A file system without hard links: create it exclusively and write it at once (it is empty for an instant).
        if (code !== "EEXIST" && writeExclusive(file, me)) return taken;
      }
      const cur = readOwner(file);
      if (!cur) continue;
      if (cur.owner && ownerAlive(cur.owner)) return { heldBy: cur.owner };
      // Empty or unreadable: being written only if it is that young; else garbage, taken over.
      if (!cur.owner && Date.now() - mtimeOf(file) < WRITING_MS) return { heldBy: { pid: 0, start: null } };
      const tmp = `${file}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(file, tmp);
        if (readOwner(tmp)?.raw !== cur.raw)
          try {
            fs.linkSync(tmp, file);
          } catch {}
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
    const last = readOwner(file)?.owner;
    return { heldBy: last ?? { pid: 0, start: null } };
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

/** ADR 0030: the live owner of a lock, or null (none, or one that is gone). Takes nothing. */
export function lockOwner(file: string): Owner | null {
  const o = readOwner(file)?.owner;
  return o && ownerAlive(o) ? o : null;
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
