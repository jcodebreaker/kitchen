// W2 commands (PLAN §4): `kitchen toolkit check`, `kitchen init`, and the setup
// role's bridge `kitchen setup-mcp`. Registered from src/cli.ts with one line, so
// they parse their own flags (`--k v` or `--k=v`; a flag given twice is refused).
import path from "node:path";
import { serveSetupBridge } from "../init/bridge.ts";
import { initCmd } from "../init/init.ts";
import { checkAtRef } from "../toolkit/check.ts";

export type Flags = { flags: Record<string, string | true>; pos: string[] };

export function parseFlags(argv: string[], valued: string[]): Flags {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let v: string | true = true;
    if (eq > 0) v = a.slice(eq + 1);
    else if (valued.includes(k)) {
      v = argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
    }
    if (k in flags) throw new Error(`--${k} given twice`);
    flags[k] = v;
  }
  return { flags, pos };
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

export async function w2(name: string, argv: string[]): Promise<number> {
  const out = (l: string) => console.log(l);
  if (name === "setup-mcp") {
    const { flags } = parseFlags(argv, ["repo", "worktree"]);
    const repo = str(flags.repo);
    const wt = str(flags.worktree);
    if (!repo || !wt) throw new Error("usage: kitchen setup-mcp --repo <dir> --worktree <setup worktree>");
    await serveSetupBridge({ repo: path.resolve(repo), worktree: path.resolve(wt) });
    return 0;
  }
  if (name === "init") {
    const { flags } = parseFlags(argv, ["repo", "answers", "tool", "model", "effort", "max-fix"]);
    for (const k of Object.keys(flags))
      if (!["repo", "answers", "tool", "model", "effort", "max-fix", "yes"].includes(k)) throw new Error(`kitchen init: unknown flag --${k}`);
    return initCmd(
      {
        repo: path.resolve(str(flags.repo) ?? process.cwd()),
        answers: str(flags.answers),
        tool: str(flags.tool) as "claude" | "codex" | undefined,
        model: str(flags.model),
        effort: str(flags.effort),
        maxFix: flags["max-fix"] ? Number(flags["max-fix"]) : undefined,
      },
      out,
    );
  }
  // toolkit check [--feature x] [--src dir] [--rev r]
  const { flags, pos } = parseFlags(argv, ["repo", "feature", "src", "rev"]);
  for (const k of Object.keys(flags)) if (!["repo", "feature", "src", "rev"].includes(k)) throw new Error(`kitchen toolkit: unknown flag --${k}`);
  const repo = path.resolve(str(flags.repo) ?? process.cwd());
  if (pos[0] !== "check") {
    console.error("usage: kitchen toolkit check [--feature <drive|feature>] [--src <worktree>]   (up, down and maintain come later)");
    return 2;
  }
  const r = await checkAtRef(repo, { rev: str(flags.rev), src: str(flags.src), feature: str(flags.feature), print: out });
  return r.ok ? 0 : 1;
}
