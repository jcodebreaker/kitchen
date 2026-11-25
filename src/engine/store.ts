// Job folders: .kitchen/jobs/<NNN-slug>/ with job.json, ticket.md, intake.md, rounds/<N>/ (checks, QA evidence and
// verdict, the review), messages.jsonl, activity/, report.html. job.json is written only by `kitchen job` verbs and
// the person's verbs (steer, pause, feedback…), always through updateJob: read-modify-write under the job's lock,
// atomic (temp file, fsync, rename).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { withFileLock } from "../lock.ts";
import { type Job, type JobFrom, LANES, STAGES, type TicketRef } from "./machine.ts";

export const kitchenDir = (repo: string) => path.join(repo, ".kitchen");
export const jobsDir = (repo: string) => path.join(repo, ".kitchen", "jobs");
export const jobDirOf = (repo: string, id: string) => path.join(jobsDir(repo), id);
export const worktreeOf = (repo: string, id: string) => path.join(repo, ".worktrees", id);
/** ADR 0025 §1: intake's read-only checkout of the job's base (detached), while its lane is open. */
export const intakeCheckoutOf = (repo: string, id: string) => path.join(repo, ".kitchen", "intake", id);
export const roundDir = (jobDir: string, round: number) => path.join(jobDir, "rounds", String(round));
/**
 * Build's checks.json for `round`: that round's, else the latest earlier one's (ADR 0029 §2: a QA retry starts a
 * round folder Build didn't run in). The path, possibly missing.
 */
export function checksFile(jobDir: string, round: number): string {
  for (let r = round; r >= 1; r--) {
    const f = path.join(roundDir(jobDir, r), "checks.json");
    if (fs.existsSync(f)) return f;
  }
  return path.join(roundDir(jobDir, round), "checks.json");
}

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
const withJobLock = <T>(dir: string, fn: () => Promise<T>) => withFileLock(path.join(dir, "job.lock"), fn);

// job.json as Kitchen reads it. Loose: fields an older or later version wrote are kept, not stripped.
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
  escalatedFrom: Stage.optional(),
  round: z.number().int().min(1),
  roundStart: z.number().int().min(1),
  roundLimit: z.number().int().min(1),
  catchUps: Count.optional(),
  risk: Risk.nullable(),
  surfaces: z.array(z.enum(["ui", "security"])),
  kind: z.enum(["feature", "bug", "ui", "chore", "check"]).nullable(),
  base: z.string(),
  branch: z.string(),
  worktree: z.string(),
  target: z.string().min(1).optional(),
  pr: z.looseObject({ number: z.number().int(), url: z.string(), state: z.enum(["open", "merged", "closed"]).optional() }).nullable(),
  files: z.array(z.string()).optional(),
  after: z.array(z.string()).optional(),
  running: z.looseObject({ lane: z.enum(LANES), at: z.string(), key: z.string() }).nullable(),
  agentRuns: z.array(z.looseObject({ key: z.string(), role: z.string(), stage: Stage, round: z.number(), at: z.string() })),
  moves: Count,
  held: z.string().optional(),
  filed: z.array(z.string()),
  startedAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().optional(),
});

/** A job.json that can't be read or doesn't match the schema. The plan skips it; `status` lists it. */
export class CorruptJob extends Error {}

/** Stages an older Kitchen used, folded into today's: a job from before ADR 0016 keeps reading. */
const OLD_STAGE: Record<string, string> = { spec: "intake", repro: "build", gate: "build", drives: "qa", verify: "qa", toolkit: "qa", report: "ready" };

/** Pure: a job.json from before ADR 0016 brought to today's shape (its stages folded, the Toolkit fields dropped). */
export function upgradeJob(raw: Record<string, unknown>): Record<string, unknown> {
  const j = { ...raw };
  for (const k of ["stage", "pausedFrom", "escalatedFrom"]) if (typeof j[k] === "string" && OLD_STAGE[j[k] as string]) j[k] = OLD_STAGE[j[k] as string];
  if (j.running && typeof j.running === "object" && !("lane" in (j.running as object))) j.running = null;
  // ADR 0026: `pr` was the PR's number; it is { number, url } now.
  if (typeof j.pr === "number") j.pr = { number: j.pr, url: "" };
  if (Array.isArray(j.agentRuns))
    j.agentRuns = (j.agentRuns as Record<string, unknown>[]).map((r) => ({
      ...r,
      stage: OLD_STAGE[r.stage as string] ?? r.stage,
      at: r.at ?? j.startedAt,
    }));
  return j;
}

/** Pure: parse and check job.json text. Throws CorruptJob with a one-line reason. */
export function parseJob(text: string): Job {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CorruptJob(`not JSON: ${(e as Error).message}`);
  }
  const up = raw && typeof raw === "object" && !Array.isArray(raw) ? upgradeJob(raw as Record<string, unknown>) : raw;
  const r = JobSchema.safeParse(up);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new CorruptJob(`${i.path.join(".") || "job"}: ${i.message}`);
  }
  return up as Job; // validated; returned as written so no field is dropped
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
  now?: Date;
  from?: JobFrom;
  target?: string;
  /** ADR 0028 §5: filed as a check (`kitchen ticket --check`). */
  check?: boolean;
  /** ADR 0028 §5: the check's schedule filed it, this often ("day", "hour"…). */
  schedule?: string;
};

/** Create a job folder. Numbers are taken under a lock, so two `kitchen ticket`s never share one. */
export async function createJob(repo: string, o: NewJob): Promise<Job> {
  fs.mkdirSync(jobsDir(repo), { recursive: true });
  return withFileLock(path.join(jobsDir(repo), ".create.lock"), async () => {
    const id = jobIdOf(nextNumber(fs.readdirSync(jobsDir(repo))), o.title);
    const dir = jobDirOf(repo, id);
    fs.mkdirSync(dir); // fails if it exists: ids are never reused under the lock
    writeAtomic(path.join(dir, "ticket.md"), `# ${o.title}\n\n${o.body.trim()}\n`);
    const now = (o.now ?? new Date()).toISOString();
    const job: Job = {
      id,
      title: o.title,
      ticket: o.ticket,
      stage: "intake",
      round: 1,
      roundStart: 1,
      roundLimit: o.roundLimit,
      risk: null,
      surfaces: [],
      kind: null,
      base: "",
      branch: `kitchen/${id}`,
      worktree: "",
      ...(o.target ? { target: o.target } : {}),
      pr: null,
      running: null,
      agentRuns: [],
      moves: 0,
      filed: [],
      ...(o.from ? { from: o.from } : {}),
      ...(o.check ? { check: { forced: true, ...(o.schedule ? { filedBy: "schedule" as const, every: o.schedule } : {}) } } : {}),
      startedAt: now,
      updatedAt: now,
    };
    writeAtomic(jobFile(dir), `${JSON.stringify(job, null, 2)}\n`);
    return job;
  });
}

/** Read-modify-write job.json under the job's lock. `fn` gets the job as it is on disk and returns the new one. */
export async function updateJob(repo: string, id: string, fn: (j: Job) => Job | undefined | Promise<Job | undefined>): Promise<Job> {
  const dir = jobDirOf(repo, id);
  return withJobLock(dir, async () => {
    const disk = readJobAt(dir);
    const next = (await fn(structuredClone(disk))) ?? disk;
    next.id = disk.id;
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (text !== `${JSON.stringify(disk, null, 2)}\n`) writeAtomic(jobFile(dir), text);
    return next;
  });
}
