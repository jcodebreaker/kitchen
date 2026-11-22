// The Toolkit contract (PLAN §2 "Toolkit contract"), as zod schemas: one per
// command's JSON line, `describe` included. `toolkit check` holds every answer
// to these; the drive interpreter stays lenient (W0/W1 Toolkits). Also the
// ```kitchen block of a feature file: which source paths the feature maps to
// (base-change re-proof) and which args `toolkit check` drives it with.
// Pure: no I/O here.
import { z } from "zod";
import { DriveFormatError, extractDriveBlocks, parseDrive, parseFlow, stripComment, type Value } from "../proof/drive-format.ts";

/** Bumped when a command's shape changes; `kitchen migrate` upgrades Toolkits across it. */
export const CONTRACT_VERSION = 1;

/** The generic primitives every Toolkit with a UI has, so drives stay portable (PLAN §2). */
export const WEB_PRIMITIVES = ["read", "open", "reload", "press", "type", "screenshot", "login", "http"] as const;
export const LIFECYCLE = ["prepare", "up", "doctor", "reset", "down", "describe"] as const;
/** A slot reserves this many ports; `ports.needs` must fit in it. */
export const SLOT_PORTS = 20;

const name = z.string().regex(/^[a-z][a-z0-9_-]*$/, "a primitive name is [a-z][a-z0-9_-]*");

export const Primitive = z.union([name, z.object({ name, args: z.record(z.string(), z.string()).optional(), does: z.string().optional() })]);
export const External = z.object({ name: z.string().min(1), mode: z.enum(["mock", "sandbox"]) });

export const Describe = z
  .object({
    status: z.literal("ok").optional(),
    contract: z.literal(CONTRACT_VERSION),
    toolkit: z.string().optional(),
    /** web | cli | api | … : `web` must carry the generic WEB_PRIMITIVES. */
    surface: z.string().optional(),
    lifecycle: z.array(z.string()).optional(),
    primitives: z.array(Primitive).min(1),
    /** Feature files, relative to the Toolkit folder (`features/x.md`), read from `--src`. */
    features: z.array(z.string().regex(/^features\/[^/]+\.md$/, "a feature file is features/<name>.md")),
    seed_users: z.array(z.string()),
    externals: z.array(External),
    ports: z.object({ needs: z.number().int().min(1).max(SLOT_PORTS), order: z.array(z.string()).optional() }),
    parallel: z.boolean(),
  })
  .superRefine((d, ctx) => {
    const names = d.primitives.map((p) => (typeof p === "string" ? p : p.name));
    const lc = names.filter((n) => (LIFECYCLE as readonly string[]).includes(n));
    if (lc.length) ctx.addIssue({ code: "custom", path: ["primitives"], message: `lifecycle commands are not primitives: ${lc.join(", ")}` });
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) ctx.addIssue({ code: "custom", path: ["primitives"], message: `listed twice: ${dup.join(", ")}` });
    if (d.surface === "web") {
      const missing = WEB_PRIMITIVES.filter((p) => !names.includes(p));
      if (missing.length) ctx.addIssue({ code: "custom", path: ["primitives"], message: `a web Toolkit needs the generic primitives; missing ${missing.join(", ")}` });
    }
    if (d.ports.order && d.ports.order.length !== d.ports.needs)
      ctx.addIssue({ code: "custom", path: ["ports", "order"], message: `names ${d.ports.order.length} ports but needs is ${d.ports.needs}` });
  });
export type DescribeOut = z.infer<typeof Describe>;

export const Prepare = z.object({ status: z.literal("ok"), secs: z.number().nonnegative() });
export const Up = z.union([z.object({ status: z.literal("ready"), url: z.string().min(1) }), z.object({ status: z.literal("fail"), why: z.string() })]);
export const Check = z.object({ name: z.string(), ok: z.boolean(), why: z.string().optional() });
export const Doctor = z.object({ status: z.enum(["ok", "fail"]), checks: z.array(Check) });
export const Reset = z.object({ status: z.enum(["ok", "fail"]), why: z.string().optional() });
export const Down = z.object({ status: z.enum(["ok", "fail"]), why: z.string().optional() });
export const PrimitiveOut = z.object({ ok: z.boolean(), out: z.unknown(), files: z.array(z.string()) });

export const SCHEMAS = { prepare: Prepare, up: Up, doctor: Doctor, reset: Reset, down: Down, describe: Describe } as const;
export type Command = keyof typeof SCHEMAS;

/** One command's JSON line against its schema. `null` json = the command printed no JSON line. */
export function validate<C extends Command>(cmd: C, json: unknown): { ok: true; value: z.infer<(typeof SCHEMAS)[C]> } | { ok: false; why: string } {
  if (json === null || json === undefined) return { ok: false, why: `${cmd} printed no JSON line on stdout` };
  const r = SCHEMAS[cmd].safeParse(json);
  if (r.success) return { ok: true, value: r.data as z.infer<(typeof SCHEMAS)[C]> };
  return { ok: false, why: `${cmd}: ${r.error.issues.map((i) => `${i.path.join(".") || "(line)"}: ${i.message}`).join("; ")}` };
}

export const primitiveNames = (d: DescribeOut) => d.primitives.map((p) => (typeof p === "string" ? p : p.name));

// ---------- the ```kitchen block of a feature file ----------

/** What a feature file tells the engine besides its drives. */
export type FeatureMeta = {
  /** Source paths (globs, relative to the repo) this feature lives in: a change there means a full re-proof. */
  paths: string[];
  /** Drives `toolkit check` runs, with concrete args. */
  checks: { drive: string; args: Record<string, string> }[];
};
export type Feature = FeatureMeta & { file: string; drives: { name: string; args: string[]; primitives: string[] }[] };

const CheckLine = z.strictObject({ drive: z.string().min(1), args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}) });

/**
 * Parses one feature file: its drives (the official drive format) and its one
 * ```kitchen block, lines of `key: <flow value>`:
 *   paths: [server.js, "db/**"]
 *   check: { drive: settings.toggle-dark, args: { user: alice } }   (one line per drive to check)
 * Throws DriveFormatError with the line on anything else.
 */
export function parseFeature(file: string, markdown: string): Feature {
  const drives = extractDriveBlocks(markdown).map((b) => parseDrive(b.body, b.line));
  const lines = markdown.split("\n");
  const meta: FeatureMeta = { paths: [], checks: [] };
  let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^```kitchen\s*$/.test(lines[i])) continue;
    if (++blocks > 1) throw new DriveFormatError(`${file}:${i + 1}: more than one kitchen block`);
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) {
      const line = stripComment(lines[i]).trim();
      if (!line) continue;
      const m = /^([a-z]+):\s*(.+)$/.exec(line);
      if (!m) throw new DriveFormatError(`${file}:${i + 1}: expected "paths: […]" or "check: {…}", got ${JSON.stringify(line)}`);
      let v: Value;
      try {
        v = parseFlow(m[2]);
      } catch (e) {
        throw new DriveFormatError(`${file}:${i + 1}: ${(e as Error).message}`);
      }
      if (m[1] === "paths") {
        if (!Array.isArray(v) || !v.every((p) => typeof p === "string" && p && !p.startsWith("/") && !p.split("/").includes("..")))
          throw new DriveFormatError(`${file}:${i + 1}: paths is a list of repo-relative globs`);
        meta.paths.push(...(v as string[]));
      } else if (m[1] === "check") {
        const r = CheckLine.safeParse(v);
        if (!r.success) throw new DriveFormatError(`${file}:${i + 1}: check: ${r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
        const d = drives.find((x) => x.name === r.data.drive);
        if (!d) throw new DriveFormatError(`${file}:${i + 1}: check names drive ${r.data.drive}, which this file doesn't define`);
        const args = Object.fromEntries(Object.entries(r.data.args).map(([k, x]) => [k, String(x)]));
        const missing = d.args.filter((a) => !(a in args));
        if (missing.length) throw new DriveFormatError(`${file}:${i + 1}: check of ${d.name} lacks args ${missing.join(", ")}`);
        meta.checks.push({ drive: d.name, args });
      } else throw new DriveFormatError(`${file}:${i + 1}: unknown key ${m[1]} (paths, check)`);
    }
    if (i >= lines.length) throw new DriveFormatError(`${file}: unclosed kitchen block`);
  }
  // A drive without args needs no check line: it is checked as it is.
  for (const d of drives) if (!d.args.length && !meta.checks.some((c) => c.drive === d.name)) meta.checks.push({ drive: d.name, args: {} });
  return {
    file,
    drives: drives.map((d) => ({ name: d.name, args: d.args, primitives: [...new Set(d.steps.flatMap((s) => (s.kind === "prim" ? [s.name] : [])))] })),
    ...meta,
  };
}

/** Pure: glob (`*` within a segment, `**` across segments) → RegExp over repo-relative paths. */
export function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A plain folder name covers everything under it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** The paths a Toolkit's proof depends on: the Toolkit itself, its fake env, and every feature's mapped paths. */
export function toolkitPaths(features: Pick<Feature, "paths">[]): string[] {
  return [".kitchen/toolkit/**", ".env.kitchen", ...features.flatMap((f) => f.paths)];
}

/** Pure: which changed files touch any of the globs. */
export function touched(changed: string[], globs: string[]): string[] {
  const res = globs.map(globRe);
  return changed.filter((f) => res.some((r) => r.test(f)));
}
