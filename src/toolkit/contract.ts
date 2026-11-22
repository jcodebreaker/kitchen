// The Toolkit contract (PLAN §2 "Toolkit contract"), as zod schemas: one per
// command's JSON line, `describe` included. `toolkit check` holds every answer
// to these; the drive interpreter stays lenient (W0/W1 Toolkits). Also the
// ```kitchen block of a feature file: which source paths the feature maps to
// (base-change re-proof) and which args `toolkit check` drives it with.
// Pure: no I/O here.
import { z } from "zod";
import {
  type Drive,
  DriveFormatError,
  extractDriveBlocks,
  parseDrive,
  parseFlow,
  stripComment,
  substitute,
  type Value,
  varsIn,
} from "../proof/drive-format.ts";

/** Bumped when a command's shape changes; `kitchen migrate` upgrades Toolkits across it. */
export const CONTRACT_VERSION = 1;

/** The generic primitives every Toolkit with a UI has, so drives stay portable (PLAN §2). */
export const WEB_PRIMITIVES = ["read", "open", "reload", "press", "type", "screenshot", "login", "http"] as const;
export const SURFACES = ["web", "cli", "api"] as const;
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
    /** web | cli | api: `web` must carry the generic WEB_PRIMITIVES; web and api `up` give an http(s) url. */
    surface: z.enum(SURFACES),
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
      if (missing.length)
        ctx.addIssue({ code: "custom", path: ["primitives"], message: `a web Toolkit needs the generic primitives; missing ${missing.join(", ")}` });
    }
    if (d.ports.order && d.ports.order.length !== d.ports.needs)
      ctx.addIssue({ code: "custom", path: ["ports", "order"], message: `names ${d.ports.order.length} ports but needs is ${d.ports.needs}` });
  });
export type DescribeOut = z.infer<typeof Describe>;

export const Prepare = z.object({ status: z.literal("ok"), secs: z.number().nonnegative() });
export const Up = z.union([z.object({ status: z.literal("ready"), url: z.string().min(1) }), z.object({ status: z.literal("fail"), why: z.string() })]);
export const Check = z.object({ name: z.string(), ok: z.boolean(), why: z.string().optional() });
export const Doctor = z.object({ status: z.enum(["ok", "fail"]), checks: z.array(Check).min(1, "doctor must run at least one check") });
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

/**
 * Pure: the contract's "exactly one JSON line on stdout" (logs go to stderr).
 * Returns the parsed object, or why the output breaks the rule.
 */
export function oneJsonLine(stdout: string): { ok: true; json: Record<string, unknown> } | { ok: false; why: string } {
  const lines = stdout.split("\n").filter((l) => l.trim());
  if (!lines.length) return { ok: false, why: "printed nothing on stdout (one JSON line expected)" };
  if (lines.length > 1)
    return {
      ok: false,
      why: `printed ${lines.length} lines on stdout (exactly one JSON line; logs go to stderr), first: ${JSON.stringify(lines[0].slice(0, 80))}`,
    };
  try {
    const j = JSON.parse(lines[0]) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) return { ok: true, json: j as Record<string, unknown> };
  } catch {}
  return { ok: false, why: `stdout is not one JSON object: ${JSON.stringify(lines[0].slice(0, 120))}` };
}

/** Pure: `up`'s url for a surface. web and api: an http(s) URL; cli: any absolute URL (a CLI's is often file://…). */
export function upUrlProblem(surface: string, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `url ${JSON.stringify(url)} is not an absolute URL`;
  }
  if (surface !== "cli" && u.protocol !== "http:" && u.protocol !== "https:") return `a ${surface} Toolkit's url must be http(s), got ${JSON.stringify(url)}`;
  return null;
}

// ---------- the contract probe (`toolkit check`, after the drives) ----------

/** One call of the probe: a primitive with args, and what the contract says it must answer. */
export type Probe = {
  primitive: string;
  args: Record<string, Value>;
  /** ok: must answer ok:true; refuse: must not answer ok:true; shape: one valid JSON line is enough. */
  expect: "ok" | "refuse" | "shape";
  why: string;
  /** Append a second --id (a duplicated engine flag): the call must be refused. */
  dupFlag?: boolean;
  /**
   * A primitive no drive uses and no table entry covers: `none` (it declares no args in describe, so
   * called with none it must answer ok:true), or `placeholder` (its declared args, each PLACEHOLDER).
   */
  uncovered?: "none" | "placeholder";
};

/** The value each declared arg of an otherwise uncovered primitive gets in the probe. */
export const PLACEHOLDER = "kitchen-probe";

export const MISSING_TARGET = "#kitchen-probe-missing-element";
/**
 * Safe args for the generic primitives (press and type aim at a missing element: no side effect).
 * `ok` is required only where every Toolkit of that surface can answer it.
 */
const PROBE_TABLE: Record<string, { args: Record<string, Value>; okOn: readonly string[] }> = {
  read: { args: { target: "body" }, okOn: ["web"] },
  open: { args: { path: "/" }, okOn: ["web"] },
  reload: { args: {}, okOn: ["web"] },
  press: { args: { target: MISSING_TARGET }, okOn: [] },
  type: { args: { target: MISSING_TARGET, text: PLACEHOLDER }, okOn: [] },
  screenshot: { args: {}, okOn: ["web"] },
  http: { args: { method: "GET", path: "/" }, okOn: [] },
};
const FOREIGN = ["http://example.invalid/kitchen-probe", "//example.invalid/kitchen-probe"];

/**
 * Pure: the probe calls for a Toolkit. Every primitive in describe once: args
 * from the table, else from the first feature-drive step that calls it with
 * its check line's args substituted. A primitive neither covers is held
 * tighter, so an unimplemented one can't pass on shape alone: with args
 * declared in describe it gets each one as PLACEHOLDER (and must not say "not
 * implemented"); without, it is called with none and must answer ok:true.
 * Then the negative probes:
 * `read` of a missing target is ok:false, `open`/`http` of another origin are
 * refused, a duplicated flag is refused.
 */
export function planProbes(d: DescribeOut, drives: { drive: Drive; args: Record<string, string> }[]): Probe[] {
  const names = primitiveNames(d);
  const probes: Probe[] = [];
  const fromDrives = (name: string): Record<string, Value> | null => {
    for (const { drive, args } of drives)
      for (const s of drive.steps) {
        if (s.kind !== "prim" || s.name !== name) continue;
        // A step that needs a value saved by an earlier step ($invite) can't run alone: try the next.
        if (varsIn(s.args).every((v) => v in args)) return substitute(s.args, args);
      }
    return null;
  };
  const declared = (name: string): string[] => {
    const p = d.primitives.find((x) => (typeof x === "string" ? x : x.name) === name);
    return p && typeof p !== "string" ? Object.keys(p.args ?? {}) : [];
  };
  for (const name of names) {
    const t = PROBE_TABLE[name];
    const used = t ? null : fromDrives(name);
    if (t) probes.push({ primitive: name, args: t.args, expect: t.okOn.includes(d.surface) ? "ok" : "shape", why: `${name} answers` });
    else if (name === "login" && d.seed_users[0]) probes.push({ primitive: name, args: { as: d.seed_users[0] }, expect: "shape", why: "login answers" });
    else if (used) probes.push({ primitive: name, args: used, expect: "shape", why: `${name} answers` });
    else if (declared(name).length)
      probes.push({
        primitive: name,
        args: Object.fromEntries(declared(name).map((a) => [a, PLACEHOLDER])),
        expect: "shape",
        why: `${name} answers its declared args`,
        uncovered: "placeholder",
      });
    else
      probes.push({
        primitive: name,
        args: {},
        expect: "ok",
        why: `${name} is listed in describe, no drive uses it and it declares no args, so called with none it must answer ok:true`,
        uncovered: "none",
      });
  }
  if (names.includes("read"))
    probes.push({ primitive: "read", args: { target: MISSING_TARGET }, expect: "refuse", why: "read of a missing target is ok:false" });
  for (const p of ["open", "http"] as const)
    if (names.includes(p))
      for (const url of FOREIGN)
        probes.push({
          primitive: p,
          args: p === "open" ? { path: url } : { method: "GET", path: url },
          expect: "refuse",
          why: `${p} of another origin (${url}) is refused`,
        });
  const dupOn = names.includes("read") ? "read" : names[0];
  probes.push({ primitive: dupOn, args: PROBE_TABLE[dupOn]?.args ?? {}, expect: "refuse", dupFlag: true, why: "a flag given twice (--id) is refused" });
  return probes;
}

/** Pure: the globs (feature `paths`) that match none of `files`: a typo, or a path that doesn't exist at the base. */
export function unmatchedGlobs(globs: string[], files: string[]): string[] {
  return globs.filter((g) => {
    const re = globRe(g);
    return !files.some((f) => re.test(f));
  });
}

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
  if (!meta.paths.length)
    throw new DriveFormatError(`${file}: no paths: the kitchen block must map the feature to its source (paths: [globs]), so a change there re-proves it`);
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
