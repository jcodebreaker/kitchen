// Engine-side interpreter for feature drives (PLAN §2, ADR 0005). It reads a
// ```drive block (or takes one primitive call), checks every step against the
// Toolkit's `describe`, then calls one primitive per step through `bin/dev`.
// Every call is stamped in the manifest with its own evidence folder e<N>/;
// a wait is one entry with its poll count, a TOOLKIT-GAP is an entry too.
// The Toolkit never sees the drive; it only answers primitive calls.
//
// One drive at a time per job (withJobLock): the next id comes from the head
// in job.json, read and written under that lock.
import fs from "node:fs";
import path from "node:path";
import { runToolkit, type ToolkitCall } from "../toolkit/run.ts";
import {
  checkPrimArgs,
  type Drive,
  DriveFormatError,
  extractDriveBlocks,
  loadDrive,
  type PrimStep,
  parseDrive,
  type Step,
  substitute,
  type Value,
  type WaitStep,
} from "./drive-format.ts";
import { evidenceDir, jobGit, type ProofJob, readJob, sealOf, storeHead, withJobLock } from "./job.ts";
import { appendEntry, type Entry, type ManifestHead, nextId, verifyManifest } from "./manifest.ts";
import { type SourceStamp, sourceStamp } from "./source-stamp.ts";

export type DriveRequest =
  | { feature: string; file?: string; args?: Record<string, string> } // a feature drive by name (or a file + optional name)
  | { primitive: string; args?: Record<string, Value> }; // one primitive call

export type DriveOpts = {
  jobDir: string;
  request: DriveRequest;
  criterion: string;
  /** Who asked: engine, builder, verifier… Stamped, so a Verdict can tell self-checks from proofs. */
  role: string;
  log?: (msg: string) => void;
};

export type StepResult = { line: number; step: string; ok: boolean; out: unknown; evidence: string[]; why?: string };
export type DriveResult = {
  ok: boolean;
  drive: string;
  gap?: string; // the drive names a primitive the Toolkit lacks (a TOOLKIT-GAP)
  failedAt?: StepResult;
  vars: Record<string, string>;
  steps: StepResult[];
  source: SourceStamp;
  manifestHead: ManifestHead;
  secs: number;
};

const WAIT_POLL_MS = 250;

/** CLI flags for a primitive call: {target: "x", attr: "y"} → --target=x --attr=y (one argv item each). */
export function toFlags(args: Record<string, Value>): string[] {
  return Object.entries(args).map(([k, v]) => `--${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
}

const shellQuote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

export async function describeToolkit(toolkitBin: string, src: string): Promise<{ primitives: string[]; raw: Record<string, unknown> }> {
  const r = await runToolkit(toolkitBin, ["describe", `--src=${src}`], { src });
  const json = r.json as { primitives?: ({ name: string } | string)[] } | null;
  if (!json || !Array.isArray(json.primitives)) throw new Error(`describe gave no primitives: ${r.stdout.slice(0, 200)} ${r.stderr.slice(-200)}`);
  return { primitives: json.primitives.map((p) => (typeof p === "string" ? p : p.name)), raw: json as Record<string, unknown> };
}

/** The feature file in the worktree that holds drive `name`. */
export function findFeature(worktree: string, name: string): string {
  const dir = path.join(worktree, ".kitchen/toolkit/features");
  for (const f of fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((x) => x.endsWith(".md"))
        .sort()
    : []) {
    const file = path.join(dir, f);
    const blocks = extractDriveBlocks(fs.readFileSync(file, "utf8"));
    if (blocks.some((b) => parseDrive(b.body, b.line).name === name)) return file;
  }
  throw new DriveFormatError(`no feature drive named ${name} in ${dir}`);
}

function buildDrive(job: ProofJob, req: DriveRequest): { drive: Drive; args: Record<string, string> } {
  if ("primitive" in req) {
    const args = req.args ?? {};
    checkPrimArgs(req.primitive, args);
    const step: PrimStep = { kind: "prim", name: req.primitive, args, line: 0 };
    return { drive: { name: `primitive:${req.primitive}`, args: [], steps: [step] }, args: {} };
  }
  const file = req.file ?? findFeature(job.worktree, req.feature);
  return { drive: loadDrive(fs.readFileSync(file, "utf8"), req.feature || undefined), args: req.args ?? {} };
}

export function runDrive(o: DriveOpts): Promise<DriveResult> {
  return withJobLock(o.jobDir, () => runLocked(o));
}

async function runLocked(o: DriveOpts): Promise<DriveResult> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const job = readJob(o.jobDir);
  const seal = sealOf(job);
  const ev = evidenceDir(o.jobDir);
  verifyManifest(ev, job.manifestHead, seal); // refuse before running anything on a tampered record
  const source = await sourceStamp(jobGit(job));
  const { drive, args } = buildDrive(job, o.request);

  const vars: Record<string, string> = {};
  for (const a of drive.args) {
    if (!(a in args)) throw new DriveFormatError(`drive ${drive.name} needs arg ${a}`);
    vars[a] = args[a];
  }
  const results: StepResult[] = [];
  const done = (ok: boolean, extra: Partial<DriveResult> = {}): DriveResult => ({
    ok,
    drive: drive.name,
    vars,
    steps: results,
    source,
    manifestHead: job.manifestHead,
    secs: (Date.now() - t0) / 1000,
    ...extra,
  });

  /** Write e<N>/call.json, append the entry citing it and every file in e<N>/, then store the new head. */
  const stamp = (step: Pick<Step, "line">, label: string, fields: Record<string, unknown>, record: unknown): Entry => {
    const dir = path.join(ev, nextId(job.manifestHead));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "call.json"), JSON.stringify(record, null, 2));
    const files = fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(ev, path.join(d.parentPath, d.name)))
      .sort();
    const r = appendEntry(
      ev,
      job.manifestHead,
      {
        sha: source.sha,
        dirty: source.dirty,
        tree: source.tree,
        round: job.round,
        criterion: o.criterion,
        role: o.role,
        drive: drive.name,
        step: label,
        line: step.line,
        files,
        ...fields,
      } as never,
      seal,
    );
    job.manifestHead = r.head;
    storeHead(o.jobDir, job);
    return r.entry;
  };

  /** The folder of the entry about to be stamped, emptied (a crashed run may have left files in it). */
  const openEntry = (): string => {
    const dir = path.join(ev, nextId(job.manifestHead));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  // A step naming a primitive the Toolkit doesn't have is a Toolkit gap, decided before anything runs, and stamped.
  const { primitives } = await describeToolkit(job.toolkitBin, job.worktree);
  const missing = drive.steps.find((s): s is PrimStep => s.kind === "prim" && !primitives.includes(s.name));
  if (missing) {
    openEntry();
    const e = stamp(
      missing,
      `TOOLKIT-GAP ${missing.name}`,
      { cmd: `bin/dev describe --src=${job.worktree}`, exit: 0, ok: false, gap: missing.name },
      { gap: missing.name, primitives },
    );
    log(`${e.id} GAP  ${missing.name} is not a primitive of this Toolkit`);
    return done(false, { gap: missing.name, failedAt: { line: missing.line, step: missing.name, ok: false, out: null, evidence: [e.id], why: "toolkit gap" } });
  }
  // One primitive call, writing its files into the open entry folder.
  const call = (name: string, args: Record<string, Value>, out: string): Promise<ToolkitCall> => {
    const argv = [name, `--id=${job.slotId}`, `--src=${job.worktree}`, `--out=${out}`, ...toFlags(args)];
    return runToolkit(job.toolkitBin, argv, { src: job.worktree });
  };
  const cmdOf = (c: ToolkitCall) => `bin/dev ${c.argv.map(shellQuote).join(" ")}`;
  /** Files a call reports must be inside its own --out folder; anything else fails the step and is never copied. */
  const strayFiles = (c: ToolkitCall, own: string): string[] => {
    const files = (c.json?.files as string[] | undefined) ?? [];
    return files.filter((f) => !path.resolve(own, f).startsWith(own + path.sep));
  };
  const record = (c: ToolkitCall) => ({ argv: c.argv, exit: c.exit, result: c.json, stdout: c.stdout.slice(-4000), stderr: c.stderr.slice(-4000) });

  const runPrim = async (s: PrimStep, attempt: number): Promise<StepResult> => {
    const args = substitute(s.args, vars);
    const label = attempt ? `${s.name} (retry ${attempt})` : s.name;
    const out = openEntry();
    const c = await call(s.name, args, out);
    const stray = strayFiles(c, out);
    const ok = c.exit === 0 && c.json?.ok === true && stray.length === 0;
    const why = stray.length ? `files outside --out: ${stray.join(", ")}` : undefined;
    const e = stamp(s, label, { cmd: cmdOf(c), exit: c.exit, ok, ...(attempt ? { attempt } : {}), ...(why ? { why } : {}) }, record(c));
    log(`${e.id} ${ok ? "ok  " : "FAIL"} ${label} ${JSON.stringify(args)} → ${JSON.stringify(c.json?.out ?? c.stderr.slice(-200))}`);
    return { line: s.line, step: label, ok, out: c.json?.out, evidence: [e.id], ...(why ? { why } : {}) };
  };

  // wait = poll the generic `read` primitive until the text shows up. One entry per wait, with its polls.
  const runWait = async (s: WaitStep, attempt: number): Promise<StepResult> => {
    const text = substitute(s.text, vars);
    const label = `wait ${JSON.stringify(text)}${attempt ? ` (retry ${attempt})` : ""}`;
    const out = openEntry();
    if (text === "") {
      const e = stamp(s, label, { cmd: "wait", exit: 1, ok: false, why: "wait text is empty after substitution" }, { text, template: s.text });
      log(`${e.id} FAIL ${label}: empty text`);
      return { line: s.line, step: label, ok: false, out: null, evidence: [e.id], why: "empty wait text" };
    }
    const readArgs: Record<string, Value> = substitute({ target: s.target, ...(s.attr ? { attr: s.attr } : {}) }, vars);
    const end = Date.now() + s.timeoutMs;
    const polls: unknown[] = [];
    let last: ToolkitCall;
    let hit = false;
    for (;;) {
      last = await call("read", readArgs, out);
      const got = last.json?.out;
      hit = last.exit === 0 && last.json?.ok === true && typeof got === "string" && got.includes(text);
      polls.push({ at: new Date().toISOString(), exit: last.exit, ok: last.json?.ok ?? null, out: got });
      if (hit || Date.now() >= end) break;
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
    const e = stamp(
      s,
      label,
      { cmd: cmdOf(last), exit: last.exit, ok: hit, wait: { text, timeoutMs: s.timeoutMs, polls: polls.length, hit }, ...(attempt ? { attempt } : {}) },
      { wait: { text, target: s.target, attr: s.attr, timeoutMs: s.timeoutMs }, polls, last: record(last) },
    );
    log(`${e.id} ${hit ? "ok  " : "FAIL"} ${label} in ${s.target}${s.attr ? `@${s.attr}` : ""} after ${polls.length} poll(s)`);
    return { line: s.line, step: label, ok: hit, out: last.json?.out, evidence: [e.id] };
  };

  const runOne = (s: PrimStep | WaitStep, attempt: number) => (s.kind === "prim" ? runPrim(s, attempt) : runWait(s, attempt));

  for (let i = 0; i < drive.steps.length; i++) {
    const s = drive.steps[i];
    if (s.kind === "retry") continue; // consumed by the step before it
    let r = await runOne(s, 0);
    results.push(r);
    const next = drive.steps[i + 1];
    if (!r.ok && next?.kind === "retry") {
      for (let a = 1; a <= next.times && !r.ok; a++) {
        r = await runOne(s, a);
        results.push(r);
      }
    }
    if (!r.ok) return done(false, { failedAt: r });
    if (s.kind === "prim" && s.save) vars[s.save] = typeof r.out === "string" ? r.out : JSON.stringify(r.out);
  }
  return done(true);
}
