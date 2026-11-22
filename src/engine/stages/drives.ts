// drives: every feature drive the contract names must resolve on the job HEAD,
// hold no code, pass W2's feature-file rules, and every criterion that uses a
// new or changed drive must run end to end, twice, from seed state, before any
// proof runs (PLAN §2, drives → verify). The engine decides all of it; the
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
import { type ChainCheck, checkChain, featureFileProblems } from "../../toolkit/feature-check.ts";
import { contractOf, drivesPolicy, namedDrives, testFilesOf } from "../contract.ts";
import { freshUp } from "../instance.ts";
import type { Job } from "../machine.ts";
import { roundDir, writeAtomic } from "../store.ts";
import { changedFiles, commitWith, fileAtHead } from "../worktree.ts";
import { contractBlock, toolkitBlock } from "./context.ts";
import { gateStillValid } from "./gate.ts";
import { prompt } from "./prompts.ts";
import { headers, named as namedHeader, runRole } from "./role.ts";
import { described, FEATURES_DIR, featureDrives, hasToolkit } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

type Assessment = { missing: string[]; refused: string[]; gaps: string[]; affected: Criterion[] };

/** A `GAP:` value that says nothing is missing (`none`, `-`, `n/a`, a placeholder). */
const SAYS_NONE = /^`?(none|no|n\/?a|null|nil|-+|—|\(none\)|<.*>)`?(\s|$)/i;

/** What doesn't resolve on the worktree, which changed feature files are refused, and which criteria use a new or changed drive. */
async function assess(job: Job, criteria: Criterion[], tk: { primitives: string[]; features: string[] }): Promise<Assessment> {
  const named = namedDrives(criteria);
  const f = featureDrives(job.worktree);
  const changedFeatureFiles = (await changedFiles(job, job.base)).filter((p) => p.startsWith(`${FEATURES_DIR}/`) && p.endsWith(".md"));
  const refused: string[] = [];
  const gaps: string[] = [];
  for (const rel of changedFeatureFiles) {
    const abs = path.join(job.worktree, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const l = lintFeatureFile(text, tk.primitives);
    if (!l.ok) refused.push(`${rel}: ${l.reason}`);
    else {
      gaps.push(...l.gaps);
      refused.push(...featureFileProblems(rel, text, tk.features));
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
  };
}

export const drives: StageHandler = async (ctx) => {
  let job = ctx.refresh();
  const attempt = job.attempts.drives + 1;
  const dir = roundDir(ctx.jobDir, job.round);
  const base = { resolved: false, featureChecks: false };
  if (!(await gateStillValid(ctx.jobDir, job))) return { to: "gate", facts: { drives: { gateValid: false, ...base } } };
  const criteria = contractOf(ctx.jobDir)?.criteria ?? [];
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
              ...failing.map(
                (c) =>
                  `- ${c.criterion}'s whole proof did not run end to end (the engine's check: reset, run, reset, run): ${c.why} (evidence ${c.evidence.join(" ")})`,
              ),
              ...previousFailure(dir, attempt - 1),
            ].join("\n"),
          },
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
    const before = await featureFilesAtHead(job);
    tk = await described(job);
    const c = await commitWith(job, `kitchen(${job.id}): feature drives`, (f, status) => {
      const layer = drivesPolicy(testFiles)(f, status);
      if (layer) return layer;
      if (testFiles.includes(f)) return null;
      const text = fs.readFileSync(path.join(wt, f), "utf8");
      const l = lintFeatureFile(text, tk.primitives);
      if (!l.ok) return `refused: ${l.reason}`;
      const changed = status === "M" ? changedExistingDrive(before.get(f) ?? "", text) : null;
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
      ...checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.criterion} (whole proof, twice) ${c.evidence.join(" ")}${c.why ? `: ${c.why}` : ""}`),
      ...why.map((w) => `- ${w}`),
      "",
    ].join("\n"),
  );
  if (why.length) ctx.log(`drives: ${why.join("; ")}`);
  const writeFailed = !unreachable && !missingPrimitive && !(resolved && featureChecks);
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

/** Every features/*.md at HEAD that the worktree still has, by repo-relative path. */
export async function featureFilesAtHead(job: Job): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = path.join(job.worktree, FEATURES_DIR);
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const rel = `${FEATURES_DIR}/${f}`;
    const t = await fileAtHead(job, rel);
    if (t !== null) out.set(rel, t);
  }
  return out;
}
