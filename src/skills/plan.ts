// One role's skills on one host: what it wants (select.ts), where each comes from (ready.ts), and
// what is missing. A missing required skill is a blocker the engine halts on before the role runs;
// a missing, ambiguous or person-only optional one is skipped and logged. `readinessLines` is the
// report `kitchen init` and `kitchen skills` print.
import { personOnly } from "./deliver.ts";
import { type Env, enabledPlugins, type Found, findSkill, isFound, type Plugin, placesOf } from "./ready.ts";
import { describeRule, type Host, installHint, type Registry } from "./registry.ts";
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
  const plan: RolePlan = { role, found: [], blockers: [], skipped: [], refused: [...sel.refused] };
  for (const w of sel.wants) {
    const l = findSkill(reg, w.name, host, env, ps);
    if (isFound(l) && personOnly(l.text)) {
      plan.refused.push({ name: l.name, why: "its author marked it for people only (disable-model-invocation: true)" });
      continue;
    }
    if (isFound(l)) {
      plan.found.push({ ...l, need: w.need, why: w.why });
      continue;
    }
    const why = l ? `${w.why}; ambiguous: in plugins ${l.ambiguous.join(" and ")}` : w.why;
    const hint = l ? `disable all but one of ${l.ambiguous.join(", ")}` : installHint(reg, w.name, host);
    (w.need === "required" ? plan.blockers : plan.skipped).push({ role, name: w.name, why, hint });
  }
  return plan;
}

/** The "needs you" reason for missing required skills. */
export function blockerReason(blockers: Missing[], host: Host, env: Env): string {
  const one = (m: Missing) =>
    `${m.role} needs the skill \`${m.name}\` (${m.why}) on ${host}; ${m.hint.startsWith("disable") ? m.hint : `install it: ${m.hint}`}`;
  return `${blockers.map(one).join("; ")}. Kitchen looked in ${placesOf(host, env).join(", ")} and found no usable SKILL.md. Then answer the job (kitchen feedback) to run it again.`;
}

/** Every skill the registry names, found or not on `host` (`kitchen init`, `kitchen skills`). */
export function readinessLines(reg: Registry, host: Host, env: Env): { lines: string[]; missing: number } {
  const plugins = host === "claude" ? enabledPlugins(env) : [];
  const uses = new Map<string, string[]>();
  for (const [role, e] of Object.entries(reg.roles))
    for (const n of [...e.required.map((r) => r.skill), ...e.picked.map((r) => r.skill), ...e.optional]) {
      const req = e.required.find((r) => r.skill === n);
      const tag = `${role} (${req ? `required${describeRule(req) ? ` at ${describeRule(req)}` : ""}` : "optional"})`;
      uses.set(n, [...new Set([...(uses.get(n) ?? []), tag])]);
    }
  const lines: string[] = [];
  let missing = 0;
  for (const [n, roles] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
    const l = findSkill(reg, n, host, env, plugins);
    const at = `[${roles.join(", ")}]`;
    if (isFound(l) && !personOnly(l.text)) lines.push(`  ok       ${n.padEnd(17)} ${l.where}: ${l.path.replace(env.home, "~")}  ${at}`);
    else {
      missing++;
      lines.push(
        isFound(l)
          ? `  refused  ${n.padEnd(17)} ${at}  marked for people only (disable-model-invocation): ${l.path.replace(env.home, "~")}`
          : l
            ? `  ambiguous ${n.padEnd(16)} ${at}  in plugins ${l.ambiguous.join(" and ")}: disable all but one`
            : `  missing  ${n.padEnd(17)} ${at}  install: ${installHint(reg, n, host)}`,
      );
    }
  }
  return { lines, missing };
}
