// What the stages ask the Toolkit (through src/toolkit/run.ts, untrusted env).
// No Toolkit: no primitives, no drives, doctor not ok.
// bin/dev is the engine-owned checkout at the job's toolkitRef (job.toolkitBin,
// src/engine/job-toolkit.ts); feature files come from `--src`.
import fs from "node:fs";
import path from "node:path";
import type { ToolkitView } from "../../checks/spec-lint.ts";
import { describeToolkit } from "../../proof/drive.ts";
import { extractDriveBlocks, parseDrive } from "../../proof/drive-format.ts";
import { toolkitRootOfBin } from "../../toolkit/sandbox.ts";
import { doctorOk as instanceDoctor } from "../instance.ts";
import type { Job } from "../machine.ts";

export const hasToolkit = (job: Job) => !!job.toolkitBin && fs.existsSync(job.toolkitBin);
export const FEATURES_DIR = ".kitchen/toolkit/features";
/** The checkout the job's bin/dev comes from: its own feature files back a worktree that lacks them (ADR 0015). */
export const toolkitDirOf = (job: Pick<Job, "toolkitBin">): string | null => toolkitRootOfBin(job.toolkitBin);

export async function primitives(job: Job, src = job.worktree || process.cwd()): Promise<{ list: string[]; sha: string; seedUsers: string[] }> {
  if (!hasToolkit(job)) return { list: [], sha: "", seedUsers: [] };
  const d = await describeToolkit(job.toolkitBin, src);
  return { list: d.primitives, sha: job.toolkitRef, seedUsers: seedUsersOf(d.raw) };
}

/** describe's `seed_users` (the Toolkit contract's name; `seedUsers` read too). */
export function seedUsersOf(raw: Record<string, unknown>): string[] {
  const v = raw.seed_users ?? raw.seedUsers;
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * Every feature drive in `<src>/.kitchen/toolkit/features/*.md`: name → args, and the
 * file it is in. A file that doesn't parse is reported in `broken`, its drives left out.
 * `toolkitDir`: the job's Toolkit checkout, whose feature files count under the same names
 * when `src` has none of its own by that name (an approved Toolkit not in the worktree, ADR 0015).
 */
export function featureDrives(
  src: string,
  toolkitDir?: string | null,
): {
  drives: Record<string, string[]>;
  files: Record<string, string>;
  broken: Record<string, string>;
  /** Drives with a `screenshot` step. */
  screenshots: string[];
} {
  const drives: Record<string, string[]> = {};
  const files: Record<string, string> = {};
  const broken: Record<string, string> = {};
  const screenshots: string[] = [];
  // file name → its folder: the worktree's own win over the Toolkit checkout's.
  const found = new Map<string, string>();
  for (const root of [...(toolkitDir && toolkitDir !== src ? [toolkitDir] : []), src]) {
    const dir = path.join(root, FEATURES_DIR);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) found.set(f, dir);
  }
  for (const f of [...found.keys()].sort()) {
    const dir = found.get(f) as string;
    const rel = `${FEATURES_DIR}/${f}`;
    try {
      for (const b of extractDriveBlocks(fs.readFileSync(path.join(dir, f), "utf8"))) {
        const d = parseDrive(b.body, b.line);
        drives[d.name] = d.args;
        files[d.name] = rel;
        if (d.steps.some((s) => s.kind === "prim" && s.name === "screenshot")) screenshots.push(d.name);
      }
    } catch (e) {
      broken[rel] = (e as Error).message;
    }
  }
  return { drives, files, broken, screenshots };
}

/** describe's primitives and feature files (`features/<x>.md`), read with `--src` (a job branch's new files show). */
export async function described(job: Job, src = job.worktree || process.cwd()): Promise<{ primitives: string[]; features: string[] }> {
  if (!hasToolkit(job)) return { primitives: [], features: [] };
  const d = await describeToolkit(job.toolkitBin, src);
  return { primitives: d.primitives, features: Array.isArray(d.raw.features) ? (d.raw.features as unknown[]).map(String) : [] };
}

/** What spec-lint checks a contract against: describe's primitives and the feature drives in `src`. */
export async function toolkitView(job: Job, src: string): Promise<ToolkitView> {
  const f = featureDrives(src, toolkitDirOf(job));
  const p = await primitives(job, src);
  return { primitives: p.list, drives: f.drives, screenshots: f.screenshots, seedUsers: p.seedUsers };
}

/** The Toolkit as a role sees it: primitives (from describe) and the feature drives in `src`. */
export async function toolkitBrief(job: Job, src: string): Promise<string> {
  if (!hasToolkit(job))
    return [
      "This repository has no Toolkit yet: nothing can drive the app.",
      "Prove every criterion you can with `test <file>` (a test the builder writes) or `cmd`.",
      "A criterion that can only be shown on the running app (a page, a screen, a response from the started server) still gets a `toolkit` proof with the generic primitives (open, read, press, type, screenshot, http, login, cli): Kitchen then pauses the job until the person builds a Toolkit, or reports that criterion as not proven if they choose to go on without one. Never fake the app with a `cmd`.",
    ].join("\n");
  const d = await describeToolkit(job.toolkitBin, src);
  const prims = (d.raw.primitives as ({ name: string; args?: Record<string, string>; does?: string } | string)[]).map((p) =>
    typeof p === "string"
      ? `- ${p}`
      : `- ${p.name} ${Object.keys(p.args ?? {})
          .map((a) => `--${a} <${p.args?.[a]}>`)
          .join(" ")}${p.does ? `: ${p.does}` : ""}`,
  );
  const f = featureDrives(src, toolkitDirOf(job));
  const drives = Object.entries(f.drives).map(([n, args]) => `- ${n} ${args.map((a) => `--${a} <value>`).join(" ")}  (${f.files[n]})`);
  const users = seedUsersOf(d.raw);
  const seed = users.length
    ? `Seed users (describe's seed_users; a proof signs in, or picks rows by username, only as one of these or as a user an earlier step makes): ${users.join(", ")}`
    : "";
  return [
    "Primitives (`bin/dev describe`; the engine passes id/src/out itself):",
    ...prims,
    "",
    "Feature drives on this branch:",
    ...(drives.length ? drives : ["- none"]),
    ...Object.entries(f.broken).map(([file, why]) => `- (unreadable: ${file}: ${why})`),
    ...(seed ? ["", seed] : []),
    "",
    `Toolkit docs: ${path.join(docsRoot(job, src), ".kitchen/toolkit/SKILL.md")} and ${path.join(docsRoot(job, src), FEATURES_DIR)}/*.md`,
  ].join("\n");
}

/** Where the Toolkit's SKILL.md is: the source's own, else the Toolkit checkout's (an approved Toolkit not in the worktree). */
function docsRoot(job: Job, src: string): string {
  const tk = toolkitDirOf(job);
  return fs.existsSync(path.join(src, ".kitchen/toolkit/SKILL.md")) || !tk ? src : tk;
}

export async function doctorOk(job: Job, jobDir?: string): Promise<boolean> {
  if (!hasToolkit(job)) return false;
  return instanceDoctor(job, jobDir);
}
