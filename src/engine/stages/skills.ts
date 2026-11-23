// Role skills in a job (ADR 0014): before each agent role, every required skill of the roles still
// ahead on the job's path must be found (else SkillMissing: the job waits for a person before this
// role runs), and the role's own found skills are quoted into its prompt. What each role saw is
// pinned on its run (name, source, path, host, sha256, characters delivered), and a rerun whose
// skill changed (content or source) says so.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../../config.ts";
import { appendLedger } from "../../ledger/append.ts";
import { skillsSection } from "../../skills/deliver.ts";
import { blockerReason, type Missing, planRole } from "../../skills/plan.ts";
import { type Env, enabledPlugins } from "../../skills/ready.ts";
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

/** The lookup context: the main checkout's committed skills at `base` (never a worktree), the user's home. */
export const envOf = (repo: string, config: Config, base?: string): Env => ({
  home: os.homedir(),
  repo,
  base: base || undefined,
  codexHome: process.env.CODEX_HOME || undefined,
  useInstalled: config.skills.use_installed,
});

export function factsOf(job: Pick<Job, "kind" | "surfaces" | "risk" | "riskFloor">, jobDir: string): JobFacts {
  const t = path.join(jobDir, "ticket.md");
  return { kind: job.kind, surfaces: job.surfaces, risk: effectiveRisk(job), ticket: fs.existsSync(t) ? fs.readFileSync(t, "utf8") : "" };
}

/** The roles in the order a job runs them; a reviewer lens is `reviewer-<lens>`. */
const ORDER = ["intake", "spec", "builder", "verifier", "reviewer", "report"];
const rank = (role: string) => ORDER.indexOf(role.startsWith("reviewer-") ? "reviewer" : role);

/**
 * The registry roles still ahead of `current` on this job's path (itself included): every non-review
 * role, and a lens's reviewer when the path has that lens (`code-if-diff` counted in). A role Kitchen
 * doesn't order (the smith) checks every role. Pure.
 */
export function jobRoles(config: Config, job: Pick<Job, "risk" | "riskFloor" | "surfaces">, roles: string[], current?: string): string[] {
  const lenses = new Set(config.paths[effectiveRisk(job)].review.map((l) => (l.startsWith("code-if-diff") ? "code" : l)));
  for (const s of job.surfaces) for (const l of config.surfaces[s] ?? []) lenses.add(l);
  const from = current === undefined ? -1 : rank(current);
  return roles.filter((r) => (!r.startsWith("reviewer-") || lenses.has(r.slice("reviewer-".length))) && rank(r) >= from);
}

/** Pure: skills whose SKILL.md (content or source) changed since an earlier run of the same role in this job. */
export function changedSince(runs: readonly Pick<AgentRunRef, "role" | "round" | "skills">[], role: string, uses: SkillUse[]) {
  const out: { name: string; round: number; was: string; now: string }[] = [];
  const id = (s: Pick<SkillUse, "sha256" | "source">) => `${s.source ?? "?"} sha256 ${s.sha256.slice(0, 12)}`;
  for (const u of uses) {
    const key = u.name.split(":").pop();
    const before = [...runs].reverse().find((r) => r.role === role && r.skills?.some((s) => s.name.split(":").pop() === key));
    const was = before?.skills?.find((s) => s.name.split(":").pop() === key);
    if (before && was && (was.sha256 !== u.sha256 || (was.source !== undefined && was.source !== u.source)))
      out.push({ name: u.name, round: before.round, was: id(was), now: id(u) });
  }
  return out;
}

export type RoleSkills = { section: string; uses: SkillUse[]; skipped: Missing[] };

/**
 * The skills for `role` in this job, or SkillMissing when a role still ahead on the job's path lacks a
 * required skill. Logs skipped optional skills, refused ones and changed skills.
 */
export function skillsFor(ctx: StageContext, job: Job, role: string): RoleSkills {
  const none: RoleSkills = { section: "", uses: [], skipped: [] };
  const host = hostOf(ctx.config);
  if (!host) return none;
  const reg = loadRegistry();
  const env = envOf(ctx.repo, ctx.config, job.base);
  const facts = factsOf(job, ctx.jobDir);
  const plugins = host === "claude" ? enabledPlugins(env) : [];
  const blockers = jobRoles(ctx.config, job, Object.keys(reg.roles), role).flatMap((r) => planRole(reg, r, facts, host, env, plugins).blockers);
  if (blockers.length) throw new SkillMissing(blockerReason(blockers, host, env));
  const plan = reg.roles[role] ? planRole(reg, role, facts, host, env, plugins) : null;
  if (!plan) return none;
  for (const m of plan.skipped) ctx.log(`${role}: skill ${m.name} skipped (${m.why}): not found for ${host}`);
  for (const r of plan.refused) ctx.log(`${role}: skill ${r.name} refused (${r.why})`);
  const { text, delivered } = skillsSection(plan.found);
  const uses: SkillUse[] = plan.found.map((f, i) => ({
    name: f.name,
    source: f.where,
    path: f.path,
    host,
    sha256: f.sha256,
    chars: delivered[i]?.chars ?? 0,
    of: delivered[i]?.of ?? 0,
    truncated: delivered[i]?.truncated ?? false,
  }));
  if (uses.length) ctx.log(`${role}: skills ${uses.map((u) => `${u.name}@${u.sha256.slice(0, 8)} (${u.source})`).join(", ")}`);
  for (const c of changedSince(job.agentRuns, role, uses)) {
    ctx.log(`warning: ${role}: skill ${c.name} changed since round ${c.round} (${c.was} → ${c.now})`);
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

export type RoleSkillsLine = {
  role: string;
  used: { name: string; sha256: string; chars: number; of: number; truncated: boolean }[];
  /** Found but left out of the prompt by the total size cap. */
  leftOut: string[];
  skipped: string[];
  degraded: boolean;
};

/**
 * Pure: per role, in the order roles first ran, the skills its runs were given (each name once, its
 * latest run), those the size cap left out, and the optional ones it went without. `degradedRoles`:
 * roles whose review is degraded without a picked skill (the registry's `degraded`).
 */
export function skillsUsed(
  runs: readonly Pick<AgentRunRef, "role" | "ok" | "skills" | "skillsSkipped">[],
  degradedRoles: readonly string[] = [],
): RoleSkillsLine[] {
  const out = new Map<string, RoleSkillsLine>();
  for (const r of runs) {
    if (!r.ok) continue;
    const l = out.get(r.role) ?? { role: r.role, used: [], leftOut: [], skipped: [], degraded: false };
    out.set(r.role, l);
    for (const s of r.skills ?? []) {
      l.used = l.used.filter((u) => u.name !== s.name);
      l.leftOut = l.leftOut.filter((n) => n !== s.name);
      if (s.chars > 0) l.used.push({ name: s.name, sha256: s.sha256, chars: s.chars, of: s.of ?? s.chars, truncated: s.truncated });
      else l.leftOut.push(s.name);
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
