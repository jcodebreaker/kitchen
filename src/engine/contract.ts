// The job's verification contract as the engine reads it: spec.md, or a
// low-risk ticket's inline criteria in intake.md. Plus the commit policies that
// keep each role to its layer (PLAN §2 "Toolkit: two layers"; the repro the
// builder may not edit).
import fs from "node:fs";
import path from "node:path";
import { type Criterion, isProtected, newDrivesOf, parseCriteria } from "../checks/spec-lint.ts";
import { parseProof, type ToolkitSegment } from "../proof/proof-line.ts";
import type { CommitPolicy } from "./worktree.ts";

export type Contract = { file: "spec.md" | "intake.md"; text: string; criteria: Criterion[]; newDrives: string[] };

export function contractOf(jobDir: string): Contract | null {
  for (const file of ["spec.md", "intake.md"] as const) {
    const p = path.join(jobDir, file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    const criteria = parseCriteria(text);
    if (criteria.length) return { file, text, criteria, newDrives: newDrivesOf(text) };
  }
  return null;
}

const segmentsOf = (c: Criterion): ToolkitSegment[] => {
  try {
    return parseProof(c.proof ?? "").filter((s): s is ToolkitSegment => s.kind === "toolkit");
  } catch {
    return [];
  }
};

/** Feature drives the contract names, each with the args of its first use (for `toolkit check --feature`). */
export function namedDrives(criteria: Criterion[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const c of criteria) for (const s of segmentsOf(c)) if (s.drive && !out.has(s.name)) out.set(s.name, s.args);
  return out;
}

/** The spec args a criterion gives a feature drive (for the `--args` delta log). */
export const specArgsOf = (c: Criterion, drive: string) => segmentsOf(c).find((s) => s.drive && s.name === drive)?.args;

export const reproCriterion = (criteria: Criterion[], id?: string) => criteria.find((c) => (id ? c.id === id : c.repro)) ?? criteria.find((c) => c.repro);

/** Files a test/cmd proof names (the regression test the repro must leave). */
export function testFilesOf(c: Criterion): string[] {
  try {
    return parseProof(c.proof ?? "").flatMap((s) => (s.kind === "test" ? [s.file.replace(/^\.\//, "")] : []));
  } catch {
    return [];
  }
}

const TOOLKIT = ".kitchen/toolkit/";
const FEATURE = /^\.kitchen\/toolkit\/features\/[^/]+\.md$/;

/** Builder: app code and tests. No Toolkit file (primitives: smith; drives: verifier), no protected path, no repro file. */
export const builderPolicy =
  (protectedGlobs: string[], reproFiles: string[]): CommitPolicy =>
  (f) =>
    f.startsWith(TOOLKIT)
      ? "the builder may not change the Toolkit (primitives go through the smith, feature drives through the verifier)"
      : reproFiles.includes(f)
        ? "the repro's regression test is not the builder's to edit"
        : isProtected(f, protectedGlobs)
          ? "protected path"
          : f.startsWith(".kitchen/")
            ? "Kitchen's own files"
            : null;

/** Verifier, drives mode: feature drive files only. */
export const drivesPolicy: CommitPolicy = (f, status) =>
  !FEATURE.test(f) ? "in the drives stage only .kitchen/toolkit/features/*.md is kept" : status === "D" ? "a feature drive file is not deleted here" : null;

/** Repro: new files (the regression test) and feature drives; it changes no existing app file. */
export const reproPolicy =
  (protectedGlobs: string[]): CommitPolicy =>
  (f, status) =>
    FEATURE.test(f)
      ? status === "D"
        ? "a feature drive file is not deleted here"
        : null
      : f.startsWith(TOOLKIT) || f.startsWith(".kitchen/")
        ? "the repro may not change the Toolkit's primitives"
        : isProtected(f, protectedGlobs)
          ? "protected path"
          : status !== "A"
            ? "the repro adds a regression test; it doesn't change existing files (no fix before Build)"
            : null;

/** Nothing is kept (spec, verify): the role's only output is its file. */
export const nothingPolicy: CommitPolicy = () => "this role's only output is its file";
