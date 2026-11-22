// The feature-drive format (PLAN §2): a fenced ```drive block inside
// features/<x>.md. It is a deliberately small YAML subset — top-level
// `drive`, `args`, `steps`; each step is one primitive call written as a flow
// mapping, plus an optional `save:`. Built-in controls are only `wait`,
// `retry`, `save` and `$var`. No loops, branches, anchors or code.
import { z } from "zod";

export type Scalar = string | number | boolean;
export type Value = Scalar | Value[] | { [k: string]: Value };

export type PrimStep = { kind: "prim"; name: string; args: Record<string, Value>; save?: string; line: number };
export type WaitStep = {
  kind: "wait";
  text: string;
  target: string;
  attr?: string;
  timeoutMs: number;
  line: number;
};
export type RetryStep = { kind: "retry"; times: number; line: number };
export type Step = PrimStep | WaitStep | RetryStep;
export type Drive = { name: string; args: string[]; steps: Step[] };

export class DriveFormatError extends Error {}

// ---------- flow-value parser ({a: 1, b: [x, "y"]}) ----------

export function parseFlow(src: string): Value {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const fail = (msg: string): never => {
    throw new DriveFormatError(`${msg} at column ${i + 1} in ${JSON.stringify(src)}`);
  };
  const value = (inFlow: boolean): Value => {
    ws();
    const c = src[i];
    if (c === "{") return mapping();
    if (c === "[") return seq();
    if (c === '"' || c === "'") return quoted(c);
    return plain(inFlow);
  };
  const quoted = (q: string): string => {
    i++;
    let s = "";
    while (i < src.length && src[i] !== q) {
      if (q === '"' && src[i] === "\\") {
        const n = src[++i];
        s += n === "n" ? "\n" : n === "t" ? "\t" : n;
      } else s += src[i];
      i++;
    }
    if (src[i] !== q) fail("unterminated string");
    i++;
    return s;
  };
  const plain = (inFlow: boolean): Scalar => {
    const start = i;
    while (i < src.length && !(inFlow && /[,}\]]/.test(src[i]))) i++;
    const raw = src.slice(start, i).trim();
    if (raw === "") fail("empty value");
    if (raw === "true" || raw === "false") return raw === "true";
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return raw;
  };
  const mapping = (): Record<string, Value> => {
    i++;
    const out: Record<string, Value> = {};
    ws();
    if (src[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      ws();
      const start = i;
      while (i < src.length && src[i] !== ":" && !/[,{}[\]]/.test(src[i])) i++;
      const key = src.slice(start, i).trim().replace(/^["']|["']$/g, "");
      if (!key || src[i] !== ":") fail("expected key:");
      i++;
      if (key in out) fail(`duplicate key ${key}`);
      out[key] = value(true);
      ws();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "}") {
        i++;
        return out;
      }
      fail("expected , or }");
    }
  };
  const seq = (): Value[] => {
    i++;
    const out: Value[] = [];
    ws();
    if (src[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(value(true));
      ws();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "]") {
        i++;
        return out;
      }
      fail("expected , or ]");
    }
  };
  const v = value(false);
  ws();
  if (i < src.length) fail("trailing characters");
  return v;
}

/** Drop a `# comment` that is outside quotes and starts the line or follows a space. */
export function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

// ---------- block extraction ----------

/** All ```drive blocks in a markdown file, with the line each body starts on. */
export function extractDriveBlocks(markdown: string): { body: string; line: number }[] {
  const lines = markdown.split("\n");
  const blocks: { body: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^```drive\s*$/.test(lines[i])) {
      const start = i + 1;
      let j = start;
      while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
      if (j === lines.length) throw new DriveFormatError(`unclosed drive block at line ${i + 1}`);
      blocks.push({ body: lines.slice(start, j).join("\n"), line: start + 1 });
      i = j;
    }
  }
  return blocks;
}

// ---------- step schemas ----------

const duration = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?(ms|s)$/)]).transform((d) => {
  if (typeof d === "number") return d * 1000;
  return d.endsWith("ms") ? Number(d.slice(0, -2)) : Number(d.slice(0, -1)) * 1000;
});
const WaitArgs = z.strictObject({
  until: z.strictObject({ text: z.union([z.string(), z.number()]).transform(String), target: z.string().optional(), attr: z.string().optional() }),
  timeout: duration.default(10_000),
});
const RetryArgs = z.strictObject({ times: z.number().int().min(1).max(5), on: z.literal("fail").default("fail") });
const PrimArgs = z.record(z.string(), z.custom<Value>(() => true));
const VAR = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

function zMsg(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
}

// ---------- block parser ----------

export function parseDrive(body: string, firstLine = 1): Drive {
  const lines = body.split("\n").map(stripComment);
  let name: string | undefined;
  let args: string[] = [];
  const raw: { key: string; value: string; save?: string; line: number }[] = [];
  let inSteps = false;
  const err = (n: number, msg: string): never => {
    throw new DriveFormatError(`line ${firstLine + n}: ${msg}`);
  };

  lines.forEach((line, n) => {
    if (!line.trim()) return;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const m = line.match(/^([a-z]+):\s*(.*)$/);
      if (!m) err(n, `expected a top-level key, got ${JSON.stringify(line)}`);
      const [, key, rest] = m!;
      inSteps = false;
      if (key === "drive") {
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(rest)) err(n, "drive name must be lowercase like settings.toggle-dark");
        name = rest;
      } else if (key === "args") {
        const v = parseFlow(rest);
        if (!Array.isArray(v) || !v.every((a) => typeof a === "string" && /^[A-Za-z_]\w*$/.test(a))) err(n, "args must be a list of names");
        args = v as string[];
      } else if (key === "steps") {
        if (rest) err(n, "steps: takes an indented list");
        inSteps = true;
      } else err(n, `unknown top-level key ${key}`);
      return;
    }
    if (!inSteps) err(n, "indented line outside steps:");
    const item = line.trim().match(/^-\s+([a-z][a-z0-9_-]*):\s*(.*)$/);
    if (item) {
      raw.push({ key: item[1], value: item[2], line: firstLine + n });
      return;
    }
    const cont = line.trim().match(/^([a-z]+):\s*(.*)$/);
    if (cont && raw.length) {
      if (cont[1] !== "save") err(n, `only save: may follow a step, got ${cont[1]}:`);
      if (!/^[A-Za-z_]\w*$/.test(cont[2])) err(n, "save: takes a variable name");
      const last = raw[raw.length - 1];
      if (last.save) err(n, "step already has save:");
      last.save = cont[2];
      return;
    }
    err(n, `cannot read ${JSON.stringify(line.trim())}`);
  });

  if (!name) throw new DriveFormatError("drive: name missing");
  if (!raw.length) throw new DriveFormatError("steps: empty");

  const steps: Step[] = raw.map((r, idx): Step => {
    const v = r.value === "" ? {} : parseFlow(r.value);
    if (typeof v !== "object" || Array.isArray(v)) throw new DriveFormatError(`line ${r.line}: ${r.key} takes a { … } mapping`);
    if (r.key === "wait" || r.key === "retry") {
      if (r.save) throw new DriveFormatError(`line ${r.line}: save: only follows a primitive call`);
      if (r.key === "wait") {
        const p = WaitArgs.safeParse(v);
        if (!p.success) throw new DriveFormatError(`line ${r.line}: wait ${zMsg(p.error)}`);
        return { kind: "wait", text: p.data.until.text, target: p.data.until.target ?? "body", attr: p.data.until.attr, timeoutMs: p.data.timeout, line: r.line };
      }
      const p = RetryArgs.safeParse(v);
      if (!p.success) throw new DriveFormatError(`line ${r.line}: retry ${zMsg(p.error)}`);
      if (idx === 0 || raw[idx - 1].key === "retry") throw new DriveFormatError(`line ${r.line}: retry must follow a step`);
      return { kind: "retry", times: p.data.times, line: r.line };
    }
    const p = PrimArgs.safeParse(v);
    if (!p.success) throw new DriveFormatError(`line ${r.line}: ${zMsg(p.error)}`);
    return { kind: "prim", name: r.key, args: p.data, save: r.save, line: r.line };
  });

  // Every $var must be a drive arg or saved by an earlier step.
  const known = new Set(args);
  for (const s of steps) {
    const used = varsIn(s.kind === "prim" ? s.args : s.kind === "wait" ? { text: s.text, target: s.target, attr: s.attr ?? "" } : {});
    for (const u of used) if (!known.has(u)) throw new DriveFormatError(`line ${s.line}: $${u} is not an arg or an earlier save`);
    if (s.kind === "prim" && s.save) known.add(s.save);
  }
  return { name, args, steps };
}

export function varsIn(v: Value): string[] {
  if (typeof v === "string") return [...v.matchAll(VAR)].map((m) => m[1]);
  if (Array.isArray(v)) return v.flatMap(varsIn);
  if (typeof v === "object" && v) return Object.values(v).flatMap(varsIn);
  return [];
}

/** Replace $name in every string with its value. Unknown names throw. */
export function substitute<T extends Value>(v: T, vars: Record<string, string>): T {
  if (typeof v === "string") {
    return v.replace(VAR, (_, n: string) => {
      if (!(n in vars)) throw new DriveFormatError(`$${n} has no value`);
      return vars[n];
    }) as T;
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars)) as T;
  if (typeof v === "object" && v) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, vars)])) as T;
  return v;
}

/** Find one drive in a feature file (by name, or the only one). */
export function loadDrive(markdown: string, name?: string): Drive {
  const drives = extractDriveBlocks(markdown).map((b) => parseDrive(b.body, b.line));
  if (!drives.length) throw new DriveFormatError("no ```drive block in file");
  if (name) {
    const d = drives.find((x) => x.name === name);
    if (!d) throw new DriveFormatError(`no drive named ${name}; have ${drives.map((x) => x.name).join(", ")}`);
    return d;
  }
  if (drives.length > 1) throw new DriveFormatError(`file has ${drives.length} drives; pass a name`);
  return drives[0];
}
