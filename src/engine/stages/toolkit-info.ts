// What the stages ask the Toolkit (through src/toolkit/run.ts, untrusted env).
// No Toolkit: no primitives, no drives, doctor not ok.
// W3b: W1/W3a run the repo's own .kitchen/toolkit/bin/dev; W3b runs the engine-owned
// checkout at the job's toolkitRef.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolkitView } from "../../checks/spec-lint.ts";
import { describeToolkit } from "../../proof/drive.ts";
import { extractDriveBlocks, parseDrive } from "../../proof/drive-format.ts";
import { doctorOk as instanceDoctor } from "../instance.ts";
import type { Job } from "../machine.ts";

export const hasToolkit = (job: Job) => !!job.toolkitBin && fs.existsSync(job.toolkitBin);
export const FEATURES_DIR = ".kitchen/toolkit/features";

export async function primitives(job: Job, src = job.worktree || process.cwd()): Promise<{ list: string[]; sha: string }> {
  if (!hasToolkit(job)) return { list: [], sha: "" };
  const d = await describeToolkit(job.toolkitBin, src);
  // W3b: `sha` must be the Toolkit PR's commit sha (toolkitRef pins the proofs to it).
  // W1 has no Toolkit PR branch, so this is a hash of `describe` output: it changes when
  // the primitive list changes, and pins nothing.
  return { list: d.primitives, sha: createHash("sha256").update(JSON.stringify(d.raw)).digest("hex").slice(0, 12) };
}

/**
 * Every feature drive in `<src>/.kitchen/toolkit/features/*.md`: name → args, and the
 * file it is in. A file that doesn't parse is reported in `broken`, its drives left out.
 */
export function featureDrives(src: string): {
  drives: Record<string, string[]>;
  files: Record<string, string>;
  broken: Record<string, string>;
  /** Drives with a `screenshot` step. */
  screenshots: string[];
} {
  const dir = path.join(src, FEATURES_DIR);
  const drives: Record<string, string[]> = {};
  const files: Record<string, string> = {};
  const broken: Record<string, string> = {};
  const screenshots: string[] = [];
  if (!fs.existsSync(dir)) return { drives, files, broken, screenshots };
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith(".md"))
    .sort()) {
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
  const f = featureDrives(src);
  return { primitives: (await primitives(job, src)).list, drives: f.drives, screenshots: f.screenshots };
}

/** The Toolkit as a role sees it: primitives (from describe) and the feature drives in `src`. */
export async function toolkitBrief(job: Job, src: string): Promise<string> {
  if (!hasToolkit(job)) return "This repository has no Toolkit: nothing can drive the app.";
  const d = await describeToolkit(job.toolkitBin, src);
  const prims = (d.raw.primitives as ({ name: string; args?: Record<string, string>; does?: string } | string)[]).map((p) =>
    typeof p === "string"
      ? `- ${p}`
      : `- ${p.name} ${Object.keys(p.args ?? {})
          .map((a) => `--${a} <${p.args?.[a]}>`)
          .join(" ")}${p.does ? `: ${p.does}` : ""}`,
  );
  const f = featureDrives(src);
  const drives = Object.entries(f.drives).map(([n, args]) => `- ${n} ${args.map((a) => `--${a} <value>`).join(" ")}  (${f.files[n]})`);
  const seed = Array.isArray(d.raw.seedUsers) ? `Seed users: ${(d.raw.seedUsers as string[]).join(", ")}` : "";
  return [
    "Primitives (`bin/dev describe`; the engine passes id/src/out itself):",
    ...prims,
    "",
    "Feature drives on this branch:",
    ...(drives.length ? drives : ["- none"]),
    ...Object.entries(f.broken).map(([file, why]) => `- (unreadable: ${file}: ${why})`),
    ...(seed ? ["", seed] : []),
    "",
    `Toolkit docs: ${path.join(src, ".kitchen/toolkit/SKILL.md")} and ${path.join(src, FEATURES_DIR)}/*.md`,
  ].join("\n");
}

export async function doctorOk(job: Job, jobDir?: string): Promise<boolean> {
  if (!hasToolkit(job)) return false;
  return instanceDoctor(job, jobDir);
}
