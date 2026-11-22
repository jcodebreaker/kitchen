// `kitchen toolkit check [--feature x] [--src dir]` (PLAN §2): proves a Toolkit
// end to end, every answer held to the contract (contract.ts):
//   describe → prepare (timed) → up → doctor → one drive per check line of every
//   feature → reset → the drives again → a second slot up at once (unless
//   describe says parallel:false) → down → the evidence survived.
// Drives run through the engine's own interpreter (proof/drive.ts), stamped into
// a check job under .kitchen/checks/, exactly as a Job's proofs are.
// A full pass of the base writes .kitchen/toolkit.proven with the base sha.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openGit, plainCheckout } from "../engine/git.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { runDrive, toFlags } from "../proof/drive.ts";
import { loadDrive } from "../proof/drive-format.ts";
import { createJob, evidenceDir, readJob, sealOf } from "../proof/job.ts";
import { verifyManifest } from "../proof/manifest.ts";
import { markPrepared, toolkitCheckout } from "./checkout.ts";
import {
  type Command,
  type DescribeOut,
  type Feature,
  oneJsonLine,
  PrimitiveOut,
  type Probe,
  parseFeature,
  planProbes,
  primitiveNames,
  unmatchedGlobs,
  upUrlProblem,
  validate,
} from "./contract.ts";
import { runToolkit, type ToolkitCall } from "./run.ts";
import { acquireSlot, releaseSlot, type Slot } from "./slots.ts";

export type CheckStep = { step: string; ok: boolean; secs: number; detail?: string; tail?: string };
export type CheckReport = {
  ok: boolean;
  failed?: string;
  steps: CheckStep[];
  describe?: DescribeOut;
  features: Feature[];
  /** The check job: its evidence/ holds every drive's stamped entries. */
  jobDir: string;
  entries: number;
  prepareSecs?: number;
  parallel: boolean;
  secs: number;
};

export type CheckOpts = {
  repo: string;
  /** The bin/dev that runs (primitives). */
  toolkitBin: string;
  /** The source tree: the app `up` starts, and the feature files. */
  src: string;
  /** Only the drives of this feature (a drive name, or a feature file's stem). No parallel check. */
  feature?: string;
  /** Skip `prepare` (the caller just ran it). Default: run it, timed. */
  prepare?: boolean;
  /** The light re-proof: only the first check line's drive, no reset round, no second slot. */
  smoke?: boolean;
  /** Only describe and the feature files (no app is started): for machines that can't run the stack. */
  staticOnly?: boolean;
  print?: (line: string) => void;
  timeouts?: { prepareMs?: number; upMs?: number; prepareStallMs?: number };
  /** The commit whose tracked files every feature `paths` glob must match (default: the main repo's HEAD, the base). */
  pathsRev?: string;
};

/** prepare fails when it prints nothing for this long (a hung download), long before its 30-minute deadline. */
export const PREPARE_STALL_MS = 5 * 60_000;

/** Every file tracked at `rev` of the main repo. */
export async function trackedAt(repo: string, rev: string): Promise<string[]> {
  const git = await openGit(plainCheckout(repo));
  return (await git.run(["ls-tree", "-r", "-z", "--full-tree", "--name-only", rev])).stdout.split("\0").filter(Boolean);
}

const TAIL = 1500;
/** A primitive answer that admits there is nothing behind the name. */
const NOT_IMPLEMENTED = /\b(not (yet )?implemented|unimplemented|not supported|todo)\b/i;
const tail = (c: ToolkitCall) => (c.stderr.trim() ? c.stderr.trim().slice(-TAIL) : c.stdout.trim().slice(-TAIL));

/** Engine side: the gitdir of a source tree, so drives can stamp it. A plain checkout, or a linked worktree under <repo>/.worktrees/. */
export function srcLink(repo: string, src: string): { mainRepo: string; id: string } | undefined {
  const real = fs.realpathSync(src);
  const st = fs.lstatSync(path.join(real, ".git"), { throwIfNoEntry: false });
  if (st?.isDirectory()) return undefined;
  const wts = path.join(fs.realpathSync(repo), ".worktrees");
  if (path.dirname(real) === wts) return { mainRepo: fs.realpathSync(repo), id: path.basename(real) };
  throw new Error(`--src ${src} is neither a git checkout nor a worktree under ${wts}`);
}

export async function runToolkitCheck(o: CheckOpts): Promise<CheckReport> {
  const t0 = Date.now();
  const print = o.print ?? (() => {});
  const src = fs.realpathSync(o.src);
  const steps: CheckStep[] = [];
  const held: Slot[] = [];
  const up = new Set<string>();
  const jobDir = path.join(kitchenDir(o.repo), "checks", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`);
  const report: CheckReport = { ok: false, steps, features: [], jobDir, entries: 0, parallel: false, secs: 0 };

  const step = (name: string, ok: boolean, secs: number, detail?: string, t?: string) => {
    steps.push({ step: name, ok, secs, ...(detail ? { detail } : {}), ...(t && !ok ? { tail: t } : {}) });
    print(`toolkit check: ${name} ${ok ? "ok" : "FAIL"} ${secs.toFixed(1)}s${detail ? `  ${detail}` : ""}`);
    if (!ok && t) for (const l of t.split("\n").slice(-12)) print(`    ${l}`);
    return ok;
  };
  const fail = (name: string) => {
    report.failed = name;
    return report;
  };
  /** One lifecycle command, timed and held to its schema. */
  const cmd = async <C extends Command>(c: C, argv: string[], label: string, timeoutMs?: number, want?: (v: unknown) => string | null) => {
    const t = Date.now();
    const r = await runToolkit(o.toolkitBin, [c, ...argv], {
      src,
      timeoutMs,
      ...(c === "prepare" ? { stallMs: o.timeouts?.prepareStallMs ?? PREPARE_STALL_MS } : {}),
    });
    const line = oneJsonLine(r.stdout);
    const v = validate(c, line.ok ? line.json : null);
    const why = r.timedOut
      ? (r.stderr.trim().split("\n").pop() ?? "timed out")
      : !line.ok
        ? `${c} ${line.why}`
        : !v.ok
          ? v.why
          : r.exit !== 0
            ? `exit ${r.exit}: ${JSON.stringify(r.json)}`
            : (want?.(v.value) ?? null);
    const secs = (Date.now() - t) / 1000;
    step(label, !why, secs, why ?? undefined, why ? tail(r) : undefined);
    return { ok: !why, value: v.ok ? v.value : null, secs };
  };
  const slot = async (tag: string): Promise<Slot> => {
    const id = `chk-${randomBytes(3).toString("hex")}-${tag}`;
    const { slot } = await acquireSlot({ id, toolkitBin: o.toolkitBin, src });
    held.push(slot);
    return slot;
  };
  /** The probe calls, each held to the contract; returns every problem, named. */
  const probe = async (probes: Probe[], s: Slot, dir: string): Promise<string[]> => {
    const bad: string[] = [];
    let n = 0;
    for (const p of probes) {
      const out = path.join(dir, `p${++n}`);
      fs.mkdirSync(out, { recursive: true });
      const argv = [p.primitive, `--id=${s.id}`, `--src=${src}`, `--out=${out}`, ...toFlags(p.args), ...(p.dupFlag ? [`--id=${s.id}`] : [])];
      const r = await runToolkit(o.toolkitBin, argv, { src, timeoutMs: 120_000 });
      const label = `${p.primitive} ${JSON.stringify(p.args)}${p.dupFlag ? " with --id twice" : ""}`;
      if (r.timedOut) {
        bad.push(`${label}: timed out`);
        continue;
      }
      const line = oneJsonLine(r.stdout);
      if (p.expect === "refuse") {
        const said = line.ok ? (line.json as { ok?: unknown }).ok : undefined;
        if (r.exit === 0 && said === true) bad.push(`${p.why}, but ${label} answered ok:true`);
        else if (!line.ok) bad.push(`${label}: ${line.why}`);
        continue;
      }
      if (!line.ok) {
        bad.push(`${label}: ${line.why}`);
        continue;
      }
      const shape = PrimitiveOut.safeParse(line.json);
      if (!shape.success) {
        bad.push(`${label}: not a primitive answer {ok,out,files} (${JSON.stringify(line.json).slice(0, 160)}): is ${p.primitive} implemented?`);
        continue;
      }
      const stray = shape.data.files.filter((f) => !path.resolve(out, f).startsWith(out + path.sep));
      if (stray.length) bad.push(`${label}: files outside --out: ${stray.join(", ")}`);
      if (shape.data.ok === true && r.exit !== 0) bad.push(`${label}: ok:true but exit ${r.exit}`);
      const got = JSON.stringify(shape.data.out).slice(0, 160);
      if (p.expect === "ok" && shape.data.ok !== true)
        bad.push(
          p.uncovered === "none"
            ? `${label}: ${p.why}; got ok:false ${got} (implement it, call it from a feature drive, or declare its args in describe)`
            : `${label}: must answer ok:true, got ${got}`,
        );
      else if (p.uncovered === "placeholder" && shape.data.ok !== true && NOT_IMPLEMENTED.test(got))
        bad.push(`${label}: ${p.primitive} is listed in describe but answered ${got}: is it implemented?`);
    }
    return bad;
  };
  const downSlot = async (s: Slot, label: string) => {
    up.delete(s.id);
    return cmd("down", [`--id=${s.id}`], label, 120_000, (v) => ((v as { status: string }).status === "ok" ? null : JSON.stringify(v)));
  };

  try {
    // 1. describe, from --src (so a job branch's new feature files show)
    const d = await cmd("describe", [`--src=${src}`], "describe", 60_000);
    if (!d.ok || !d.value) return fail("describe");
    const desc = d.value as DescribeOut;
    report.describe = desc;
    const prims = primitiveNames(desc);

    // feature files: listed by describe, present in --src, parseable, every drive's primitives known, at least one check each
    const t = Date.now();
    const fdir = path.join(src, ".kitchen", "toolkit");
    const onDisk = fs.existsSync(path.join(fdir, "features"))
      ? fs
          .readdirSync(path.join(fdir, "features"))
          .filter((f) => f.endsWith(".md") && f !== "README.md")
          .map((f) => `features/${f}`)
          .sort()
      : [];
    const problems: string[] = [];
    const unlisted = onDisk.filter((f) => !desc.features.includes(f));
    if (unlisted.length) problems.push(`describe doesn't list ${unlisted.join(", ")} (it must be generated from the files)`);
    if (!desc.features.length) problems.push("no feature files: map the top 3–5 features");
    for (const f of desc.features) {
      const file = path.join(fdir, f);
      if (!fs.existsSync(file)) {
        problems.push(`${f} is listed but missing`);
        continue;
      }
      try {
        const feat = parseFeature(f, fs.readFileSync(file, "utf8"));
        if (!feat.drives.length) problems.push(`${f} has no drive block`);
        if (!feat.checks.length) problems.push(`${f}: no check line (check: { drive: …, args: {…} })`);
        report.features.push(feat);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    for (const f of report.features)
      for (const d of f.drives)
        for (const p of d.primitives) if (!prims.includes(p)) problems.push(`${f.file}: drive ${d.name} uses ${p}, which describe doesn't list`);
    if (report.features.length) {
      let files: string[] | null = null;
      try {
        files = await trackedAt(o.repo, o.pathsRev ?? "HEAD");
      } catch (e) {
        problems.push(`can't list the base's files: ${(e as Error).message}`);
      }
      if (files)
        for (const f of report.features) {
          const bad = unmatchedGlobs(f.paths, files);
          if (bad.length) problems.push(`${f.file}: paths ${bad.map((b) => JSON.stringify(b)).join(", ")} match no tracked file at the base (a typo?)`);
        }
    }
    let checks = report.features.flatMap((f) => f.checks.map((c) => ({ ...c, file: path.join(fdir, f.file) })));
    if (o.smoke) checks = checks.slice(0, 1);
    if (o.feature) {
      checks = checks.filter((c) => c.drive === o.feature || path.basename(c.file, ".md") === o.feature);
      if (!checks.length) problems.push(`no drive or feature named ${o.feature}`);
    }
    if (
      !step(
        "features",
        !problems.length,
        (Date.now() - t) / 1000,
        problems.length ? problems.join("; ") : `${report.features.length} files, ${checks.length} drives`,
      )
    )
      return fail("features");

    if (o.staticOnly) {
      report.ok = true;
      return report;
    }
    // 2. prepare (timed)
    if (o.prepare !== false) {
      const p = await cmd("prepare", [`--src=${src}`], "prepare", o.timeouts?.prepareMs ?? 30 * 60_000);
      if (!p.ok) return fail("prepare");
      report.prepareSecs = p.secs;
    }

    // 3. up, doctor
    const ready = (v: unknown) => {
      const u = v as { status: string; url?: string; why?: string };
      if (u.status !== "ready") return `up: ${u.why ?? JSON.stringify(v)}`;
      const bad = upUrlProblem(desc.surface, u.url ?? "");
      return bad ? `up: ${bad}` : null;
    };
    const okStatus = (v: unknown) => ((v as { status: string }).status === "ok" ? null : JSON.stringify(v).slice(0, 600));
    const a = await slot("a");
    const upA = await cmd("up", [`--id=${a.id}`, `--src=${src}`, `--ports=${a.ports.join(",")}`], `up ${a.id}`, o.timeouts?.upMs ?? 10 * 60_000, ready);
    up.add(a.id);
    if (!upA.ok) return fail("up");
    if (!(await cmd("doctor", [`--id=${a.id}`], `doctor ${a.id}`, 120_000, okStatus)).ok) return fail("doctor");

    // 4. the drives, stamped into the check job
    createJob(jobDir, { id: path.basename(jobDir), worktree: src, toolkitBin: o.toolkitBin, slotId: a.id, round: 1 }, srcLink(o.repo, src));
    const drive = async (c: (typeof checks)[number], label: string) => {
      const t = Date.now();
      try {
        const r = await runDrive({ jobDir, request: { feature: c.drive, file: c.file, args: c.args }, criterion: `check:${c.drive}`, role: "engine" });
        const at = r.failedAt;
        const why = r.gap
          ? `primitive ${r.gap} is missing`
          : at
            ? `step ${at.step} (line ${at.line}) failed: ${JSON.stringify(at.out).slice(0, 400)}`
            : undefined;
        let t2: string | undefined;
        if (at?.evidence[0]) {
          try {
            const call = JSON.parse(fs.readFileSync(path.join(evidenceDir(jobDir), at.evidence[0], "call.json"), "utf8")) as {
              stderr?: string;
              last?: { stderr?: string };
            };
            t2 = (call.stderr ?? call.last?.stderr ?? "").slice(-TAIL);
          } catch {}
        }
        const ids = r.steps.flatMap((s) => s.evidence);
        return step(label, r.ok, (Date.now() - t) / 1000, why ?? `${r.steps.length} steps, ${ids[0]}–${ids.at(-1)}`, t2);
      } catch (e) {
        return step(label, false, (Date.now() - t) / 1000, (e as Error).message);
      }
    };
    for (const c of checks) if (!(await drive(c, `drive ${c.drive}`))) return fail(`drive ${c.drive}`);

    // 5. reset, then the drives again (a drive that changes data passes twice only if reset restores the seed)
    if (!o.smoke && !(await cmd("reset", [`--id=${a.id}`], `reset ${a.id}`, 120_000, okStatus)).ok) return fail("reset");
    if (!o.smoke) for (const c of checks) if (!(await drive(c, `drive ${c.drive} after reset`))) return fail(`drive ${c.drive} after reset`);

    // 6. the contract probe: every primitive once, then the calls the contract says must be refused
    if (!o.smoke && !o.feature) {
      const t4 = Date.now();
      const drives = report.features.flatMap((f) =>
        f.checks.map((c) => ({ drive: loadDrive(fs.readFileSync(path.join(fdir, f.file), "utf8"), c.drive), args: c.args })),
      );
      const bad = await probe(planProbes(desc, drives), a, path.join(jobDir, "probe"));
      if (!step("contract probe", !bad.length, (Date.now() - t4) / 1000, bad.length ? bad.join("; ") : `${prims.length} primitives, refusals hold`))
        return fail("contract probe");
    }

    // 7. two slots at once, unless the Toolkit says it can't
    if (!o.feature && !o.smoke) {
      if (desc.parallel) {
        const b = await slot("b");
        const upB = await cmd(
          "up",
          [`--id=${b.id}`, `--src=${src}`, `--ports=${b.ports.join(",")}`],
          `up ${b.id} (second slot)`,
          o.timeouts?.upMs ?? 10 * 60_000,
          ready,
        );
        up.add(b.id);
        if (!upB.ok) return fail("parallel up");
        if (!(await cmd("doctor", [`--id=${b.id}`], `doctor ${b.id}`, 120_000, okStatus)).ok) return fail("parallel doctor");
        if (!(await cmd("doctor", [`--id=${a.id}`], `doctor ${a.id} with ${b.id} up`, 120_000, okStatus)).ok) return fail("parallel doctor");
        if (!(await downSlot(b, `down ${b.id}`)).ok) return fail("down");
        report.parallel = true;
      } else step("parallel", true, 0, "describe says parallel:false: this project runs one job at a time (concurrency 1)");
    }

    // 8. down
    if (!(await downSlot(a, `down ${a.id}`)).ok) return fail("down");

    // 9. the evidence survived the teardown: every entry and every file it cites, against the signed head
    const t3 = Date.now();
    try {
      const job = readJob(jobDir);
      const entries = verifyManifest(evidenceDir(jobDir), job.manifestHead, sealOf(job));
      report.entries = entries.length;
      if (!step("evidence", entries.length > 0, (Date.now() - t3) / 1000, `${entries.length} entries in ${path.relative(o.repo, evidenceDir(jobDir))}`))
        return fail("evidence");
    } catch (e) {
      step("evidence", false, (Date.now() - t3) / 1000, (e as Error).message);
      return fail("evidence");
    }
    report.ok = true;
    return report;
  } finally {
    for (const s of held) {
      if (up.has(s.id)) await runToolkit(o.toolkitBin, ["down", `--id=${s.id}`], { src, timeoutMs: 120_000 }).catch(() => {});
      await releaseSlot(s.id);
    }
    report.secs = (Date.now() - t0) / 1000;
    print(`toolkit check: ${report.ok ? "PASS" : `FAIL at ${report.failed}`} in ${report.secs.toFixed(1)}s`);
  }
}

// ---------- .kitchen/toolkit.proven ----------

export type Proven = {
  /** The base sha the Toolkit was proven on. */
  sha: string;
  at: string;
  /** Branch the sha was on when it isn't the base yet (init proves the setup branch). */
  branch?: string;
  parallel: boolean;
  features: { file: string; paths: string[] }[];
  prepareSecs?: number;
  secs: number;
};

/** Pure: how many jobs may run at once. A Toolkit proven parallel:false runs one, whatever kitchen.yaml says. */
export const effectiveConcurrency = (configured: number, proven: Pick<Proven, "parallel"> | null) => (proven && !proven.parallel ? 1 : configured);

export const provenFile = (repo: string) => path.join(kitchenDir(repo), "toolkit.proven");

export function readProven(repo: string): Proven | null {
  try {
    return JSON.parse(fs.readFileSync(provenFile(repo), "utf8")) as Proven;
  } catch {
    return null;
  }
}

/**
 * The full check of a ref of the main repo, run the way jobs run it: primitives
 * from the engine-owned checkout at that sha; the source is that same clean
 * checkout unless `src` is given (a job worktree, whose new feature files show).
 * A full pass on the checkout writes toolkit.proven.
 */
export async function checkAtRef(
  repo: string,
  o: { rev?: string; src?: string; feature?: string; branch?: string; print?: (l: string) => void },
): Promise<CheckReport & { sha: string }> {
  repo = plainCheckout(repo).workTree;
  const co = await toolkitCheckout(repo, o.rev ?? "HEAD");
  o.print?.(`toolkit check: Toolkit ${co.sha.slice(0, 12)} (${path.relative(repo, co.dir)}), source ${o.src ? path.resolve(o.src) : "the same checkout"}`);
  if (!co.merged)
    o.print?.(
      `toolkit check: ${co.sha.slice(0, 12)} is not merged into the base: bin/dev runs ${
        co.sandboxed ? "under sandbox-exec (ADR 0008)" : "UNSANDBOXED: no OS sandbox on this platform (ADR 0008)"
      }`,
    );
  const src = o.src ?? co.dir;
  let r: CheckReport;
  try {
    r = await runToolkitCheck({ repo, toolkitBin: co.bin, src, feature: o.feature, print: o.print, pathsRev: co.sha });
  } finally {
    co.release();
  }
  if (r.prepareSecs !== undefined && r.steps.some((s) => s.step === "prepare" && s.ok)) markPrepared(repo, co.sha, src, r.prepareSecs);
  if (r.ok && !o.src && !o.feature) {
    const proven: Proven = {
      sha: co.sha,
      at: new Date().toISOString(),
      ...(o.branch ? { branch: o.branch } : {}),
      parallel: r.parallel || r.describe?.parallel === true,
      features: r.features.map((f) => ({ file: f.file, paths: f.paths })),
      prepareSecs: r.prepareSecs,
      secs: r.secs,
    };
    writeAtomic(provenFile(repo), `${JSON.stringify(proven, null, 2)}\n`);
    o.print?.(`toolkit check: proven ${co.sha.slice(0, 12)} → ${path.relative(repo, provenFile(repo))}`);
  }
  return { ...r, sha: co.sha };
}
