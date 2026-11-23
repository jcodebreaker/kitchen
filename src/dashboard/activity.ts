// What a lane agent did, for the dashboard's Activity tab and a job's live line, read from its own
// event stream: jobs/<id>/activity/*.jsonl, which Kitchen's activity hook (hooks/activity.py) writes in
// Claude Code's stream-json message shapes. Codex `exec --json` events are
// read too. Files are read incrementally: only the bytes added since the last read are parsed.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** One line of activity. `tool` is a call (open while `dur` is null), `res`/`bad` its outcome, `think` a short line of the agent's own text. */
export type Ev = {
  c: "think" | "tool" | "res" | "bad";
  t: string;
  /** tool: the verb shown in the chip (Read, Edit, Bash, Kitchen…) and its target. */
  vb?: string;
  tg?: string;
  /** Edit/Write: lines added and removed. */
  df?: [number, number];
  /** When it happened (ISO), when known. */
  at?: string;
  /** tool: seconds it took; null while it runs. */
  dur?: number | null;
};

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};
type Line = {
  _t?: string;
  timestamp?: string;
  type?: string;
  isSidechain?: boolean;
  message?: { content?: string | Block[] };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    changes?: { path?: string; kind?: string }[];
    server?: string;
    tool?: string;
  };
};

const MAX_EVENTS = 400;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";
const lastLine = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? "";
const lines = (s: unknown) => (typeof s === "string" && s ? s.replace(/\n$/, "").split("\n").length : 0);
const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : ((x as Block)?.text ?? ""))).join("\n") : "";
/** Markdown emphasis and code ticks off a reasoning line. */
const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "");

/** Parses one agent's events into Ev lines. Feed it lines in order; `events` is what it saw so far. Pure. */
export class ActivityParser {
  readonly events: Ev[] = [];
  private readonly open = new Map<string, Ev>();
  /** Absolute path prefixes shown relative (the job's worktree, the repo). */
  private readonly roots: string[];
  constructor(roots: string[] = []) {
    this.roots = roots.filter(Boolean).sort((a, b) => b.length - a.length);
  }

  private rel(p: unknown): string {
    const s = String(p ?? "");
    for (const r of this.roots) if (s.startsWith(`${r}/`)) return s.slice(r.length + 1);
    // A job worktree or Kitchen's own folders, wherever the repo was when the agent ran.
    return s.replace(/^\/.*?\/\.worktrees\/[^/]+\//, "").replace(/^\/.*?\/(\.kitchen\/)/, "$1");
  }

  private push(e: Ev) {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  private tool(id: string | undefined, name: string, input: Record<string, unknown>, at?: string) {
    const e: Ev = { c: "tool", t: name, at, dur: null, ...this.describe(name, input) };
    this.push(e);
    if (id) this.open.set(id, e);
  }

  private describe(name: string, i: Record<string, unknown>): Pick<Ev, "vb" | "tg" | "df"> {
    if (name === "Read") return { vb: "Read", tg: this.rel(i.file_path) };
    if (name === "Write") return { vb: "Write", tg: this.rel(i.file_path), df: [lines(i.content), 0] };
    if (name === "Edit") return { vb: "Edit", tg: this.rel(i.file_path), df: [lines(i.new_string), lines(i.old_string)] };
    if (name === "MultiEdit") {
      const es = (Array.isArray(i.edits) ? i.edits : []) as { old_string?: string; new_string?: string }[];
      return { vb: "Edit", tg: this.rel(i.file_path), df: [es.reduce((a, e) => a + lines(e.new_string), 0), es.reduce((a, e) => a + lines(e.old_string), 0)] };
    }
    if (name === "Bash") return { vb: "Bash", tg: clip(firstLine(String(i.command ?? "")), 200) };
    if (name === "Grep" || name === "Glob") return { vb: name, tg: clip(String(i.pattern ?? ""), 120) };
    if (name === "TodoWrite") return { vb: "Plan", tg: `${Array.isArray(i.todos) ? i.todos.length : 0} items` };
    const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
    if (m) {
      const args = Object.values(i)
        .filter((v) => typeof v === "string" || typeof v === "number")
        .join(" ");
      return { vb: m[1] === "kitchen" ? "Kitchen" : m[1], tg: clip(`${m[2]}${args ? ` ${args}` : ""}`, 160) };
    }
    return { vb: name, tg: clip(JSON.stringify(i), 120) };
  }

  private close(id: string | undefined, at: string | undefined, error: boolean, output: string) {
    const e = id ? this.open.get(id) : undefined;
    if (!e) return;
    if (id) this.open.delete(id);
    e.dur = e.at && at ? Math.max(0, (Date.parse(at) - Date.parse(e.at)) / 1000) : 0;
    if (error) this.push({ c: "bad", t: clip(firstLine(output) || "failed", 140), at });
    else if (e.vb === "Bash" || e.vb === "Kitchen") {
      const l = lastLine(output);
      if (l) this.push({ c: "res", t: clip(l, 120), at });
    }
  }

  feed(text: string) {
    let e: Line;
    try {
      e = JSON.parse(text) as Line;
    } catch {
      return;
    }
    if (e.isSidechain) return;
    const at = e._t ?? e.timestamp;
    const c = e.message?.content;
    if (e.type === "assistant" && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === "text" && b.text?.trim()) this.push({ c: "think", t: clip(plain(firstLine(b.text)), 200), at });
        else if (b.type === "tool_use" && b.name) this.tool(b.id, b.name, b.input ?? {}, at);
      }
    } else if (e.type === "user" && Array.isArray(c)) {
      for (const b of c) if (b.type === "tool_result") this.close(b.tool_use_id, at, !!b.is_error, textOf(b.content));
    } else if (e.item && (e.type === "item.started" || e.type === "item.completed")) this.codex(e.type, e.item, at);
  }

  private codex(kind: string, it: NonNullable<Line["item"]>, at?: string) {
    const done = kind === "item.completed";
    if (it.type === "command_execution") {
      if (!done) return this.tool(it.id, "Bash", { command: String(it.command ?? "").replace(/^\/bin\/\w+ -lc '?([\s\S]*?)'?$/, "$1") }, at);
      if (!this.open.has(it.id ?? "")) this.tool(it.id, "Bash", { command: it.command }, at);
      this.close(it.id, at, (it.exit_code ?? 0) !== 0, it.aggregated_output ?? "");
    } else if (it.type === "mcp_tool_call") {
      if (!done) return this.tool(it.id, `mcp__${it.server}__${it.tool}`, {}, at);
      this.close(it.id, at, it.status === "failed", "");
    } else if (done && it.type === "file_change")
      for (const ch of it.changes ?? []) this.push({ c: "tool", t: "Edit", vb: ch.kind === "add" ? "Write" : "Edit", tg: this.rel(ch.path), at, dur: 0 });
    else if (done && (it.type === "reasoning" || it.type === "agent_message") && it.text?.trim())
      this.push({ c: "think", t: clip(plain(firstLine(it.text)), 200), at });
  }
}

/** `dec` keeps a character split across two reads whole. */
type Cached = { size: number; mtime: number; off: number; rest: string; dec: StringDecoder; p: ActivityParser };
const cache = new Map<string, Cached>();

/** The events in an agent's stream or transcript file, parsing only what was added since the last call. */
export function activityOf(file: string, roots: string[] = []): Ev[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  let c = cache.get(file);
  if (!c || st.size < c.size) {
    c = { size: 0, mtime: 0, off: 0, rest: "", dec: new StringDecoder("utf8"), p: new ActivityParser(roots) };
    cache.set(file, c);
  }
  if (st.size > c.off) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(st.size - c.off);
      fs.readSync(fd, buf, 0, buf.length, c.off);
      c.off = st.size;
      const text = c.rest + c.dec.write(buf);
      const parts = text.split("\n");
      c.rest = parts.pop() ?? "";
      for (const l of parts) if (l.trim()) c.p.feed(l);
    } finally {
      fs.closeSync(fd);
    }
  }
  c.size = st.size;
  c.mtime = st.mtimeMs;
  return c.p.events;
}
