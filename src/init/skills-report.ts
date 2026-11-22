// Role skills at `kitchen init` and `kitchen skills` (ADR 0014): where each registry skill comes
// from for the repo's agent tool, or how to install it. A report only: init never fails over it.
import { loadConfig } from "../config.ts";
import { envOf, hostOf } from "../engine/stages/skills.ts";
import { readinessLines } from "../skills/plan.ts";
import { loadRegistry } from "../skills/registry.ts";

/** Every registry skill, found or not: a summary line, then one line per skill. */
export function skillsReport(repo: string): { summary: string; lines: string[] } {
  const host = hostOf(loadConfig(repo));
  if (!host) return { summary: "off (skills.enabled: false, or the fake tool with no skills.host)", lines: [] };
  const r = readinessLines(loadRegistry(), host, envOf(repo));
  const total = r.lines.length;
  return {
    summary: `${total - r.missing} of ${total} found for ${host}${r.missing ? "; the others are skipped, or a job that needs one stops and says how to install it" : ""}`,
    lines: r.lines,
  };
}
