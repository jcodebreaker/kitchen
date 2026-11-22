// Process groups the engine starts for a job: agents, checks, Toolkit calls.
//
// Each is spawned detached, so it leads its own process group (pgid = its pid)
// and everything it starts (an agent's shell tools, MCP servers, a check's test
// runner) is in that group. While it runs it is recorded as
// .kitchen/jobs/<id>/procs/<pgid>.json: { pgid, start, what, by, at }.
//
// - A process that exits normally, or on SIGTERM/SIGINT, kills the groups it
//   started (exit handler) and removes their records.
// - kill -9 leaves the records behind. The next `kitchen run` calls reapGroups
//   for every job before dispatching anything: each group still alive is killed
//   (TERM, then KILL after a grace) and waited for, so a resumed stage never
//   runs next to the agent of the stage it replaces.
// - A pid is never reused while a process group with that id exists, so a live
//   group with a recorded pgid is the recorded one. A live leader with another
//   start time is a reused pid and is left alone.
import fs from "node:fs";
import path from "node:path";
import { processStart } from "./lock.ts";

export type GroupRecord = { pgid: number; start: string | null; what: string; by: number; at: string };

export const procsDirOf = (jobDir: string) => path.join(jobDir, "procs");

/** Groups this process started that are still running: pgid → record file ("" when untracked on disk). */
const live = new Map<number, string>();
let hooked = false;

export function killGroup(pgid: number, sig: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Record a group the caller just spawned (detached). Returns `done`, which
 * removes the record and, unless `keepLeftovers`, kills whatever is left in the
 * group (the leader has exited; its children may not have). A Toolkit call
 * keeps them: `up` leaves the app running, and the slot's `down` owns it.
 */
export function trackGroup(dir: string | undefined, pid: number | undefined, what: string, o: { keepLeftovers?: boolean } = {}): () => void {
  if (!pid) return () => {};
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const pgid of live.keys()) killGroup(pgid, "SIGKILL");
    });
  }
  let file = "";
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${pid}.json`);
    const rec: GroupRecord = { pgid: pid, start: processStart(pid), what, by: process.pid, at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(rec));
  }
  live.set(pid, file);
  return () => {
    if (!o.keepLeftovers) killGroup(pid, "SIGKILL");
    live.delete(pid);
    if (file) fs.rmSync(file, { force: true });
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitDead(pgids: number[], ms: number): Promise<number[]> {
  const end = Date.now() + ms;
  let left = pgids.filter(groupAlive);
  while (left.length && Date.now() < end) {
    await sleep(50);
    left = left.filter(groupAlive);
  }
  return left;
}

/**
 * Kill every recorded group in `dir` that is still alive, wait until it is gone,
 * and remove the records. Returns the groups that were killed. Throws if one
 * survives SIGKILL (the job must not be dispatched next to it).
 */
export async function reapGroups(dir: string, graceMs = 3000): Promise<GroupRecord[]> {
  if (!fs.existsSync(dir)) return [];
  const killed: GroupRecord[] = [];
  const files: string[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const file = path.join(dir, name);
    let rec: GroupRecord;
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8")) as GroupRecord;
    } catch {
      fs.rmSync(file, { force: true }); // torn by the crash: its pid is in the name
      rec = { pgid: Number.parseInt(name, 10), start: null, what: "?", by: 0, at: "" };
      if (!Number.isInteger(rec.pgid) || rec.pgid <= 1) continue;
    }
    files.push(file);
    if (live.has(rec.pgid)) continue; // ours, running now
    const now = processStart(rec.pgid);
    if (now !== null && rec.start !== null && now !== rec.start) continue; // the pid was reused by another process
    if (groupAlive(rec.pgid) && killGroup(rec.pgid, "SIGTERM")) killed.push(rec);
  }
  let left = await waitDead(
    killed.map((k) => k.pgid),
    graceMs,
  );
  for (const g of left) killGroup(g, "SIGKILL");
  left = await waitDead(left, 2000);
  if (left.length) throw new Error(`process group(s) ${left.join(", ")} survive SIGKILL`);
  for (const f of files) if (!live.has(Number.parseInt(path.basename(f), 10))) fs.rmSync(f, { force: true });
  return killed;
}
