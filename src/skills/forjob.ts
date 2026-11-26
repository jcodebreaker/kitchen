// Role skills in a lane (ADR 0014): the skills a lane's role wants for this job, found where the agent tool loads
// them, quoted into the lane's brief (deliver.ts). A required skill that is missing stops the job for a person
// before the lane starts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Job } from "../engine/machine.ts";
import { type Delivered, skillsSection } from "./deliver.ts";
import { blockerReason, planRole } from "./plan.ts";
import type { Env } from "./ready.ts";
import { type Host, loadRegistry } from "./registry.ts";

/** Where the agent tool loads skills, or null when skills are off. */
export function hostOf(config: Config): Host | null {
  if (!config.skills.enabled) return null;
  return config.skills.host ?? config.agent.tool;
}

/** The lookup context: the main checkout's committed skills (never a worktree), the user's home. */
export const envOf = (repo: string, config: Config): Env => ({
  home: os.homedir(),
  repo,
  codexHome: process.env.CODEX_HOME || undefined,
  useInstalled: config.skills.use_installed,
});

/** The registry roles a lane runs as: the review lane is one agent with the lenses this job needs. */
export function rolesFor(lane: string, job: Pick<Job, "risk" | "surfaces">): string[] {
  if (lane === "build") return ["builder"];
  if (lane === "regress") return ["qa"];
  if (lane === "review") {
    const r = ["reviewer-code"];
    if (job.risk === "high" || job.surfaces.includes("security")) r.push("reviewer-security");
    if (job.surfaces.includes("ui")) r.push("reviewer-ui");
    return r;
  }
  return [lane];
}

export type LaneSkills = { text: string; delivered: Delivered[]; names: string[]; skipped: string[]; blocker: string | null };

export function skillsForLane(repo: string, config: Config, job: Job, lane: string): LaneSkills {
  const host = hostOf(config);
  if (!host) return { text: "", delivered: [], names: [], skipped: [], blocker: null };
  const reg = loadRegistry();
  const env = envOf(repo, config);
  const t = path.join(repo, ".kitchen", "jobs", job.id, "ticket.md");
  const facts = { kind: job.kind, surfaces: job.surfaces, risk: job.risk ?? "medium", ticket: fs.existsSync(t) ? fs.readFileSync(t, "utf8") : "" };
  const plans = rolesFor(lane, job).map((r) => planRole(reg, r, facts, host, env));
  const blockers = plans.flatMap((p) => p.blockers);
  if (blockers.length) return { text: "", delivered: [], names: [], skipped: [], blocker: blockerReason(blockers, host, env) };
  const found = plans.flatMap((p) => p.found).filter((f, i, all) => all.findIndex((x) => x.name === f.name) === i);
  const s = skillsSection(found);
  return { text: s.text, delivered: s.delivered, names: found.map((f) => f.name), skipped: plans.flatMap((p) => p.skipped.map((m) => m.name)), blocker: null };
}
