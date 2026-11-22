// drives: every feature drive the contract names must resolve on the job HEAD,
// hold no code, and pass `toolkit check --feature` before any proof runs (PLAN
// §2, drives → verify). The engine decides all three; the verifier (drives
// mode) only writes the drives that are missing or that failed the check, and
// the engine commits feature drive files only (drivesPolicy) before any proof
// runs, so no evidence goes stale. Gate stays valid only while the commits
// since gate.md touch nothing but features/*.md.
import fs from "node:fs";
import path from "node:path";
import { changedExistingDrive, lintFeatureFile } from "../../checks/feature-lint.ts";
import { evidenceDir, readJob, sealOf } from "../../proof/job.ts";
import { verifyManifest } from "../../proof/manifest.ts";
import { checkFeatureDrive, type FeatureCheck } from "../../toolkit/feature-check.ts";
import { contractOf, drivesPolicy, namedDrives } from "../contract.ts";
import { freshUp } from "../instance.ts";
import type { Job } from "../machine.ts";
import { roundDir, writeAtomic } from "../store.ts";
import { changedFiles, commitWith, fileAtHead } from "../worktree.ts";
import { contractBlock, toolkitBlock } from "./context.ts";
import { gateStillValid } from "./gate.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import { FEATURES_DIR, featureDrives, hasToolkit, primitives } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

type Assessment = { missing: string[]; refused: string[]; gaps: string[]; changed: string[] };

/** Which named drives don't resolve on the worktree, and which changed feature files fail the no-code lint. */
async function assess(job: Job, named: Map<string, Record<string, string>>, prims: string[]): Promise<Assessment> {
  const f = featureDrives(job.worktree);
  const changedFeatureFiles = (await changedFiles(job, job.base)).filter((p) => p.startsWith(`${FEATURES_DIR}/`) && p.endsWith(".md"));
  const refused: string[] = [];
  const gaps: string[] = [];
  for (const rel of changedFeatureFiles) {
    const abs = path.join(job.worktree, rel);
    if (!fs.existsSync(abs)) continue;
    const l = lintFeatureFile(fs.readFileSync(abs, "utf8"), prims);
    if (!l.ok) refused.push(`${rel}: ${l.reason}`);
    else gaps.push(...l.gaps);
  }
  const changed = [...named.keys()].filter((d) => f.files[d] && changedFeatureFiles.includes(f.files[d]));
  return { missing: [...named.keys()].filter((d) => !f.drives[d]), refused, gaps: [...new Set(gaps)], changed };
}

export const drives: StageHandler = async (ctx) => {
  let job = ctx.refresh();
  const attempt = job.attempts.drives + 1;
  const dir = roundDir(ctx.jobDir, job.round);
  const base = { resolved: false, featureChecks: false };
  if (!(await gateStillValid(ctx.jobDir, job))) return { to: "gate", facts: { drives: { gateValid: false, ...base } } };
  const contract = contractOf(ctx.jobDir);
  const named = namedDrives(contract?.criteria ?? []);
  const prims = (await primitives(job)).list;
  if (hasToolkit(job)) await freshUp(job, ctx.jobDir, ctx.log);

  let a = await assess(job, named, prims);
  let checks: FeatureCheck[] = [];
  const runChecks = async () => {
    checks = [];
    for (const d of a.changed)
      checks.push(await checkFeatureDrive({ job, jobDir: ctx.jobDir, drive: d, args: named.get(d) ?? {}, log: (m) => ctx.log(`[check] ${m}`) }));
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
              ...a.missing.map((d) => `- missing: ${d} (args: ${Object.keys(named.get(d) ?? {}).join(", ") || "none"})`),
              ...a.refused.map((x) => `- refused (no code in drives): ${x}`),
              ...failing.map((c) => `- failed the engine's check (reset, run, reset, run): ${c.drive}: ${c.why} (evidence ${c.evidence.join(" ")})`),
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
    // Only feature drive files, and only ones that hold no code: a refused file never reaches the branch.
    const wt = job.worktree;
    const before = await featureFilesAtHead(job);
    const c = await commitWith(job, `kitchen(${job.id}): feature drives`, (f, status) => {
      const layer = drivesPolicy(f, status);
      if (layer) return layer;
      const text = fs.readFileSync(path.join(wt, f), "utf8");
      const l = lintFeatureFile(text, prims);
      if (!l.ok) return `refused: ${l.reason}`;
      const changed = status === "M" ? changedExistingDrive(before.get(f) ?? "", text) : null;
      return changed ? `refused: ${changed}` : null;
    });
    for (const x of c.refused) ctx.log(`kept off the job branch: ${x}`);
    lintRefused = c.refused.filter((x) => x.includes(": refused: "));
    a = await assess(job, named, prims);
    failing = a.missing.length || a.refused.length ? [] : await runChecks();
  }
  const gateValid = await gateStillValid(ctx.jobDir, job);
  const unreachable = agent?.DRIVES === "UNREACHABLE" && unreachableCited(ctx.jobDir, agentText, job.round);
  const missingPrimitive = agent?.GAP || a.gaps[0] || undefined;
  const resolved = a.missing.length === 0 && a.refused.length === 0;
  const featureChecks = resolved && failing.length === 0;
  const why = [
    ...lintRefused,
    ...a.missing.map((d) => `${d} does not resolve on HEAD`),
    ...a.refused,
    ...failing.map((c) => `${c.drive}: ${c.why}`),
    ...(agent?.DRIVES === "UNREACHABLE" && !unreachable ? ["UNREACHABLE without a failed verifier run stamped this round"] : []),
  ];
  writeAtomic(
    path.join(dir, `drives-check-${attempt}.md`),
    [
      `RESOLVED: ${resolved}`,
      `FEATURE-CHECKS: ${featureChecks}`,
      ...checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.drive} ${c.evidence.join(" ")}${c.why ? `: ${c.why}` : ""}`),
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
