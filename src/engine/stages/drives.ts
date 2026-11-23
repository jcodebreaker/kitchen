// drives: every feature drive the contract names must resolve on the job HEAD,
// hold no code, pass W2's feature-file rules, and every criterion that uses a
// new or changed drive must run end to end, twice, from seed state, and every
// new `check:` line must run alone from seed (as W2's re-proof will), before any
// proof runs (PLAN §2, drives → verify). Then, for a feature, the criteria that
// needed the new drives run on the base plus those drive files (base-check.ts):
// one that already passes there is flagged NON-DISCRIMINATING. The engine decides all of it; the
// verifier (drives mode) only writes what is missing or failed: feature drives,
// and the test files `test` proofs name (the builder may not write those). The
// engine commits only those files (drivesPolicy) before any proof runs, so no
// evidence goes stale. Gate stays valid only while the commits since gate.md
// touch nothing but features/*.md (a new test file means Gate runs again).
import fs from "node:fs";
import path from "node:path";
import { changedExistingDrive, lintFeatureFile } from "../../checks/feature-lint.ts";
import type { Criterion } from "../../checks/spec-lint.ts";
import { evidenceDir, readJob, sealOf } from "../../proof/job.ts";
import { verifyManifest } from "../../proof/manifest.ts";
import { type ChainCheck, checkChain, checkLineAlone, checkLinesOf, featureFileProblems } from "../../toolkit/feature-check.ts";
import { contractOf, drivesPolicy, namedDrives, provable, testFilesOf } from "../contract.ts";
import { freshUp } from "../instance.ts";
import type { Job } from "../machine.ts";
import { roundDir, writeAtomic } from "../store.ts";
import { changedFiles, commitWith, fileAtHead, headOf } from "../worktree.ts";
import { runBaseCheckAfterDrives } from "./base-check.ts";
import { contractBlock, testLayoutBlock, toolkitBlock } from "./context.ts";
import { gateStillValid } from "./gate.ts";
import { prompt } from "./prompts.ts";
import { headers, named as namedHeader, runRole } from "./role.ts";
import { described, FEATURES_DIR, featureDrives, hasToolkit, toolkitDirOf } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

type CheckLine = { file: string; drive: string; args: Record<string, string> };
type Assessment = { missing: string[]; refused: string[]; gaps: string[]; affected: Criterion[]; checkLines: CheckLine[] };

/** A `GAP:` value that says nothing is missing (`none`, `-`, `n/a`, a placeholder). */
const SAYS_NONE = /^`?(none|no|n\/?a|null|nil|-+|—|\(none\)|<.*>)`?(\s|$)/i;

/** What doesn't resolve on the worktree, which changed feature files are refused, and which criteria use a new or changed drive. */
async function assess(job: Job, criteria: Criterion[], tk: { primitives: string[]; features: string[] }): Promise<Assessment> {
  const named = namedDrives(criteria);
  const f = featureDrives(job.worktree, toolkitDirOf(job));
  const changedFeatureFiles = (await changedFiles(job, job.base)).filter((p) => p.startsWith(`${FEATURES_DIR}/`) && p.endsWith(".md"));
  const refused: string[] = [];
  const gaps: string[] = [];
  // The check lines of drives this job added (a drive the base or the repro already had is not this job's).
  const before = await featureFilesAt(job, job.base, job.reproFiles ?? []);
  const had = new Set([...before].flatMap(([rel, text]) => checkLinesOf(rel, text).map((c) => c.drive)));
  const checkLines: CheckLine[] = [];
  for (const rel of changedFeatureFiles) {
    const abs = path.join(job.worktree, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const l = lintFeatureFile(text, tk.primitives);
    if (!l.ok) refused.push(`${rel}: ${l.reason}`);
    else {
      gaps.push(...l.gaps);
      refused.push(...featureFileProblems(rel, text, tk.features));
      checkLines.push(...checkLinesOf(rel, text).filter((c) => !had.has(c.drive)));
    }
  }
  const changedDrives = new Set([...named.keys()].filter((d) => f.files[d] && changedFeatureFiles.includes(f.files[d])));
  const affected = criteria.filter((c) => [...namedDrives([c]).keys()].some((d) => changedDrives.has(d)));
  const missingTests = criteria.flatMap(testFilesOf).filter((t) => !fs.existsSync(path.join(job.worktree, t)));
  return {
    missing: [...[...named.keys()].filter((d) => !f.drives[d]), ...[...new Set(missingTests)].map((t) => `test file ${t}`)],
    refused,
    gaps: [...new Set(gaps)],
    affected,
    checkLines,
  };
}

export const drives: StageHandler = async (ctx) => {
  let job = ctx.refresh();
  const attempt = job.attempts.drives + 1;
  const dir = roundDir(ctx.jobDir, job.round);
  const base = { resolved: false, featureChecks: false };
  if (!(await gateStillValid(ctx.jobDir, job))) return { to: "gate", facts: { drives: { gateValid: false, ...base } } };
  // Without a Toolkit only the test/cmd criteria have anything to write or check (ADR 0010).
  const criteria = provable(contractOf(ctx.jobDir)?.criteria ?? [], hasToolkit(job));
  const named = namedDrives(criteria);
  const testFiles = [...new Set(criteria.flatMap(testFilesOf))];
  let tk = await described(job);
  if (hasToolkit(job)) await freshUp(job, ctx.jobDir, ctx.log);

  let a = await assess(job, criteria, tk);
  let checks: ChainCheck[] = [];
  const runChecks = async () => {
    checks = [];
    for (const c of a.affected)
      checks.push(await checkChain({ job, jobDir: ctx.jobDir, criterion: c, testCmd: ctx.config.test_cmd, log: (m) => ctx.log(`[check] ${m}`) }));
    // Each new check line alone, from seed: what the Toolkit's own check will run once this is merged.
    for (const line of a.checkLines) checks.push(await checkLineAlone({ job, jobDir: ctx.jobDir, line, log: (m) => ctx.log(`[check line] ${m}`) }));
    return checks.filter((c) => !c.ok);
  };
  let failing = a.missing.length || a.refused.length ? [] : await runChecks();
  let agent: Record<string, string> | null = null;
  let lintRefused: string[] = [];
  let agentText = "";
  if (a.missing.length || a.refused.length || failing.length) {
    const r = await runRole(ctx, {
      role: "verifier",
      file: "drives.md",
      tier: "write",
      prompt: prompt({
        role: "verifier",
        mode: "drives",
        job,
        jobDir: ctx.jobDir,
        blocks: [
          contractBlock(ctx.jobDir),
          {
            title: "What to write",
            body: [
              ...a.missing.map((d) =>
                d.startsWith("test file ") ? `- missing: ${d}` : `- missing: ${d} (args: ${Object.keys(named.get(d) ?? {}).join(", ") || "none"})`,
              ),
              ...a.refused.map((x) => `- refused: ${x}`),
              ...failing.map((c) =>
                c.criterion.startsWith("check line ")
                  ? `- the ${c.criterion.slice(11)} \`check:\` line failed when run alone from seed state (as the Toolkit's own check runs it after merge): ${c.why} (evidence ${c.evidence.join(" ")}). Make it self-sufficient: args that name seed data that already exists, or a drive whose own steps make what it needs first`
                  : `- ${c.criterion}'s whole proof did not run end to end (the engine's check: reset, run, reset, run): ${c.why} (evidence ${c.evidence.join(" ")})`,
              ),
              ...previousFailure(dir, attempt - 1),
            ].join("\n"),
          },
          ...testLayoutBlock(job.worktree, ctx.config.test_cmd),
          await toolkitBlock(job, job.worktree),
        ],
      }),
      dest: path.join(dir, `drives-${attempt}.md`),
    });
    agentText = r.text;
    agent = headers(r.text);
    job = ctx.refresh();
    // Only feature drive files and the contract's test files; a feature file only if it holds no code and passes W2's rules.
    const wt = job.worktree;
    const before = await featureFilesAt(job, job.base, job.reproFiles ?? []);
    tk = await described(job);
    const c = await commitWith(job, `kitchen(${job.id}): feature drives`, (f, status) => {
      const layer = drivesPolicy(testFiles)(f, status);
      if (layer) return layer;
      if (testFiles.includes(f)) return null;
      const text = fs.readFileSync(path.join(wt, f), "utf8");
      const l = lintFeatureFile(text, tk.primitives);
      if (!l.ok) return `refused: ${l.reason}`;
      const changed = before.has(f) ? changedExistingDrive(before.get(f) ?? "", text) : null;
      if (changed) return `refused: ${changed}`;
      const problems = featureFileProblems(f, text, tk.features);
      return problems.length ? `refused: ${problems.join("; ")}` : null;
    });
    for (const x of c.refused) ctx.log(`kept off the job branch: ${x}`);
    lintRefused = c.refused.filter((x) => x.includes(": refused: "));
    a = await assess(job, criteria, tk);
    failing = a.missing.length || a.refused.length ? [] : await runChecks();
  }
  const gateValid = await gateStillValid(ctx.jobDir, job);
  const unreachable = agent?.DRIVES === "UNREACHABLE" && unreachableCited(ctx.jobDir, agentText, job.round);
  // A GAP counts only when it names one primitive describe doesn't have; free text is a failed write, not a gap.
  const rawGap = agent?.GAP?.trim();
  const agentGap = namedHeader(rawGap, tk.primitives);
  const badGap = !!rawGap && !agentGap && !SAYS_NONE.test(rawGap);
  const missingPrimitive = agentGap || a.gaps[0] || undefined;
  const resolved = a.missing.length === 0 && a.refused.length === 0;
  const featureChecks = resolved && failing.length === 0;
  const why = [
    ...lintRefused,
    ...a.missing.map((d) => `${d} does not resolve on HEAD`),
    ...a.refused,
    ...failing.map((c) => `${c.criterion}: ${c.why}`),
    ...(agent?.DRIVES === "UNREACHABLE" && !unreachable ? ["UNREACHABLE without a failed verifier run stamped this round"] : []),
    ...(badGap ? [`GAP: ${JSON.stringify(rawGap)} names no missing primitive (one name describe lacks): not a Toolkit gap`] : []),
  ];
  writeAtomic(
    path.join(dir, `drives-check-${attempt}.md`),
    [
      `RESOLVED: ${resolved}`,
      `FEATURE-CHECKS: ${featureChecks}`,
      ...checks.map(
        (c) =>
          `- ${c.ok ? "PASS" : "FAIL"} ${c.criterion}${c.criterion.startsWith("check line ") ? " (alone, from seed)" : " (whole proof, twice)"} ${c.evidence.join(" ")}${c.why ? `: ${c.why}` : ""}`,
      ),
      ...why.map((w) => `- ${w}`),
      "",
    ].join("\n"),
  );
  if (why.length) ctx.log(`drives: ${why.join("; ")}`);
  const writeFailed = !unreachable && !missingPrimitive && !(resolved && featureChecks);
  // On to Verify: for a feature, the criteria that needed new drives or tests now run on the base plus those files.
  let nonDiscriminating: string[] = [];
  if (gateValid && !missingPrimitive && !unreachable && !writeFailed && job.kind !== "bug") {
    try {
      const after = await runBaseCheckAfterDrives(ctx, job, criteria, await headOf(job));
      nonDiscriminating = after?.passing ?? [];
    } catch (e) {
      ctx.log(`base check after drives could not run: ${(e as Error).message}`);
    }
  }
  if (nonDiscriminating.length)
    fs.appendFileSync(
      path.join(dir, `drives-check-${attempt}.md`),
      `NON-DISCRIMINATING: ${nonDiscriminating.join(" ")} (already hold on the base with only the new drive files: base-check.json afterDrives)\n`,
    );
  const facts = { drives: { gateValid, resolved, featureChecks, unreachable, missingPrimitive, writeFailed } };
  const to = !gateValid
    ? "gate"
    : missingPrimitive
      ? "toolkit"
      : unreachable
        ? "build"
        : writeFailed
          ? job.attempts.drives + 1 < 2
            ? "drives"
            : "needs-human"
          : "verify";
  return { to, facts };
};

function previousFailure(dir: string, n: number): string[] {
  if (n < 1) return [];
  const p = path.join(dir, `drives-check-${n}.md`);
  return fs.existsSync(p) ? ["", "Last attempt:", fs.readFileSync(p, "utf8")] : [];
}

/** UNREACHABLE counts only with a cited, failed run the verifier made this round (stamped by the engine). */
function unreachableCited(jobDir: string, text: string, round: number): boolean {
  const ids = (/^\s*EVIDENCE:\s*(.*)$/m.exec(text)?.[1] ?? "").match(/\be\d+\b/g) ?? [];
  if (!ids.length) return false;
  const job = readJob(jobDir);
  const entries = verifyManifest(evidenceDir(jobDir), job.manifestHead, sealOf(job));
  return ids.some((id) => {
    const e = entries.find((x) => x.id === id);
    return !!e && e.role === "verifier" && e.round === round && e.ok === false;
  });
}

/**
 * Every features/*.md the worktree has, as it was at `ref` (repo-relative path → text):
 * the drives a job may not change. At the base: the shared drives (a job may still fix a
 * drive it added itself on a retry). The repro's own files are taken at HEAD by the
 * drives stage: no later stage changes what the repro committed.
 */
export async function featureFilesAt(job: Job, ref: string, headFor: string[] = []): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = path.join(job.worktree, FEATURES_DIR);
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const rel = `${FEATURES_DIR}/${f}`;
    const t = await fileAtHead(job, rel, headFor.includes(rel) ? "HEAD" : ref);
    if (t !== null) out.set(rel, t);
  }
  return out;
}
