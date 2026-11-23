// The role → skill registry (ADR 0014 §1): skills/registry.json, shipped with Kitchen and
// validated here at load. A role names skills that are required (when a rule holds), picked
// (optional, when a rule holds) and optional (always tried); interactive skills are forbidden
// everywhere, and a registry that names one is refused.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const KINDS = ["feature", "bug", "ui", "chore"] as const;
export const SURFACES = ["ui", "security"] as const;
export const RISKS = ["low", "medium", "high"] as const;
export const HOSTS = ["claude", "codex"] as const;
export type Host = (typeof HOSTS)[number];

/** A skill name: bare (`tdd`) or plugin-qualified (`mattpocock-skills:tdd`). Never a path. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$/i;
const Name = z.string().regex(SKILL_NAME, "a skill name is letters, digits, . _ - (optionally plugin:name)");

/** A rule holds when every condition it names holds (kind, surface, risk); one that names none always holds. */
const Rule = z
  .object({
    skill: Name,
    kind: z.array(z.enum(KINDS)).min(1).optional(),
    surface: z.array(z.enum(SURFACES)).min(1).optional(),
    risk: z.array(z.enum(RISKS)).min(1).optional(),
  })
  .strict();
export type Rule = z.infer<typeof Rule>;

const RoleEntry = z
  .object({
    required: z.array(Rule).default([]),
    picked: z.array(Rule.refine((r) => !!(r.kind || r.surface || r.risk), "a picked skill needs a kind, surface or risk")).default([]),
    optional: z.array(Name).default([]),
    /** The ticket's `Skills:` line adds to this role's set. */
    ticket: z.boolean().default(false),
    fallback: z.string().min(1),
    /** A picked skill that is missing makes this role's review degraded (the Report says so). */
    degraded: z.boolean().default(false),
  })
  .strict();
export type RoleEntry = z.infer<typeof RoleEntry>;

const Source = z
  .object({
    about: z.string(),
    /** The Claude Code plugin that ships these skills: a skill of this source is looked up as `<plugin>:<name>` only. */
    plugin: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/i)
      .optional(),
    claude: z.string().min(1),
    codex: z.string().min(1),
  })
  .strict();
const Skill = z
  .object({
    source: z.string().min(1),
    /** Shipped with Kitchen: skills/<vendored>/SKILL.md, the pinned default (a user copy only with skills.use_installed). */
    vendored: z
      .string()
      .regex(/^vendor\/[a-z0-9][a-z0-9._-]*$/)
      .optional(),
  })
  .strict();

export const RegistrySchema = z
  .object({
    version: z.literal(1),
    about: z.string().optional(),
    forbidden: z.array(Name).min(1),
    skills: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "a registry skill has a bare name"), Skill),
    sources: z.record(z.string(), Source),
    roles: z.record(z.string().regex(/^[a-z][a-z-]*$/), RoleEntry),
  })
  .strict()
  .superRefine((r, ctx) => {
    for (const [role, e] of Object.entries(r.roles)) {
      const names = [...e.required.map((x) => x.skill), ...e.picked.map((x) => x.skill), ...e.optional];
      for (const n of names) {
        if (isForbidden(r, n))
          ctx.addIssue({ code: "custom", path: ["roles", role], message: `${n} is interactive (forbidden): unattended roles can't load it` });
        if (!r.skills[bare(n)]) ctx.addIssue({ code: "custom", path: ["roles", role], message: `${n} is not listed under "skills"` });
      }
    }
    for (const [n, s] of Object.entries(r.skills))
      if (!r.sources[s.source]) ctx.addIssue({ code: "custom", path: ["skills", n], message: `source ${s.source} is not listed under "sources"` });
  });
export type Registry = z.infer<typeof RegistrySchema>;

/** Pure: when a rule holds, in words (`kind bug`, `security surface`, `high risk`), "" for always. Shared by selection, the README and the readiness report. */
export const describeRule = (r: Omit<Rule, "skill">) =>
  [r.kind && `kind ${r.kind.join("/")}`, r.surface && `${r.surface.join("/")} surface`, r.risk && `${r.risk.join("/")} risk`].filter(Boolean).join(", ");

/** `plugin:name` → `name`. Pure. */
export const bare = (name: string) => name.slice(name.indexOf(":") + 1);

/** Pure: an interactive skill, by bare name (a plugin prefix doesn't hide one). */
export const isForbidden = (r: Pick<Registry, "forbidden">, name: string) => r.forbidden.includes(bare(name).toLowerCase());

/** Kitchen's shipped skills folder: registry.json and vendor/. */
export const SKILLS_DIR = path.resolve(import.meta.dirname, "..", "..", "skills");
export const REGISTRY_FILE = path.join(SKILLS_DIR, "registry.json");

export class RegistryError extends Error {}

/** Pure: parse and validate registry text. */
export function parseRegistry(text: string): Registry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RegistryError(`skills/registry.json: ${(e as Error).message}`);
  }
  const r = RegistrySchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new RegistryError(`skills/registry.json: ${first.path.join(".") || "(top)"}: ${first.message}`);
  }
  return r.data;
}

let cached: Registry | null = null;
export function loadRegistry(file = REGISTRY_FILE): Registry {
  if (file !== REGISTRY_FILE) return parseRegistry(fs.readFileSync(file, "utf8"));
  cached ??= parseRegistry(fs.readFileSync(file, "utf8"));
  return cached;
}

/** How to install `name` for `host`, from its source (a skill the registry doesn't know: the `local` hint). Pure. */
export function installHint(r: Registry, name: string, host: Host): string {
  const src = r.sources[r.skills[bare(name)]?.source ?? "local"] ?? r.sources.local;
  return (src?.[host] ?? `install a ${bare(name)} skill`).replaceAll("{name}", bare(name));
}
