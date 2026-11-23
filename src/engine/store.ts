// Job folders (PLAN §2 "Files in the user's repo"): .kitchen/jobs/<NNN-slug>/
// job.json, ticket.md, intake.md, spec.md, rounds/<N>/…, evidence/. Engine-owned:
// outside every agent's writable root.
//
// - Writes are atomic (temp file in the same folder, fsync, rename).
// - job.json changes only under the per-job lock (the W0 drive lock: in-process
//   queue + owner-checked lock file), read-modify-write. `manifestHead` is never
//   taken from the caller: a drive or a stamped check may have advanced it, and
//   writing an older head back would look like a rollback.
// - Side effects carry a key in `filed` (`once`), checked before they run again.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { withFileLock } from "../lock.ts";
import { evidenceDir, raiseHeadFloor, sealOf, withJobLock } from "../proof/job.ts";
import { emptyHead, MANIFEST, verifyManifest } from "../proof/manifest.ts";
import { type Job, STAGES, type TicketRef } from "./machine.ts";

export const kitchenDir = (repo: string) => path.join(repo, ".kitchen");
export const jobsDir = (repo: string) => path.join(repo, ".kitchen", "jobs");
export const jobDirOf = (repo: string, id: string) => path.join(jobsDir(repo), id);
export const worktreeOf = (repo: string, id: string) => path.join(repo, ".worktrees", id);
/** Out folders for read-tier roles that run without a worktree. Engine-created, outside .kitchen/jobs/. */
export const scratchOf = (repo: string, id: string) => path.join(repo, ".kitchen", "scratch", id);
export const roundDir = (jobDir: string, round: number) => path.join(jobDir, "rounds", String(round));

export const JOB_ID = /^(\d{3,})-[a-z0-9-]{1,48}$/;

/** Pure: a short slug from a title. */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "ticket";
}

/** Pure: the next job number after the ones in use. */
export function nextNumber(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const m = JOB_ID.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export const jobIdOf = (n: number, title: string) => `${String(n).padStart(3, "0")}-${slugify(title)}`;

export const TITLE_MAX = 60;

/** Pure: `s` cut at a word boundary to about `max` characters, with an ellipsis when cut. */
function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const sp = head.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** "add a feature:", "Bug:", "feature request -" and the like: what the ticket is, not what it asks. */
const KIND_PREFIX =
  /^(?:please\s+)?(?:(?:add|file|create|open|new)\s+)?(?:an?\s+|the\s+)?(?:new\s+)?(?:feature(?:\s+request)?|bug(?:\s*fix|\s+report)?|fix|chore|task|ticket|story|request|issue|improvement|enhancement)\s*[:\-–—]\s*/i;

/** Control and format characters (bidi overrides, zero-width joiners…): never in a title, where they could reorder what a person reads. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
/** Shorter than this, a "sentence" is an abbreviation ("e.g.", "No.") or a fragment: keep reading. */
const MIN_SENTENCE = 12;

/** Pure: the first sentence of `s`: it ends at `.`, `!` or `?` followed by a space and a capital letter, at least MIN_SENTENCE in. */
function firstSentence(s: string): string {
  const end = /[.!?](?=\s+\p{Lu})/gu;
  for (let m = end.exec(s); m; m = end.exec(s)) if (m.index + 1 >= MIN_SENTENCE) return s.slice(0, m.index + 1);
  return s;
}

/**
 * Pure: the short title of a prompt ticket until intake gives one (ADR 0011): its first sentence, without a kind
 * prefix ("add a feature:"), cut at a word boundary at about 60 characters. The full text stays in ticket.md.
 */
export function titleOf(text: string): string {
  const first =
    text
      .split("\n")
      .map((l) => l.replace(INVISIBLE, "").trim())
      .find(Boolean) ?? "";
  const bare = first.replace(KIND_PREFIX, "").trim() || first;
  const sentence = firstSentence(bare).replace(/[.!]$/, "").trim();
  const t = cutAtWord(sentence, TITLE_MAX);
  return t ? t[0].toUpperCase() + t.slice(1) : "untitled";
}

/**
 * Pure: intake's `TITLE:` made safe to show: one line, no control or format characters, no backticks, `#` or angle
 * brackets (`_` and `*` stay: `snake_case` names and `a*b` are real titles), at most 60 characters; null when none.
 */
export function shortTitle(raw: string | undefined): string | null {
  const t = (raw ?? "")
    .replace(INVISIBLE, " ")
    .replace(/[`#<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t ? cutAtWord(t, TITLE_MAX) : null;
}

export function writeAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const jobFile = (dir: string) => path.join(dir, "job.json");

// job.json as the engine reads it. Loose: fields a later version adds are kept, not stripped.
const Stage = z.enum(STAGES);
const Risk = z.enum(["low", "medium", "high"]);
const Count = z.number().int().min(0);
export const JobSchema = z.looseObject({
  id: z.string().regex(JOB_ID),
  title: z.string(),
  ticket: z.looseObject({ source: z.enum(["prompt", "github"]), id: z.string(), url: z.string().optional() }),
  stage: Stage,
  pausedReason: z.string().optional(),
  pausedFrom: Stage.optional(),
  waitFor: z.enum(["backoff", "toolkit-pr", "ci", "toolkit-ticket", "no-toolkit"]).optional(),
  checksOnly: z.boolean().optional(),
  until: z.string().optional(),
  round: z.number().int().min(1),
  roundStart: z.number().int().min(1),
  roundLimit: z.number().int().min(1),
  risk: Risk.nullable(),
  riskFloor: Risk.nullable(),
  surfaces: z.array(z.enum(["ui", "security"])),
  kind: z.enum(["feature", "bug", "ui", "chore"]).nullable(),
  base: z.string(),
  branch: z.string(),
  worktree: z.string(),
  pr: z.number().int().nullable(),
  slot: z.object({ n: Count, ports: z.array(z.number().int()) }).nullable(),
  toolkitRef: z.string(),
  returnTo: Stage.nullable(),
  gap: z.string().nullable(),
  attempts: z.object({
    drives: Count,
    render: Count,
    toolkitTicket: Count,
    repro: Count,
    inconclusive: Count,
    backoff: Count,
    errors: Count,
    refused: Count,
    contract: Count.optional(),
  }),
  smith: z.object({ attempts: Count, toolkitPr: z.number().int().nullable() }),
  toolkitTicketRef: z.string().nullable(),
  filed: z.array(z.string()),
  agentRuns: z.array(z.looseObject({ key: z.string(), role: z.string(), stage: Stage, round: z.number(), ok: z.boolean() })),
  moves: Count,
  running: z.object({ pid: z.number().int(), start: z.string().nullable().optional(), stage: Stage, at: z.string() }).nullable(),
  escalatedFrom: Stage.optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().optional(),
  uid: z.string().min(1),
  gitDir: z.string(),
  toolkitBin: z.string(),
  slotId: z.string(),
  manifestHead: z.object({ n: Count, hash: z.string(), mac: z.string() }),
});

/** A job.json that can't be read or doesn't match the schema. The runner skips it; `status` lists it. */
export class CorruptJob extends Error {}

/** Pure: parse and check job.json text. Throws CorruptJob with a one-line reason. */
export function parseJob(text: string): Job {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CorruptJob(`not JSON: ${(e as Error).message}`);
  }
  const r = JobSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new CorruptJob(`${i.path.join(".") || "job"}: ${i.message}`);
  }
  return raw as Job; // validated; returned as written so no field is dropped
}

export function readJobAt(dir: string): Job {
  return parseJob(fs.readFileSync(jobFile(dir), "utf8"));
}

export type JobEntry = { id: string; job: Job; corrupt?: undefined } | { id: string; job?: undefined; corrupt: string };

/** Every job folder, each either read or marked corrupt with the reason. */
export function scanJobs(repo: string): JobEntry[] {
  const d = jobsDir(repo);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((id) => JOB_ID.test(id) && fs.existsSync(jobFile(path.join(d, id))))
    .sort()
    .map((id): JobEntry => {
      try {
        return { id, job: readJobAt(path.join(d, id)) };
      } catch (e) {
        return { id, corrupt: (e as Error).message.split("\n")[0] };
      }
    });
}

/** The jobs that read cleanly; a corrupt one is left out (scanJobs names it). */
export function listJobs(repo: string): Job[] {
  return scanJobs(repo).flatMap((e) => (e.job ? [e.job] : []));
}

/** A job by id, or by its number (`7` or `007`). */
export function findJob(repo: string, ref: string): Job {
  const jobs = listJobs(repo);
  const hit = /^\d+$/.test(ref) ? jobs.find((j) => Number(JOB_ID.exec(j.id)?.[1]) === Number(ref)) : jobs.find((j) => j.id === ref);
  if (!hit) {
    const bad = scanJobs(repo).find((e) => e.corrupt && (e.id === ref || Number(JOB_ID.exec(e.id)?.[1]) === Number(ref)));
    throw new Error(bad ? `job ${bad.id} is corrupt (${bad.corrupt})` : `no job ${ref}`);
  }
  return hit;
}

export type NewJob = {
  title: string;
  ticket: TicketRef;
  body: string;
  roundLimit: number;
  base: string;
  /** The base sha when the base has a Toolkit: the job's proofs run with that sha's engine-owned checkout. Else "". */
  toolkitRef?: string;
  now?: Date;
};

/**
 * Create a job folder. Numbers are taken under a lock, so two `kitchen ticket`s
 * never share one. A ticket from a source with stable ids (GitHub) is taken in
 * once: the same ref returns the existing job.
 */
export async function createJob(repo: string, o: NewJob): Promise<{ job: Job; created: boolean }> {
  fs.mkdirSync(jobsDir(repo), { recursive: true });
  return withFileLock(path.join(jobsDir(repo), ".create.lock"), async () => {
    if (o.ticket.source !== "prompt") {
      const same = listJobs(repo).find((j) => j.ticket.source === o.ticket.source && j.ticket.id === o.ticket.id);
      if (same) return { job: same, created: false };
    }
    const id = jobIdOf(nextNumber(fs.readdirSync(jobsDir(repo))), o.title);
    const dir = jobDirOf(repo, id);
    fs.mkdirSync(dir); // fails if it exists: ids are never reused under the lock
    fs.mkdirSync(evidenceDir(dir), { recursive: true });
    writeAtomic(path.join(dir, "ticket.md"), `# ${o.title}\n\n${o.body.trim()}\n`);
    const now = (o.now ?? new Date()).toISOString();
    const uid = randomUUID();
    const job: Job = {
      id,
      title: o.title,
      ticket: o.ticket,
      stage: "intake",
      round: 1,
      roundStart: 1,
      roundLimit: o.roundLimit,
      risk: null,
      riskFloor: null,
      surfaces: [],
      kind: null,
      base: o.base,
      branch: `kitchen/${id}`,
      worktree: "",
      pr: null,
      slot: null,
      toolkitRef: o.toolkitRef ?? "",
      returnTo: null,
      gap: null,
      attempts: { drives: 0, render: 0, toolkitTicket: 0, repro: 0, inconclusive: 0, backoff: 0, errors: 0, refused: 0 },
      smith: { attempts: 0, toolkitPr: null },
      toolkitTicketRef: null,
      filed: [],
      agentRuns: [],
      moves: 0,
      running: null,
      startedAt: now,
      updatedAt: now,
      uid,
      gitDir: "",
      toolkitBin: "", // resolved from toolkitRef by src/engine/job-toolkit.ts
      // The id the Toolkit gets (`--id`): short and unique across repos, since the slot pool and Docker names are machine-wide.
      slotId: `${id.slice(0, id.indexOf("-"))}-${uid.replace(/-/g, "").slice(0, 10)}`,
      manifestHead: emptyHead(sealOf({ uid })),
    };
    writeAtomic(jobFile(dir), `${JSON.stringify(job, null, 2)}\n`);
    raiseHeadFloor(uid, 0);
    return { job, created: true };
  });
}

/**
 * Read-modify-write job.json under the per-job lock. `fn` gets the job as it is
 * on disk and returns the new one (or mutates it). The manifest head always
 * stays as it is on disk: only the drive/stamp path moves it.
 */
export async function updateJob(repo: string, id: string, fn: (j: Job) => Job | undefined | Promise<Job | undefined>): Promise<Job> {
  const dir = jobDirOf(repo, id);
  return withJobLock(dir, async () => {
    const disk = readJobAt(dir);
    const next = (await fn(structuredClone(disk))) ?? disk;
    next.manifestHead = disk.manifestHead;
    next.uid = disk.uid;
    next.id = disk.id;
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (text !== `${JSON.stringify(disk, null, 2)}\n`) writeAtomic(jobFile(dir), text); // unchanged: no write
    return next;
  });
}

/**
 * Run a side effect once per key. The key is checked before it runs and recorded
 * after; a crash in between runs it again, so `fn` itself must look before it
 * acts (PR lookup by branch, ticket lookup by key). Returns the stored value.
 */
export async function once<T>(repo: string, id: string, key: string, fn: () => Promise<T>): Promise<{ value: T | undefined; did: boolean }> {
  const dir = jobDirOf(repo, id);
  const memo = path.join(dir, "filed", `${encodeURIComponent(key)}.json`);
  if (readJobAt(dir).filed.includes(key)) {
    return { value: fs.existsSync(memo) ? (JSON.parse(fs.readFileSync(memo, "utf8")) as T) : undefined, did: false };
  }
  const value = await fn();
  writeAtomic(memo, JSON.stringify(value ?? null));
  await updateJob(repo, id, (j) => {
    if (!j.filed.includes(key)) j.filed.push(key);
    return j;
  });
  return { value, did: true };
}

/**
 * Resume: a crash between a manifest append and the job.json head write leaves
 * lines past the signed head (ADR 0006, "Not verified"). Cut the manifest back
 * to the head, but only if what stays verifies against it; anything else is
 * tampering and is left for verifyManifest to refuse. The cut lines are kept
 * beside it as `manifest.jsonl.tail-<time>`, and their e<N>/ folders removed
 * (the next drive would overwrite them anyway).
 */
export async function repairManifest(repo: string, id: string, now = new Date()): Promise<{ from: number; to: number; kept: string } | null> {
  const dir = jobDirOf(repo, id);
  return withJobLock(dir, async () => {
    const job = readJobAt(dir);
    const ev = evidenceDir(dir);
    const file = path.join(ev, MANIFEST);
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const n = job.manifestHead.n;
    const torn = !text.endsWith("\n") && text !== "";
    if (lines.length <= n && !torn) return null;
    if (lines.length < n) return null; // shorter than the head: not a crash tail; verifyManifest refuses it
    const kept = `${file}.tail-${now.toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, kept);
    writeAtomic(file, n ? `${lines.slice(0, n).join("\n")}\n` : "");
    try {
      verifyManifest(ev, job.manifestHead, sealOf(job));
    } catch (e) {
      fs.copyFileSync(kept, file); // not ours to fix
      fs.rmSync(kept);
      throw e;
    }
    for (let k = n + 1; k <= lines.length; k++) fs.rmSync(path.join(ev, `e${k}`), { recursive: true, force: true });
    return { from: lines.length, to: n, kept };
  });
}
