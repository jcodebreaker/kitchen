// kitchen.yaml: schema and defaults (PLAN §6). Committed in the user's repo.
// Unknown keys are refused, so a typo never silently falls back to a default.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ROLES = ["intake", "spec", "builder", "smith", "verifier", "reviewer", "report", "retro", "setup", "maintain"] as const;
export type RoleName = (typeof ROLES)[number];
export const TIERS = ["strong", "medium", "cheap"] as const;
export type ModelTier = (typeof TIERS)[number];

const Path = z
  .object({
    spec: z.enum(["inline", "full"]),
    verify: z.enum(["short", "full", "related-features"]),
    review: z.array(z.string()),
    human: z.literal("always").optional(),
  })
  .strict();
export type RiskPath = z.infer<typeof Path>;

/** A check is a shell command run in the job worktree with the untrusted env (gate, and the builder's `checks` bridge tool). */
const Check = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), run: z.string().min(1), timeout_sec: z.number().int().positive().optional() }).strict(),
]);
export type CheckSpec = { name: string; run: string; timeoutSec: number };

// Default tier → model per tool. Configurable: `agent.models: { strong: …, medium: …, cheap: … }`
// in kitchen.yaml overrides any of them, and a role's `models.<role>` may name a model directly.
// Codex: one generation per map, so `cheap` is never newer or stronger than `strong`. Verified
// 2026-11-22 against `~/.codex/models_cache.json` (Codex CLI 0.171.0), which lists gpt-6-luna
// ("fast and affordable", the newest), gpt-5.6-terra ("balanced") and gpt-5.6-luna ("fast");
// there is no gpt-6 model stronger than luna to put above it. gpt-6-luna ran W0/W1 smokes;
// gpt-5.6-luna ran the W1-fix smoke on fixture A (spikes/w1/results.md).
const DEFAULT_MODELS: Record<"claude" | "codex" | "fake", Record<ModelTier, string>> = {
  claude: { strong: "opus", medium: "sonnet", cheap: "haiku" },
  codex: { strong: "gpt-5.6-terra", medium: "gpt-5.6-terra", cheap: "gpt-5.6-luna" },
  fake: { strong: "fake", medium: "fake", cheap: "fake" },
};

export const ConfigSchema = z
  .object({
    /** The schema version (`kitchen migrate`, src/migrate/migrate.ts CONFIG_VERSION). Absent: 0, before 0.1. */
    version: z.literal(1).optional(),
    concurrency: z.number().int().min(1).max(32).default(2),
    round_limit: z.number().int().min(1).max(20).default(3),
    models: z
      .object({
        intake: z.string().default("strong"),
        spec: z.string().default("strong"),
        builder: z.string().default("strong"),
        smith: z.string().default("strong"),
        verifier: z.string().default("medium"),
        reviewer: z.string().default("medium"),
        report: z.string().default("medium"),
        retro: z.string().default("cheap"),
        /** `kitchen toolkit build`'s setup role (survey, build, fix rounds). */
        setup: z.string().default("medium"),
        /** `kitchen toolkit maintain`: the source wave and the fix pass. */
        maintain: z.string().default("medium"),
      })
      .strict()
      .prefault({}),
    paths: z
      .object({
        low: Path.default({ spec: "inline", verify: "short", review: ["code-if-diff>150"] }),
        medium: Path.default({ spec: "full", verify: "full", review: ["code"] }),
        high: Path.default({ spec: "full", verify: "related-features", review: ["code", "security"], human: "always" }),
      })
      .strict()
      .prefault({}),
    surfaces: z.record(z.string(), z.array(z.string())).default({ ui: ["ux", "ui"], security: ["security"] }),
    high_paths: z.array(z.string()).default(["**/migrations/**", "**/auth/**", "**/*payment*", "infra/**", ".github/**"]),
    /** Seed data and migrations the app every proof drives starts from: a builder diff touching them is high risk and listed for review. */
    seed_paths: z
      .array(z.string())
      .default(["**/migrations/**", "**/migrate/**", "**/seeds/**", "**/*seed*", "**/fixtures/**", "db/**", "**/*.sql", "prisma/**", "**/schema.rb"]),
    risk_floor: z
      .object({ diff_lines_medium: z.number().int().positive().default(300), diff_lines_high: z.number().int().positive().default(1000) })
      .strict()
      .prefault({}),
    automerge: z.enum(["off", "low"]).default("off"),
    protected: z.array(z.string()).default(["kitchen.yaml"]),
    /**
     * The retro (src/retro/): every `every_jobs` finished jobs it mutes a review category for a lens after `mute_after`
     * dismissals (never for the lenses or categories in `never_mute`, never a finding the security veto covers) and files at most `max_tickets` lesson tickets as drafts.
     */
    retro: z
      .object({
        every_jobs: z.number().int().positive().default(5),
        mute_after: z.number().int().positive().default(3),
        max_tickets: z.number().int().min(0).max(10).default(3),
        never_mute: z.array(z.string()).default(["security"]),
        /** The retro reads PR replies (dismissals) only of jobs done within this many days. */
        lookback_days: z.number().int().positive().default(30),
      })
      .strict()
      .prefault({}),
    checks: z.array(Check).default([]),
    /** Checks run under the proof sandbox; true allows the checks themselves outbound network. The filesystem rules stay. */
    checks_network: z.boolean().default(false),
    /**
     * Readies a worktree for the checks and `test` proofs (`npm ci`, `pip install -r requirements.txt`): a fresh
     * job worktree has no node_modules. Run in the worktree under the same sandbox as the checks (always with the network, to download; ADR 0010
     * review H2), before the first check or test proof, and again only when it or a lockfile changes.
     */
    checks_prepare: z.string().min(1).optional(),
    /** How a `test <file>` proof runs, in the job worktree with the untrusted env. `{file}` is the test file, shell-quoted. */
    test_cmd: z.string().min(1).default("npm test -- {file}"),
    agent: z
      .object({
        tool: z.enum(["claude", "codex", "fake"]).default("claude"),
        /** argv prefix that starts the tool, e.g. ["npx", "-y", "@openai/codex@0.171.0"]. Default: `claude` / `codex` on PATH. */
        command: z.array(z.string().min(1)).min(1).optional(),
        /** Tier → model name. Defaults per tool. */
        models: z.object({ strong: z.string(), medium: z.string(), cheap: z.string() }).partial().strict().default({}),
        /** fake only: module whose default export is a FakeScript. Relative to the repo. */
        script: z.string().optional(),
        timeout_sec: z.number().int().positive().default(1800),
        max_turns: z.number().int().positive().default(80),
      })
      .strict()
      .prefault({}),
    backoff: z
      .object({ base_sec: z.number().positive().default(60), max_sec: z.number().positive().default(3600) })
      .strict()
      .prefault({}),
    /**
     * Ready, right after a push: a PR with no checks yet is green only when the repo has no workflow files
     * (.github/workflows); otherwise Ready waits this long for CI to show up before it counts "none" as green.
     */
    ci_grace_sec: z.number().int().nonnegative().default(120),
    /** Report publishing: job folders on the `kitchen-evidence` branch older than this are pruned. */
    evidence_keep_days: z.number().int().positive().default(30),
    /** `kitchen toolkit maintain` runs by itself when the feature-mapped paths changed by more lines than this since the last maintain. */
    maintain_churn_lines: z.number().int().positive().default(300),
    /**
     * done → build from PR review comments (PLAN §2). A comment counts only from a trusted person: a login listed in
     * `trusted`, or one whose association with the repo is in `trust_associations`. Everyone else is ignored.
     */
    feedback: z
      .object({
        trusted: z.array(z.string().min(1)).default([]),
        trust_associations: z.array(z.string().min(1)).default(["OWNER", "MEMBER", "COLLABORATOR"]),
      })
      .strict()
      .prefault({}),
    /** Where PRs, checks and Toolkit tickets live. `local`: no remote (W1/W3a); `fake`: a JSON file, for engine tests. */
    forge: z
      .object({
        kind: z.enum(["local", "fake", "github"]).default("local"),
        file: z.string().optional(),
        /** github: `owner/name`. */
        repo: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .optional(),
        /** github: the URL the engine pushes to and fetches from (default https://github.com/<repo>.git). Always explicit (ADR 0006). */
        url: z.string().optional(),
        /** The branch PRs target and Ready syncs with. */
        base: z.string().default("main"),
      })
      .strict()
      .prefault({}),
    /** Where tickets come from. `prompt`: `kitchen ticket`. `github`: open issues with `label` (the label is the trust boundary). */
    source: z
      .object({
        kind: z.enum(["prompt", "github"]).default("prompt"),
        label: z.string().default("kitchen"),
        /** GitHub logins whose replies on a needs-info issue count, besides the issue's author. */
        operators: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type RawConfig = z.infer<typeof ConfigSchema>;
export type Config = RawConfig & { checkList: CheckSpec[] };

export class ConfigError extends Error {}

/** Pure: parse kitchen.yaml text (empty text = all defaults). */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true, uniqueKeys: true }) ?? {};
  } catch (e) {
    throw new ConfigError(`kitchen.yaml: ${(e as Error).message.split("\n")[0]}`);
  }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ConfigError(`kitchen.yaml: ${first.path.join(".") || "(top)"}: ${first.message}`);
  }
  const checkList = r.data.checks.map((c, i) =>
    typeof c === "string" ? { name: `check${i + 1}`, run: c, timeoutSec: 600 } : { name: c.name, run: c.run, timeoutSec: c.timeout_sec ?? 600 },
  );
  return { ...r.data, checkList };
}

export const configFile = (repo: string) => path.join(repo, "kitchen.yaml");

export function loadConfig(repo: string): Config {
  const f = configFile(repo);
  return parseConfig(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
}

/** The model for a role: its configured tier mapped through the tool's tier table, or a literal model name. */
export function modelFor(cfg: Config, role: string): string {
  const key: RoleName = (ROLES as readonly string[]).includes(role)
    ? (role as RoleName)
    : role.startsWith("review")
      ? "reviewer"
      : role === "maintain-fix"
        ? "smith"
        : role.startsWith("maintain")
          ? "maintain"
          : role === "repro"
            ? "verifier"
            : "builder";
  const want = cfg.models[key];
  return (TIERS as readonly string[]).includes(want) ? tierModel(cfg, want as ModelTier) : want;
}

/** The model a tier maps to for the configured tool. */
export function tierModel(cfg: Config, tier: ModelTier): string {
  return { ...DEFAULT_MODELS[cfg.agent.tool], ...cfg.agent.models }[tier] as string;
}
