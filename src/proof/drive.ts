// Engine-side interpreter for feature drives (PLAN §2, ADR 0005). It reads a
// ```drive block, checks every step against the Toolkit's `describe`, then
// calls one primitive per step through `bin/dev`. Every call — including each
// poll of a wait and each retry — is written as evidence and stamped in the
// manifest. The Toolkit never sees the drive; it only answers primitive calls.
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { type Drive, type PrimStep, type Step, type Value, type WaitStep, loadDrive, substitute } from "./drive-format.ts";
import { type Entry, appendEntry, verifyManifest } from "./manifest.ts";

export type DriveOpts = {
  featureFile: string;
  driveName?: string;
  id: string;
  src: string;
  evidence: string;
  toolkitBin: string;
  args: Record<string, string>;
  sha: string;
  round: number;
  criterion: string;
  log?: (msg: string) => void;
};

export type StepResult = { line: number; step: string; ok: boolean; out: unknown; evidence: string[] };
export type DriveResult = {
  ok: boolean;
  drive: string;
  gap?: string; // set when the drive names a primitive the Toolkit lacks (a TOOLKIT-GAP)
  failedAt?: StepResult;
  vars: Record<string, string>;
  steps: StepResult[];
  secs: number;
};

type Call = { exit: number; json: { ok?: boolean; out?: unknown; files?: string[] } | null; stdout: string; stderr: string; argv: string[] };

const WAIT_POLL_MS = 250;

/** CLI flags for a primitive call: {target: "x", attr: "y"} → --target x --attr y. */
export function toFlags(args: Record<string, Value>): string[] {
  return Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "object" ? JSON.stringify(v) : String(v)]);
}

const shellQuote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

export async function describeToolkit(toolkitBin: string, src: string): Promise<{ primitives: string[]; raw: unknown }> {
  const r = await execa(toolkitBin, ["describe", "--src", src], { reject: false });
  const json = JSON.parse(r.stdout.trim().split("\n").pop() || "null");
  if (!json || !Array.isArray(json.primitives)) throw new Error(`describe gave no primitives: ${r.stdout.slice(0, 200)}`);
  return { primitives: json.primitives.map((p: { name: string } | string) => (typeof p === "string" ? p : p.name)), raw: json };
}

export async function runDrive(o: DriveOpts): Promise<DriveResult> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const drive: Drive = loadDrive(fs.readFileSync(o.featureFile, "utf8"), o.driveName);
  const files = path.join(o.evidence, "files");
  fs.mkdirSync(files, { recursive: true });

  const vars: Record<string, string> = {};
  for (const a of drive.args) {
    if (!(a in o.args)) throw new Error(`drive ${drive.name} needs arg ${a} (pass --arg ${a}=…)`);
    vars[a] = o.args[a];
  }
  const results: StepResult[] = [];
  const done = (ok: boolean, extra: Partial<DriveResult> = {}): DriveResult => ({
    ok,
    drive: drive.name,
    vars,
    steps: results,
    secs: (Date.now() - t0) / 1000,
    ...extra,
  });

  // A step naming a primitive the Toolkit doesn't have is a Toolkit gap, decided before anything runs.
  const { primitives } = await describeToolkit(o.toolkitBin, o.src);
  const missing = drive.steps.find((s): s is PrimStep => s.kind === "prim" && !primitives.includes(s.name));
  if (missing) return done(false, { gap: missing.name });

  // Each call gets its own --out folder named after the evidence id it will be
  // stamped with, so a later screenshot of the same name never overwrites an earlier one.
  // (One writer per evidence folder: the engine holds the job lock.)
  const call = async (name: string, args: Record<string, Value>): Promise<Call> => {
    const out = path.join(files, `e${verifyManifest(o.evidence).length + 1}`);
    const argv = [name, "--id", o.id, "--src", o.src, "--out", out, ...toFlags(args)];
    const r = await execa(o.toolkitBin, argv, { reject: false, timeout: 120_000 });
    let json: Call["json"] = null;
    try {
      json = JSON.parse(r.stdout.trim().split("\n").pop() || "");
    } catch {}
    return { exit: r.exitCode ?? 1, json, stdout: r.stdout, stderr: r.stderr, argv };
  };

  // Write one evidence file + one manifest line for a primitive call.
  const stamp = (step: Step, label: string, c: Call, extra: Record<string, unknown> = {}): Entry => {
    const cmd = `bin/dev ${c.argv.map(shellQuote).join(" ")}`;
    const copied = (c.json?.files ?? []).map((f) => {
      const abs = path.resolve(f);
      const inside = abs.startsWith(path.resolve(o.evidence) + path.sep);
      const dest = inside ? abs : path.join(files, path.basename(abs));
      if (!inside) fs.copyFileSync(abs, dest);
      return path.relative(o.evidence, dest);
    });
    const ok = c.exit === 0 && c.json?.ok === true;
    const entry = appendEntry(o.evidence, {
      sha: o.sha,
      round: o.round,
      criterion: o.criterion,
      cmd,
      exit: c.exit,
      drive: drive.name,
      step: label,
      line: step.line,
      ok,
      files: copied,
      ...extra,
    });
    fs.writeFileSync(
      path.join(o.evidence, `${entry.id}.json`),
      JSON.stringify({ ...entry, result: c.json, stdout: c.stdout, stderr: c.stderr.slice(-4000) }, null, 2),
    );
    return entry;
  };

  const runPrim = async (s: PrimStep, attempt: number): Promise<StepResult> => {
    const args = substitute(s.args, vars);
    const c = await call(s.name, args);
    const label = attempt ? `${s.name} (retry ${attempt})` : s.name;
    const e = stamp(s, label, c, attempt ? { attempt } : {});
    const ok = c.exit === 0 && c.json?.ok === true;
    log(`${e.id} ${ok ? "ok  " : "FAIL"} ${label} ${JSON.stringify(args)} → ${JSON.stringify(c.json?.out ?? c.stderr.slice(-200))}`);
    return { line: s.line, step: label, ok, out: c.json?.out, evidence: [e.id] };
  };

  // wait = poll the generic `read` primitive until the text shows up. Every poll is stamped.
  const runWait = async (s: WaitStep, attempt: number): Promise<StepResult> => {
    const text = substitute(s.text, vars);
    const readArgs: Record<string, Value> = substitute({ target: s.target, ...(s.attr ? { attr: s.attr } : {}) }, vars);
    const end = Date.now() + s.timeoutMs;
    const ids: string[] = [];
    let last: unknown;
    for (let poll = 1; ; poll++) {
      const c = await call("read", readArgs);
      last = c.json?.out;
      const hit = c.json?.ok === true && typeof last === "string" && last.includes(text);
      const e = stamp(s, `wait for ${JSON.stringify(text)} (poll ${poll}${attempt ? `, retry ${attempt}` : ""})`, c, {
        ok: hit, // a poll that didn't find the text is not a passing step, even though `read` worked
        wait: { text, timeoutMs: s.timeoutMs, poll, hit },
      });
      ids.push(e.id);
      if (hit || Date.now() >= end) {
        log(`${e.id} ${hit ? "ok  " : "FAIL"} wait ${JSON.stringify(text)} in ${s.target}${s.attr ? `@${s.attr}` : ""} after ${poll} poll(s)`);
        return { line: s.line, step: `wait ${JSON.stringify(text)}`, ok: hit, out: last, evidence: ids };
      }
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
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
