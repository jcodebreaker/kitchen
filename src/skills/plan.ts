// One role's skills on one host: what it wants (select.ts), where each is (ready.ts), and what
// is missing. A missing required skill is a blocker the engine halts on before any agent runs;
// a missing optional one is skipped and logged. `readinessLines` is the report `kitchen init`
// and `kitchen skills` print.

import { type Env, enabledPlugins, type Found, findSkill, type Plugin, skillRoots } from "./ready.ts";
import { type Host, installHint, type Registry } from "./registry.ts";
import { type JobFacts, type Selection, selectSkills } from "./select.ts";

export type Missing = { role: string; name: string; why: string; hint: string };
export type RolePlan = {
  role: string;
  found: (Found & { need: "required" | "optional"; why: string })[];
  blockers: Missing[];
  skipped: Missing[];
  refused: Selection["refused"];
};

export function planRole(reg: Registry, role: string, facts: JobFacts, host: Host, env: Env, plugins?: Plugin[]): RolePlan {
  const sel = selectSkills(reg, role, facts);
  const ps = plugins ?? (host === "claude" ? enabledPlugins(env) : []);
  const plan: RolePlan = { role, found: [], blockers: [], skipped: [], refused: sel.refused };
  for (const w of sel.wants) {
    const f = findSkill(w.name, host, env, ps);
    if (f) plan.found.push({ ...f, need: w.need, why: w.why });
    else (w.need === "required" ? plan.blockers : plan.skipped).push({ role, name: w.name, why: w.why, hint: installHint(reg, w.name, host) });
  }
  return plan;
}

/** Where `host` looks, in words, for a "needs you" reason. */
export function placesOf(host: Host, env: Env): string {
  const dirs = skillRoots(host, env).map((r) => r.dir.replace(env.home, "~"));
  return host === "claude" ? `${dirs.join(", ")} and enabled Claude Code plugins` : dirs.join(", ");
}

/** The "needs you" reason for missing required skills. Pure but for `placesOf`. */
export function blockerReason(blockers: Missing[], host: Host, env: Env): string {
  const one = (m: Missing) => `${m.role} needs the skill \`${m.name}\` (${m.why}) on ${host}; install it: ${m.hint}`;
  return `${blockers.map(one).join("; ")}. Kitchen looked in ${placesOf(host, env)} and found no readable SKILL.md. Then answer the job (kitchen feedback) to run it again.`;
}

/** Every skill the registry names, found or not on `host` (`kitchen init`, `kitchen skills`). */
export function readinessLines(reg: Registry, host: Host, env: Env): { lines: string[]; missing: number } {
  const plugins = host === "claude" ? enabledPlugins(env) : [];
  const uses = new Map<string, string[]>();
  for (const [role, e] of Object.entries(reg.roles))
    for (const n of [...e.required.map((r) => r.skill), ...e.picked.map((r) => r.skill), ...e.optional]) {
      const req = e.required.find((r) => r.skill === n);
      const at = req ? [req.kind && `${req.kind.join("/")} tickets`, req.surface?.join("/"), req.risk && `${req.risk.join("/")} risk`].filter(Boolean) : [];
      const tag = `${role} (${req ? `required${at.length ? ` at ${at.join(", ")}` : ""}` : "optional"})`;
      uses.set(n, [...new Set([...(uses.get(n) ?? []), tag])]);
    }
  const lines: string[] = [];
  let missing = 0;
  for (const [n, roles] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
    const f = findSkill(n, host, env, plugins);
    if (!f) missing++;
    lines.push(
      f
        ? `  ok       ${n.padEnd(17)} ${f.where}: ${f.path.replace(env.home, "~")}  [${roles.join(", ")}]`
        : `  missing  ${n.padEnd(17)} [${roles.join(", ")}]  install: ${installHint(reg, n, host)}`,
    );
  }
  return { lines, missing };
}
