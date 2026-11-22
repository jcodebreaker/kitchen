// Role skills in a job (ADR 0014): before each agent role, every required skill the job's roles
// need on its path must be installed (else SkillMissing: the job waits for a person before any
// agent spends money), and the role's own found skills are quoted into its prompt. What each
// role saw is pinned on its run (name, path, host, sha256), and a rerun whose skill changed says so.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../../config.ts";
import { appendLedger } from "../../ledger/append.ts";
import { skillsSection } from "../../skills/deliver.ts";
import { blockerReason, type Missing, planRole } from "../../skills/plan.ts";
import type { Env } from "../../skills/ready.ts";
import { enabledPlugins } from "../../skills/ready.ts";
import { type Host, loadRegistry } from "../../skills/registry.ts";
import type { JobFacts } from "../../skills/select.ts";
import { type AgentRunRef, effectiveRisk, type Job, type SkillUse } from "../machine.ts";
import { SkillMissing, type StageContext } from "./types.ts";

/** Where the agent tool loads skills, or null: skills off, or the fake tool with no `skills.host`. */
export function hostOf(config: Config): Host | null {
  if (!config.skills.enabled) return null;
  if (config.agent.tool === "fake") return config.skills.host ?? null;
  return config.agent.tool;
}

export const envOf = (repo: string, cwd?: string): Env => ({ home: os.homedir(), repo, cwd, codexHome: process.env.CODEX_HOME || undefined });

export function factsOf(job: Pick<Job, "kind" | "surfaces" | "risk" | "riskFloor">, jobDir: string): JobFacts {
  const t = path.join(jobDir, "ticket.md");
  return { kind: job.kind, surfaces: job.surfaces, risk: effectiveRisk(job), ticket: fs.existsSync(t) ? fs.readFileSync(t, "utf8") : "" };
}

/** The registry roles this job will run on its path: every non-review role, and a lens's reviewer (`code-if-diff` counted in). Pure. */
export function jobRoles(config: Config, job: Pick<Job, "risk" | "riskFloor" | "surfaces">, roles: string[]): string[] {
  const lenses = new Set(config.paths[effectiveRisk(job)].review.map((l) => (l.startsWith("code-if-diff") ? "code" : l)));
  for (const s of job.surfaces) for (const l of config.surfaces[s] ?? []) lenses.add(l);
  return roles.filter((r) => !r.startsWith("reviewer-") || lenses.has(r.slice("reviewer-".length)));
}

/** Pure: skills whose SKILL.md changed since an earlier run of the same role in this job. */
export function changedSince(runs: readonly Pick<AgentRunRef, "role" | "round" | "skills">[], role: string, uses: SkillUse[]) {
  const out: { name: string; round: number; was: string; now: string }[] = [];
  for (const u of uses) {
    const before = [...runs].reverse().find((r) => r.role === role && r.skills?.some((s) => s.name === u.name));
    const was = before?.skills?.find((s) => s.name === u.name)?.sha256;
    if (before && was && was !== u.sha256) out.push({ name: u.name, round: before.round, was, now: u.sha256 });
  }
  return out;
}

export type RoleSkills = { section: string; uses: SkillUse[]; skipped: Missing[] };

/**
 * The skills for `role` in this job, or SkillMissing when any role on the job's path lacks a required
 * skill. Logs skipped optional skills, refused ticket skills and changed hashes.
 */
export function skillsFor(ctx: StageContext, job: Job, role: string, cwd: string): RoleSkills {
  const none: RoleSkills = { section: "", uses: [], skipped: [] };
  const host = hostOf(ctx.config);
  if (!host) return none;
  const reg = loadRegistry();
  const env = envOf(ctx.repo, cwd);
  const facts = factsOf(job, ctx.jobDir);
  const plugins = host === "claude" ? enabledPlugins(env) : [];
  const blockers = jobRoles(ctx.config, job, Object.keys(reg.roles)).flatMap((r) => planRole(reg, r, facts, host, env, plugins).blockers);
  if (blockers.length) throw new SkillMissing(blockerReason(blockers, host, env));
  const plan = reg.roles[role] ? planRole(reg, role, facts, host, env, plugins) : null;
  if (!plan) return none;
  for (const m of plan.skipped) ctx.log(`${role}: skill ${m.name} skipped (${m.why}): not installed for ${host}`);
  for (const r of plan.refused) ctx.log(`${role}: skill ${r.name} refused (${r.why})`);
  const { text, delivered } = skillsSection(plan.found);
  const uses = plan.found.map((f, i) => ({
    name: f.name,
    path: f.path,
    host,
    sha256: f.sha256,
    chars: delivered[i]?.chars ?? 0,
    truncated: delivered[i]?.truncated ?? false,
  }));
  if (uses.length) ctx.log(`${role}: skills ${uses.map((u) => `${u.name}@${u.sha256.slice(0, 8)}`).join(", ")}`);
  for (const c of changedSince(job.agentRuns, role, uses)) {
    ctx.log(`warning: ${role}: skill ${c.name} changed since round ${c.round} (sha256 ${c.was.slice(0, 12)} → ${c.now.slice(0, 12)})`);
    appendLedger(ctx.repo, {
      job: job.id,
      stage: job.stage,
      round: job.round,
      event: "skill-changed",
      role,
      key: `${job.id}/m${job.moves}/${role}/skill-changed/${c.name}/${c.now}`,
      detail: { skill: c.name, was: c.was, now: c.now, since: c.round },
    });
  }
  return { section: text, uses, skipped: plan.skipped };
}

export type RoleSkillsLine = { role: string; used: { name: string; sha256: string }[]; skipped: string[]; degraded: boolean };

/**
 * Pure: per role, in the order roles first ran, the skills its runs were given (each name once, its
 * latest hash) and the optional ones it went without. `degradedRoles`: roles whose review is degraded
 * without a picked skill (the registry's `degraded`).
 */
export function skillsUsed(
  runs: readonly Pick<AgentRunRef, "role" | "ok" | "skills" | "skillsSkipped">[],
  degradedRoles: readonly string[] = [],
): RoleSkillsLine[] {
  const out = new Map<string, RoleSkillsLine>();
  for (const r of runs) {
    if (!r.ok) continue;
    const l = out.get(r.role) ?? { role: r.role, used: [], skipped: [], degraded: false };
    out.set(r.role, l);
    for (const s of r.skills ?? []) {
      const have = l.used.find((u) => u.name === s.name);
      if (have) have.sha256 = s.sha256;
      else l.used.push({ name: s.name, sha256: s.sha256 });
    }
    for (const n of r.skillsSkipped ?? []) if (!l.skipped.includes(n)) l.skipped.push(n);
  }
  for (const l of out.values()) {
    l.skipped = l.skipped.filter((n) => !l.used.some((u) => u.name === n || u.name.endsWith(`:${n}`)));
    l.degraded = degradedRoles.includes(l.role) && l.skipped.length > 0;
  }
  return [...out.values()];
}

/** The registry's roles that are degraded without a picked skill. */
export const degradedRoles = () =>
  Object.entries(loadRegistry().roles)
    .filter(([, e]) => e.degraded)
    .map(([r]) => r);
