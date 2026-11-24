// Choose each lane's model, per tool (ADR 0023). What the tool can run comes from the tool and its providers, never a
// list kept in Kitchen: Claude Code's aliases plus Anthropic's models API when ANTHROPIC_API_KEY is set; Codex's
// providers from ~/.codex/config.toml and each provider's OpenAI-style `GET /models` when it answers. A change is
// written to kitchen.yaml (the tool's profile, comments kept) and applies from the next lane a job starts.
// `check` sends one tiny request per chosen model through the tool itself: it costs a fraction of a cent and nothing
// else in Kitchen runs it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { claudeBin, codexBin } from "../agents/find-bin.ts";
import { type Config, configFile, LANE_ROLES, type LaneRole, loadConfig, modelFor, parseConfig, profileOf, TIERS, TOOLS, type Tool } from "../config.ts";

/** Claude Code's `--model` aliases. */
export const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];
export const LANE_NAMES: Record<LaneRole, string> = { intake: "intake", builder: "build", qa: "QA", reviewer: "review" };
export const TOOL_NAMES: Record<Tool, string> = { claude: "Claude Code", codex: "Codex" };

export type Choice = { id: string; from: string };
export type Listing = {
  tool: Tool;
  at: string;
  /** Each lane: what kitchen.yaml says (a tier or a name) and the model it runs on. */
  lanes: { role: LaneRole; lane: string; want: string; model: string }[];
  tiers: string[];
  choices: Choice[];
  notes: string[];
};
type Fetch = typeof fetch;

/** Pure: the few lines of ~/.codex/config.toml Kitchen reads (model, model_provider, [model_providers.<name>]). */
export function parseCodexConfig(text: string): {
  model?: string;
  provider?: string;
  providers: Record<string, { base_url?: string; env_key?: string; name?: string }>;
} {
  const out: ReturnType<typeof parseCodexConfig> = { providers: {} };
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const l = raw.replace(/\s+#.*$/, "").trim();
    if (!l || l.startsWith("#")) continue;
    const h = /^\[([^\]]+)\]$/.exec(l);
    if (h) {
      section = h[1].trim();
      continue;
    }
    const kv = /^([\w.-]+)\s*=\s*"([^"]*)"$/.exec(l);
    if (!kv) continue;
    const [, k, v] = kv;
    if (section === null) {
      if (k === "model") out.model = v;
      if (k === "model_provider") out.provider = v;
      continue;
    }
    const p = /^model_providers\.("?)([\w.-]+)\1$/.exec(section);
    if (p && ["base_url", "env_key", "name"].includes(k)) (out.providers[p[2]] ??= {})[k as "base_url"] = v;
  }
  return out;
}

const getIds = async (f: Fetch, url: string, headers: Record<string, string>): Promise<string[]> => {
  const r = await f(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = (await r.json()) as { data?: { id?: unknown }[] };
  return (d.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
};

/** What the tool can run, and each lane's choice now. Network only to list models; never a paid request. */
export async function listModels(
  repo: string,
  o: { tool?: Tool; env?: NodeJS.ProcessEnv; fetch?: Fetch; codexHome?: string; cfg?: Config } = {},
): Promise<Listing> {
  const cfg = o.cfg ?? loadConfig(repo);
  const tool = o.tool ?? cfg.agent.tool;
  const env = o.env ?? process.env;
  const f = o.fetch ?? fetch;
  const prof = profileOf(cfg, tool);
  const lanes = LANE_ROLES.map((role) => ({ role, lane: LANE_NAMES[role], want: prof[role], model: modelFor(cfg, role, tool) }));
  const choices: Choice[] = [];
  const notes: string[] = [];
  const add = (id: string, from: string) => {
    if (!choices.some((c) => c.id === id)) choices.push({ id, from });
  };
  if (tool === "claude") {
    for (const a of CLAUDE_ALIASES) add(a, "Claude Code alias");
    if (env.ANTHROPIC_API_KEY) {
      try {
        for (const id of await getIds(f, `${(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "")}/v1/models?limit=100`, {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        }))
          add(id, "Anthropic models API");
      } catch (e) {
        notes.push(`Anthropic's models API didn't answer (${(e as Error).message}): the aliases only`);
      }
    } else notes.push("Set ANTHROPIC_API_KEY to list every model Anthropic serves; the aliases always work");
  } else {
    const home = o.codexHome ?? env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    let cx: ReturnType<typeof parseCodexConfig> = { providers: {} };
    try {
      cx = parseCodexConfig(fs.readFileSync(path.join(home, "config.toml"), "utf8"));
    } catch {
      notes.push(`no ${path.join(home, "config.toml")}: Codex's defaults`);
    }
    if (cx.model) add(cx.model, "~/.codex/config.toml");
    const providers = { ...cx.providers };
    const active = cx.provider ?? "openai";
    if (active === "openai" && !providers.openai) providers.openai = { base_url: "https://api.openai.com/v1", env_key: "OPENAI_API_KEY", name: "OpenAI" };
    for (const [name, p] of Object.entries(providers)) {
      const key = p.env_key ? env[p.env_key] : undefined;
      if (!p.base_url) continue;
      if (p.env_key && !key) {
        notes.push(`${p.name ?? name}: ${p.env_key} isn't set, so its models aren't listed`);
        continue;
      }
      try {
        for (const id of await getIds(f, `${p.base_url.replace(/\/$/, "")}/models`, key ? { authorization: `Bearer ${key}` } : {})) add(id, p.name ?? name);
      } catch (e) {
        notes.push(`${p.name ?? name} didn't answer GET /models (${(e as Error).message})`);
      }
    }
  }
  for (const l of lanes) add(l.model, "kitchen.yaml");
  return { tool, at: new Date().toISOString(), lanes, tiers: [...TIERS], choices, notes };
}

const ROLE_OF: Record<string, LaneRole> = { intake: "intake", build: "builder", builder: "builder", qa: "qa", review: "reviewer", reviewer: "reviewer" };
/** Pure: "review", "reviewer", "build" → the lane role; null for anything else. */
export const roleOf = (s: string): LaneRole | null => ROLE_OF[s.toLowerCase()] ?? null;

/**
 * Set one lane's model in the tool's profile in kitchen.yaml (`models.<tool>.<role>`), keeping the file's comments
 * and order. Refused when the result isn't a kitchen.yaml Kitchen loads. Returns the lane's model now.
 */
export function setModel(repo: string, role: LaneRole, value: string, tool?: Tool): { tool: Tool; role: LaneRole; model: string } {
  const v = value.trim();
  if (!/^[\w.:/@[\]-]{1,100}$/.test(v)) throw new Error(`a model is a tier (${TIERS.join(", ")}) or a model name, got ${JSON.stringify(value)}`);
  const f = configFile(repo);
  const text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  const doc = parseDocument(text);
  const t = tool ?? parseConfig(text).agent.tool;
  if (!TOOLS.includes(t)) throw new Error(`the tool is claude or codex, got ${t}`);
  doc.setIn(["models", t, role], v);
  const next = doc.toString();
  const cfg = parseConfig(next);
  fs.writeFileSync(f, next);
  return { tool: t, role, model: modelFor(cfg, role, t) };
}

export type CheckRun = (argv: string[]) => Promise<{ code: number; out: string }>;
const realRun: CheckRun = (argv) =>
  new Promise((resolve) =>
    execFile(argv[0], argv.slice(1), { timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? Number((err as { code?: unknown }).code) || 1 : 0, out: `${stdout}${stderr}`.trim() }),
    ),
  );

/** Pure: the one tiny request that checks a model answers, through the tool itself. */
export function checkCommand(tool: Tool, model: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return tool === "claude"
    ? [claudeBin(env), "-p", "--model", model, "Reply with the word ok."]
    : [codexBin(env), "exec", "-m", model, "Reply with the word ok."];
}

/** `kitchen models check`: each distinct chosen model, one request each; which answer. */
export async function checkModels(
  repo: string,
  o: { run?: CheckRun; env?: NodeJS.ProcessEnv } = {},
): Promise<{ model: string; lanes: string[]; ok: boolean; why: string }[]> {
  const cfg = loadConfig(repo);
  const tool = cfg.agent.tool;
  const by = new Map<string, string[]>();
  for (const role of LANE_ROLES) {
    const m = modelFor(cfg, role);
    by.set(m, [...(by.get(m) ?? []), LANE_NAMES[role]]);
  }
  const run = o.run ?? realRun;
  const out: { model: string; lanes: string[]; ok: boolean; why: string }[] = [];
  for (const [model, lanes] of by) {
    const r = await run(checkCommand(tool, model, o.env));
    out.push({ model, lanes, ok: r.code === 0, why: r.code === 0 ? "answered" : (r.out.split("\n").pop() ?? `exit ${r.code}`).slice(0, 200) });
  }
  return out;
}
