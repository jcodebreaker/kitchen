// Kitchen's guard hooks (ADR 0016 §2), adapted from super-board's (MIT, see NOTICE): `kitchen init` copies the
// scripts into <repo>/.claude/hooks/kitchen/ and merges their entries into <repo>/.claude/settings.json. The merge
// keeps everything already there, never adds a command twice, and backs the file up first when it changes it.
import fs from "node:fs";
import path from "node:path";

export const HOOKS_SRC = path.resolve(import.meta.dirname, "..", "..", "hooks");
export const HOOK_SCRIPTS = [
  "guard-secrets.py",
  "guard-key-literals.py",
  "guard-protected-push.py",
  "guard-delete-outside.py",
  "guard-worktree.py",
  "activity.py",
  "kitchen_jobs.py",
];
export const HOOKS_DIR = path.join(".claude", "hooks", "kitchen");

const cmd = (script: string) => `python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/kitchen/${script}`;
type Entry = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, Entry[]> } & Record<string, unknown>;

/** The entries Kitchen adds, per event. */
export const KITCHEN_HOOKS: Record<string, Entry[]> = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: cmd("guard-protected-push.py") },
        { type: "command", command: cmd("guard-delete-outside.py") },
      ],
    },
    { matcher: "Bash|Read|Grep", hooks: [{ type: "command", command: cmd("guard-secrets.py") }] },
    {
      matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash",
      hooks: [
        { type: "command", command: cmd("guard-key-literals.py") },
        { type: "command", command: cmd("guard-worktree.py") },
      ],
    },
    { matcher: "*", hooks: [{ type: "command", command: cmd("activity.py") }] },
  ],
  PostToolUse: [
    { matcher: "Edit|MultiEdit|Write|NotebookEdit", hooks: [{ type: "command", command: cmd("guard-key-literals.py") }] },
    { matcher: "*", hooks: [{ type: "command", command: cmd("activity.py") }] },
  ],
};

/** Pure: `have` with Kitchen's entries merged in; `added`: how many commands were new. */
export function mergeHooks(have: Settings, add: Record<string, Entry[]> = KITCHEN_HOOKS): { settings: Settings; added: number } {
  const out: Settings = structuredClone(have);
  out.hooks ??= {};
  let added = 0;
  for (const [event, entries] of Object.entries(add)) {
    out.hooks[event] ??= [];
    const list = out.hooks[event];
    const present = new Set(list.flatMap((e) => (e.hooks ?? []).map((h) => h.command)));
    for (const e of entries) {
      const fresh = e.hooks.filter((h) => !present.has(h.command));
      if (!fresh.length) continue;
      const same = list.find((x) => (x.matcher ?? "") === (e.matcher ?? ""));
      if (same) same.hooks = [...(same.hooks ?? []), ...fresh];
      else list.push({ ...(e.matcher !== undefined ? { matcher: e.matcher } : {}), hooks: fresh });
      for (const h of fresh) present.add(h.command);
      added += fresh.length;
    }
  }
  return { settings: out, added };
}

export type HooksResult = { scripts: number; added: number; backup: string | null };

/** Copy the scripts and merge the settings. Idempotent: a second run copies the same bytes and adds nothing. */
export function installHooks(repo: string, now = new Date()): HooksResult {
  const dir = path.join(repo, HOOKS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  let scripts = 0;
  for (const s of HOOK_SCRIPTS) {
    const src = fs.readFileSync(path.join(HOOKS_SRC, s));
    const dst = path.join(dir, s);
    if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(src)) {
      fs.writeFileSync(dst, src, { mode: 0o755 });
      scripts++;
    }
  }
  const file = path.join(repo, ".claude", "settings.json");
  let have: Settings = {};
  if (fs.existsSync(file)) {
    try {
      have = JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
    } catch (e) {
      throw new Error(`.claude/settings.json is not valid JSON (${(e as Error).message}); fix it, then run kitchen init again`);
    }
  }
  const m = mergeHooks(have);
  let backup: string | null = null;
  if (m.added) {
    if (fs.existsSync(file)) {
      backup = `${file}.kitchen-${now.toISOString().replace(/[:.]/g, "-")}.bak`;
      fs.copyFileSync(file, backup);
    }
    fs.writeFileSync(file, `${JSON.stringify(m.settings, null, 2)}\n`);
  }
  return { scripts, added: m.added, backup };
}
