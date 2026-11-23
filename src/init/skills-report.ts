// Role skills at `kitchen init` and `kitchen skills` (ADR 0014): where each registry skill comes
// from for the repo's agent tool, or how to install it. A report only: init never fails over it.
import { loadConfig } from "../config.ts";
import { envOf, hostOf } from "../skills/forjob.ts";
import { readinessLines } from "../skills/plan.ts";
import { loadRegistry } from "../skills/registry.ts";

/** Every registry skill, found or not: a summary, a short one for init's quiet output, then one line per skill. */
export function skillsReport(repo: string): { summary: string; short: string; lines: string[] } {
  const config = loadConfig(repo);
  const host = hostOf(config);
  if (!host) return { summary: "off (skills.enabled: false)", short: "off", lines: [] };
  const r = readinessLines(loadRegistry(), host, envOf(repo, config));
  const total = r.lines.length;
  const short = `${total - r.missing} of ${total} found`;
  return {
    summary: `${short} for ${host}${r.missing ? "; the others are skipped, or a job that needs one stops and says how to install it" : ""}`,
    short,
    lines: r.lines,
  };
}
