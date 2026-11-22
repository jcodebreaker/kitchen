// Which skills a role loads for a job (ADR 0014 §1, §2). Pure: the registry, the job's kind,
// surfaces and risk, and the ticket's `Skills: a, b` line (outside code fences) go in; the
// role's wanted skills, each required or optional with the reason, come out. Interactive
// skills are refused, whoever names them.
import { bare, isForbidden, type Registry, type Rule, SKILL_NAME } from "./registry.ts";

export type JobFacts = {
  kind: string | null;
  surfaces: readonly string[];
  /** The job's effective risk (the floor included). */
  risk: string;
  /** ticket.md's text. */
  ticket: string;
};

export type Want = { name: string; need: "required" | "optional"; why: string };
export type Selection = { wants: Want[]; refused: { name: string; why: string }[] };

/** Pure: the names on `Skills:` lines of the ticket, outside ``` / ~~~ fences. */
export function ticketSkills(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^\s*(?:[-*]\s+)?(?:\*\*)?skills(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/i.exec(line);
    if (m) out.push(...m[1].split(/[\s,]+/).map((s) => s.replace(/^[`'"]+|[`'".;]+$/g, "")));
  }
  return [...new Set(out.filter(Boolean))];
}

const holds = (r: Rule, f: JobFacts) =>
  (!r.kind || (f.kind !== null && (r.kind as string[]).includes(f.kind))) &&
  (!r.surface || r.surface.some((s) => f.surfaces.includes(s))) &&
  (!r.risk || (r.risk as string[]).includes(f.risk));

const ruleWhy = (r: Rule) =>
  [r.kind && `kind ${r.kind.join("/")}`, r.surface && `${r.surface.join("/")} surface`, r.risk && `${r.risk.join("/")} risk`].filter(Boolean).join(", ");

/** Pure: the skills `role` wants for a job. A role the registry doesn't list wants none. */
export function selectSkills(reg: Registry, role: string, f: JobFacts): Selection {
  const e = reg.roles[role];
  if (!e) return { wants: [], refused: [] };
  const wants: Want[] = [];
  const refused: Selection["refused"] = [];
  const add = (w: Want) => {
    const have = wants.find((x) => bare(x.name) === bare(w.name));
    if (!have) wants.push(w);
    else if (w.need === "required" && have.need === "optional") Object.assign(have, w);
  };
  for (const r of e.required) if (holds(r, f)) add({ name: r.skill, need: "required", why: ruleWhy(r) || "always" });
  for (const r of e.picked) if (holds(r, f)) add({ name: r.skill, need: "optional", why: ruleWhy(r) });
  for (const n of e.optional) add({ name: n, need: "optional", why: "optional" });
  // The ticket only adds: a name it asks for is required (the person asked for it), never removes one.
  if (e.ticket)
    for (const n of ticketSkills(f.ticket)) {
      if (!SKILL_NAME.test(n)) refused.push({ name: n, why: "not a skill name" });
      else if (isForbidden(reg, n)) refused.push({ name: n, why: "interactive: nobody is there to answer its questions" });
      else add({ name: n, need: "required", why: "the ticket's Skills: line" });
    }
  return { wants, refused };
}
