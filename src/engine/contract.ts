// The job's verification contract as the engine reads it: spec.md, or a
// low-risk ticket's inline criteria in intake.md. Plus the commit policies that
// keep each role to its layer (PLAN §2 "Toolkit: two layers"; the repro the
// builder may not edit; the files proofs run through the builder may not edit).
import fs from "node:fs";
import path from "node:path";
import { type Criterion, isProtected, newDrivesOf, parseCriteria } from "../checks/spec-lint.ts";
import { TEST_RUNNER_CONFIG } from "../checks/test-layout.ts";
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

const INTERPRETERS = /^(sh|bash|zsh|node|deno|bun|tsx|ts-node|python3?|ruby|perl|php)$/;
const CONFIGISH =
  /(^|\/)(Makefile|justfile|Taskfile\.ya?ml|package\.json|tsconfig[^/]*\.json|biome\.jsonc?|\.eslintrc[^/]*|eslint\.config\.[^/]+|\.prettierrc[^/]*|[^/]*\.config\.[cm]?[jt]s|pytest\.ini|setup\.cfg|tox\.ini|pyproject\.toml|\.mocharc[^/]*|jest\.config[^/]*|vitest\.config[^/]*)$/;
/**
 * Files Gate's checks and `test` proofs run through (kitchen.yaml `checks` and `test_cmd`): a
 * script they start (`./scripts/check.sh`, `sh ci/lint.sh`), and the config files they name.
 * The file a check only reads (`node --check server.js`) is app code, not one of these. Pure.
 */
export function filesChecksRunThrough(cmds: string[]): string[] {
  const out = new Set<string>();
  for (const cmd of cmds) {
    for (const part of cmd.split(/&&|\|\||[;|]/)) {
      const w = part
        .trim()
        .split(/\s+/)
        .filter((x) => x && !/^[A-Z_][A-Z0-9_]*=/.test(x));
      const pathy = (x: string) => /[/.]/.test(x) && !x.startsWith("-") && !x.includes("{") && !/^\.\.?$/.test(x);
      if (w[0] && pathy(w[0]) && w[0].includes("/")) out.add(w[0].replace(/^\.\//, ""));
      if (w[0] && INTERPRETERS.test(w[0])) {
        const at = w.findIndex((x, i) => i > 0 && !x.startsWith("-"));
        const script = at > 0 ? w[at] : undefined;
        // `node --check x.js` reads x.js, `sh -c "…"` runs no file: only a script the interpreter runs counts.
        const flags = at > 0 ? w.slice(1, at) : [];
        if (script && pathy(script) && !flags.some((x) => /^--?(check|c|e|eval|p|print)$/.test(x))) out.add(script.replace(/^\.\//, ""));
      }
      for (const x of w) if (pathy(x) && CONFIGISH.test(x)) out.add(x.replace(/^\.\//, ""));
    }
  }
  return [...out];
}

/** Did the `scripts` (or the `jest` config) of a package.json change (text before → after)? Unparseable counts as changed. Pure. */
export function scriptsChanged(before: string | null, after: string | null): boolean {
  const scripts = (t: string | null) => {
    if (t === null) return {};
    const j = JSON.parse(t) as { scripts?: unknown; jest?: unknown };
    return [j.scripts ?? {}, j.jest ?? null];
  };
  try {
    return JSON.stringify(scripts(before)) !== JSON.stringify(scripts(after));
  } catch {
    return true;
  }
}

export type BuilderLimits = {
  protectedGlobs: string[];
  /** What the repro committed: the regression test or drive. */
  reproFiles: string[];
  /** Test files the contract's `test` proofs run: the spec, repro or drives stage writes them, never the builder. */
  proofFiles?: string[];
  /** Files Gate and `test` proofs run through (filesChecksRunThrough). */
  checkFiles?: string[];
  /** package.json files whose `scripts` the builder changed (Gate and `npm test` proofs run through them). */
  scriptsChanged?: string[];
};

/** What the builder may not change, in order: the first rule that matches a path gives the reason it is kept off the branch. */
const BUILDER_RULES: readonly [(f: string, l: BuilderLimits) => boolean, string][] = [
  [(f) => f.startsWith(TOOLKIT), "the builder may not change the Toolkit (primitives go through the smith, feature drives through the verifier)"],
  [(f, l) => l.reproFiles.includes(f), "the repro's regression test is not the builder's to edit"],
  [(f, l) => (l.proofFiles ?? []).includes(f), "a test file a `test` proof runs is the contract's, not the builder's to write or edit"],
  [(f, l) => (l.checkFiles ?? []).includes(f), "Gate's checks or the test command run through this file"],
  [(f, l) => (l.scriptsChanged ?? []).includes(f), "package.json `scripts` or `jest` changed: Gate's checks and test proofs run through them"],
  [
    (f) => TEST_RUNNER_CONFIG.test(f),
    "test-runner config (which files the tests are): put a test where the repo's runner already finds tests, don't widen its include",
  ],
  [(f, l) => isProtected(f, l.protectedGlobs), "protected path"],
  [(f) => f.startsWith(".kitchen/"), "Kitchen's own files"],
];

/** Builder: app code and tests. No Toolkit file (primitives: smith; drives: verifier), no protected path, nothing a proof runs through. */
export const builderPolicy =
  (l: BuilderLimits): CommitPolicy =>
  (f) =>
    BUILDER_RULES.find(([hit]) => hit(f, l))?.[1] ?? null;

/** Verifier, drives mode: feature drive files, and the test files the contract's `test` proofs name. */
export const drivesPolicy =
  (testFiles: string[] = []): CommitPolicy =>
  (f, status) =>
    testFiles.includes(f)
      ? status === "D"
        ? "a test file is not deleted here"
        : null
      : !FEATURE.test(f)
        ? "in the drives stage only .kitchen/toolkit/features/*.md and the contract's test files are kept"
        : status === "D"
          ? "a feature drive file is not deleted here"
          : null;

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
          : TEST_RUNNER_CONFIG.test(f)
            ? "test-runner config: the regression test goes where the repo's runner already finds tests"
            : status !== "A"
              ? "the repro adds a regression test; it doesn't change existing files (no fix before Build)"
              : null;

/** Nothing is kept (spec, verify): the role's only output is its file. */
export const nothingPolicy: CommitPolicy = () => "this role's only output is its file";
