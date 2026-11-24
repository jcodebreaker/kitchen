// kitchen.yaml: schema and defaults (ADR 0016). Committed in the user's repo.
// Unknown keys are refused, so a typo never silently falls back to a default. Keys an older Kitchen wrote
// (the Toolkit, the sandbox, the retro…) are dropped with a note instead, so an old kitchen.yaml keeps working.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** The lanes an agent works in. Each lane's model is a tier (or a model name) the orchestrator passes to its Agent call. */
export const LANE_ROLES = ["intake", "builder", "qa", "reviewer"] as const;
export type LaneRole = (typeof LANE_ROLES)[number];
export const TIERS = ["strong", "medium", "cheap"] as const;
export type ModelTier = (typeof TIERS)[number];

const Check = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      run: z.string().min(1),
      timeout_sec: z.number().int().positive().optional(),
      /** ADR 0021: `build` (default) runs after every Build and on the trial merge; `merge` only on the trial merge. */
      when: z.enum(["build", "merge"]).optional(),
      /** ADR 0021: start the app (`app:`) from the trial merge first and pass its URL in $BASE_URL. Needs `when: merge`. */
      needs_app: z.boolean().optional(),
    })
    .strict(),
]);
export type CheckSpec = { name: string; run: string; timeoutSec: number; when: "build" | "merge"; needsApp: boolean };

const DEFAULT_MODELS: Record<"claude" | "codex", Record<ModelTier, string>> = {
  claude: { strong: "opus", medium: "sonnet", cheap: "haiku" },
  codex: { strong: "gpt-5.6-terra", medium: "gpt-5.6-terra", cheap: "gpt-5.6-luna" },
};

/** How QA starts the app (kitchen init detects it; ADR 0016 §3). `{port}` in start, url and health is the port. */
const App = z
  .object({
    /** The shell command that starts the app in the foreground, from the worktree root. Empty: nothing to start (a library, a CLI). */
    start: z.string().default(""),
    port: z.number().int().min(1).max(65535).optional(),
    /** Where the running app answers. Default http://127.0.0.1:{port}. */
    url: z.string().optional(),
    /** A path (or URL) that answers 2xx/3xx once the app is up. Default "/". */
    health: z.string().default("/"),
    /** Run before the app starts (and between QA runs): put the data back to its seed. */
    reset: z.string().optional(),
    /** Run when the app stops (after the process is ended), e.g. `docker compose down`. Default for a compose app: `docker compose -p <project> down -v`. */
    stop: z.string().optional(),
    /** Seconds to wait for the health check. */
    ready_timeout_sec: z.number().int().positive().default(60),
  })
  .strict();
export type AppConfig = z.infer<typeof App>;

export const ConfigSchema = z
  .object({
    version: z.literal(1).optional(),
    round_limit: z.number().int().min(1).max(20).default(3),
    /** At most this many lane agents at once (the orchestrator's wave width). */
    parallel: z.number().int().min(1).max(16).default(4),
    models: z
      .object({
        intake: z.string().default("strong"),
        builder: z.string().default("strong"),
        qa: z.string().default("medium"),
        reviewer: z.string().default("medium"),
      })
      .strict()
      .prefault({}),
    /** Paths whose change makes a job high risk: it stops at Ready instead of merging into staging. */
    /** ADR 0020 §3. `confirm: true`: every accepted job waits under Needs you, with its criteria, for `kitchen approve`. */
    intake: z
      .object({ confirm: z.boolean().default(false) })
      .strict()
      .prefault({}),
    high_paths: z.array(z.string()).default(["**/migrations/**", "**/auth/**", "**/*payment*", "infra/**", ".github/**", "**/.env*"]),
    checks: z.array(Check).default([]),
    /** Readies a fresh worktree for the checks (`npm ci`): run once per worktree before the first check. */
    checks_prepare: z.string().min(1).optional(),
    /** A frozen install from the lockfile, written by `kitchen init`: the package manager. Runs before `checks_prepare`. */
    checks_install: z.enum(["npm", "pnpm", "yarn", "yarn-classic", "bun"]).optional(),
    app: App.prefault({}),
    /** Auto-merge (ADR 0016 §5): passing jobs merge into `branch`, never into `base` or main. */
    staging: z
      .object({
        branch: z.string().default("staging"),
        /** The branch staging is created from, and the one Kitchen never touches. */
        base: z.string().default("main"),
        /** A change over this many lines stops at Ready for a person. */
        max_lines: z.number().int().positive().default(400),
        /** false: every job stops at Ready. */
        auto_merge: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    agent: z
      .object({
        tool: z.enum(["claude", "codex"]).default("claude"),
        /** argv prefix that starts the orchestrator's tool (`kitchen run`). Default: `claude` found on PATH. */
        command: z.array(z.string().min(1)).min(1).optional(),
        models: z.object({ strong: z.string(), medium: z.string(), cheap: z.string() }).partial().strict().default({}),
        /** `kitchen run`: the headless session's spend cap (claude --max-budget-usd). */
        max_usd: z.number().positive().optional(),
      })
      .strict()
      .prefault({}),
    /** Role skills (ADR 0014). `enabled: false` runs every lane on its role prompt alone. */
    skills: z
      .object({
        enabled: z.boolean().default(true),
        host: z.enum(["claude", "codex"]).optional(),
        use_installed: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .prefault({}),
    /** `github`: jobs merge into staging through a pull request (gh); `local`: a local merge. Default: what init found. */
    forge: z
      .object({
        kind: z.enum(["local", "github"]).default("local"),
        repo: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** Top-level keys an older Kitchen used. Dropped with a note: kitchen.yaml from before ADR 0016 keeps loading. */
export const LEGACY_KEYS = [
  "concurrency",
  "paths",
  "surfaces",
  "seed_paths",
  "risk_floor",
  "automerge",
  "protected",
  "retro",
  "checks_network",
  "test_cmd",
  "backoff",
  "ci_grace_sec",
  "evidence_keep_days",
  "maintain_churn_lines",
  "feedback",
  "source",
];
const LEGACY_MODEL_ROLES = ["spec", "smith", "verifier", "report", "retro", "setup", "maintain"];
const LEGACY_AGENT_KEYS = ["script", "timeout_sec", "max_turns"];

export type RawConfig = z.infer<typeof ConfigSchema>;
export type Config = RawConfig & { checkList: CheckSpec[]; dropped: string[] };

export class ConfigError extends Error {}

/** Pure: drop the keys an older Kitchen wrote, carrying over the ones that still mean something. */
function upgrade(raw: Record<string, unknown>): { raw: Record<string, unknown>; dropped: string[] } {
  const out = { ...raw };
  const dropped: string[] = [];
  for (const k of LEGACY_KEYS)
    if (k in out) {
      delete out[k];
      dropped.push(k);
    }
  const models = out.models as Record<string, unknown> | undefined;
  if (models && typeof models === "object") {
    const m = { ...models };
    if (m.verifier !== undefined && m.qa === undefined) m.qa = m.verifier;
    for (const k of LEGACY_MODEL_ROLES)
      if (k in m) {
        delete m[k];
        dropped.push(`models.${k}`);
      }
    out.models = m;
  }
  const agent = out.agent as Record<string, unknown> | undefined;
  if (agent && typeof agent === "object") {
    const a = { ...agent };
    if (a.tool === "fake") {
      delete a.tool;
      dropped.push("agent.tool: fake");
    }
    for (const k of LEGACY_AGENT_KEYS)
      if (k in a) {
        delete a[k];
        dropped.push(`agent.${k}`);
      }
    out.agent = a;
  }
  const forge = out.forge as Record<string, unknown> | undefined;
  if (forge && typeof forge === "object") {
    const f = { ...forge };
    if (f.kind === "fake") f.kind = "local";
    if (typeof f.base === "string") {
      const st = { ...((out.staging as Record<string, unknown>) ?? {}) };
      st.base ??= f.base;
      out.staging = st;
    }
    for (const k of ["file", "url", "base"])
      if (k in f) {
        delete f[k];
        dropped.push(`forge.${k}`);
      }
    out.forge = f;
  }
  return { raw: out, dropped };
}

/** Pure: parse kitchen.yaml text (empty text = all defaults). */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true, uniqueKeys: true }) ?? {};
  } catch (e) {
    throw new ConfigError(`kitchen.yaml: ${(e as Error).message.split("\n")[0]}`);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("kitchen.yaml: the top level must be a mapping");
  const u = upgrade(raw as Record<string, unknown>);
  const r = ConfigSchema.safeParse(u.raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ConfigError(`kitchen.yaml: ${first.path.join(".") || "(top)"}: ${first.message}`);
  }
  const st = r.data.staging;
  if (st.branch === st.base || ["main", "master"].includes(st.branch))
    throw new ConfigError(`kitchen.yaml: staging.branch is ${st.branch}: Kitchen never merges into ${st.base}, main or master`);
  const checkList: CheckSpec[] = r.data.checks.map((c, i) =>
    typeof c === "string"
      ? { name: `check${i + 1}`, run: c, timeoutSec: 600, when: "build", needsApp: false }
      : { name: c.name, run: c.run, timeoutSec: c.timeout_sec ?? 600, when: c.when ?? "build", needsApp: c.needs_app ?? false },
  );
  const early = checkList.find((c) => c.needsApp && c.when !== "merge");
  if (early)
    throw new ConfigError(
      `kitchen.yaml: checks: ${early.name} has needs_app: true, which only a when: merge check can have (the app starts from the trial merge)`,
    );
  const noApp = checkList.find((c) => c.needsApp) && !r.data.app.start;
  if (noApp) throw new ConfigError("kitchen.yaml: a check has needs_app: true but app.start is empty: say how to start the app, or set needs_app: false");
  return { ...r.data, checkList, dropped: u.dropped };
}

export const configFile = (repo: string) => path.join(repo, "kitchen.yaml");

export function loadConfig(repo: string): Config {
  const f = configFile(repo);
  return parseConfig(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
}

/** The model a lane's agent runs on: its tier mapped through the tool's tier table, or a literal model name. */
export function modelFor(cfg: Config, role: LaneRole): string {
  const want = cfg.models[role];
  return (TIERS as readonly string[]).includes(want) ? tierModel(cfg, want as ModelTier) : want;
}

export function tierModel(cfg: Config, tier: ModelTier): string {
  return { ...DEFAULT_MODELS[cfg.agent.tool], ...cfg.agent.models }[tier] as string;
}

/** The checks that run at a point: `build` after every Build round (and on the trial merge); `merge` all of them. */
export const checksFor = (cfg: Pick<Config, "checkList">, at: "build" | "merge"): CheckSpec[] =>
  at === "merge" ? cfg.checkList : cfg.checkList.filter((c) => c.when === "build");

/** Pure: the app's URL with `{port}` filled in, or null when there is no app to start. */
export function appUrl(app: AppConfig): string | null {
  if (!app.start && !app.url) return null;
  const url = app.url ?? (app.port ? "http://127.0.0.1:{port}" : null);
  return url ? url.replace("{port}", String(app.port ?? "")) : null;
}
