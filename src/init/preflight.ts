// `kitchen init`'s preflight (ADR 0011): before init writes anything, it checks what Kitchen
// needs on this machine and prints one line per tool, ✓ or ✗. Each ✗ comes with the exact
// command that fixes it on this OS. Kitchen never runs those commands itself: it installs
// nothing and signs no one in. The person runs them, and success is judged by checking
// again, never by an installer's exit code.
//
// The sign-in checks are local and free: `claude auth status --json` reads the stored login,
// `codex login status` the stored credentials, `gh auth token` (optional) the stored token (its
// output is never printed or kept). No network, so offline is not "signed out"; never a model call.
import { execFile } from "node:child_process";
import path from "node:path";
import { claudeBin, codexBin, findBin } from "../agents/find-bin.ts";

export type Agent = "claude" | "codex";
export type Check = {
  name: string;
  ok: boolean;
  /** A ✗ on a required check stops init (exit 2). */
  required: boolean;
  detail: string;
  /** The commands that fix it, on this OS; the person runs them. */
  fix: string[];
};
export type Preflight = { checks: Check[]; ok: boolean; ready: Agent[] };
export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (bin: string, args: string[], cwd?: string) => Promise<RunResult>;

export type PreflightOpts = {
  repo: string;
  /** The agent tool kitchen.yaml or --tool names; none: either one will do. `other`: a tool Kitchen doesn't check (fake, agent.command). */
  tool?: Agent | "other";
  /** GitHub pull requests are configured (forge.kind github): gh is required, not optional. */
  ghRequired?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  /** The OS temp folder findBin skips (tests pass another). */
  tmp?: string;
  run?: Runner;
};

export const MIN_NODE = [20, 11] as const;

type Os = "mac" | "linux" | "windows";
const osOf = (p: NodeJS.Platform): Os => (p === "darwin" ? "mac" : p === "win32" ? "windows" : "linux");

/** How to install each tool, per OS. The person runs these; Kitchen only prints them. */
const INSTALL: Record<"node" | "git" | Agent | "gh", Record<Os, string>> = {
  node: {
    mac: "brew install node",
    linux: "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs",
    windows: "winget install OpenJS.NodeJS.LTS",
  },
  git: { mac: "brew install git", linux: "sudo apt-get install -y git", windows: "winget install Git.Git" },
  claude: { mac: "brew install --cask claude-code", linux: "curl -fsSL https://claude.ai/install.sh | bash", windows: "winget install Anthropic.ClaudeCode" },
  codex: { mac: "brew install --cask codex", linux: "npm install -g @openai/codex", windows: "npm install -g @openai/codex" },
  gh: { mac: "brew install gh", linux: "sudo apt-get install -y gh", windows: "winget install GitHub.cli" },
};
const SIGN_IN: Record<Agent | "gh", string[]> = {
  claude: ["claude        then type /login in it, and /exit when it says you're signed in"],
  codex: ["codex login"],
  gh: ["gh auth login"],
};

/** Pure: "22.3.0" ≥ 20.11. */
export function nodeOk(v: string): boolean {
  const [a = 0, b = 0] = v.replace(/^v/, "").split(".").map(Number);
  return a > MIN_NODE[0] || (a === MIN_NODE[0] && b >= MIN_NODE[1]);
}

/** A command, its output, never a shell; a hung one is killed after `secs`. */
export function runCmd(env: NodeJS.ProcessEnv, secs = 10): Runner {
  return (bin, args, cwd) =>
    new Promise((resolve) => {
      execFile(bin, args, { cwd, env, timeout: secs * 1000, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : null) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      }).stdin?.end();
    });
}

const found = (bin: string) => path.isAbsolute(bin);

async function agentCheck(tool: Agent, bin: string, run: Runner, os: Os, required: boolean): Promise<Check> {
  const fixInstall = [INSTALL[tool][os]];
  if (!found(bin)) return { name: tool, ok: false, required, detail: "not found", fix: fixInstall };
  if (tool === "claude") {
    const r = await run(bin, ["auth", "status", "--json"]);
    let j: { loggedIn?: unknown; authMethod?: unknown } | null = null;
    try {
      j = JSON.parse(r.stdout) as { loggedIn?: unknown; authMethod?: unknown };
    } catch {}
    if (j && typeof j.loggedIn === "boolean")
      return j.loggedIn
        ? { name: tool, ok: true, required, detail: `signed in${typeof j.authMethod === "string" ? ` (${j.authMethod})` : ""}`, fix: [] }
        : { name: tool, ok: false, required, detail: "not signed in", fix: SIGN_IN.claude };
    return {
      name: tool,
      ok: false,
      required,
      detail: "can't tell if it is signed in (claude auth status didn't answer)",
      fix: ["claude update", ...SIGN_IN.claude],
    };
  }
  const r = await run(bin, ["login", "status"]);
  if (r.code === 0) return { name: tool, ok: true, required, detail: "signed in", fix: [] };
  return {
    name: tool,
    ok: false,
    required,
    detail: r.code === null ? "can't tell if it is signed in (codex login status didn't answer)" : "not signed in",
    fix: SIGN_IN.codex,
  };
}

export async function preflight(o: PreflightOpts): Promise<Preflight> {
  const env = o.env ?? process.env;
  const os = osOf(o.platform ?? process.platform);
  const run = o.run ?? runCmd(env);
  const nodeV = o.nodeVersion ?? process.versions.node;
  const checks: Check[] = [];
  checks.push(
    nodeOk(nodeV)
      ? { name: "node", ok: true, required: true, detail: nodeV, fix: [] }
      : { name: "node", ok: false, required: true, detail: `${nodeV}: Kitchen needs ${MIN_NODE.join(".")} or newer`, fix: [INSTALL.node[os]] },
  );

  const git = findBin(os === "windows" ? "git.exe" : "git", env.PATH, o.tmp);
  const gitCheck = async (): Promise<Check> => {
    if (!found(git)) return { name: "git", ok: false, required: true, detail: "not found", fix: [INSTALL.git[os]] };
    const v = /(\d+\.\d+(\.\d+)?)/.exec((await run(git, ["--version"])).stdout)?.[1] ?? "";
    const inRepo = (await run(git, ["rev-parse", "--git-dir"], o.repo)).code === 0;
    if (!inRepo)
      return {
        name: "git",
        ok: false,
        required: true,
        detail: `${v} · this folder is not a git repository`,
        fix: ['git init && git add -A && git commit -m "first commit"'],
      };
    const head = (await run(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], o.repo)).code === 0;
    return head
      ? { name: "git", ok: true, required: true, detail: `${v} · the repo has a commit`, fix: [] }
      : { name: "git", ok: false, required: true, detail: `${v} · the repo has no commit yet`, fix: ['git add -A && git commit -m "first commit"'] };
  };

  const tools: Agent[] = o.tool === "claude" || o.tool === "codex" ? [o.tool] : o.tool === "other" ? [] : ["claude", "codex"];
  const binOf = (t: Agent) => (t === "claude" ? claudeBin(env, o.tmp) : codexBin(env, o.tmp));
  const ghBin = findBin(os === "windows" ? "gh.exe" : "gh", env.PATH, o.tmp);
  const ghCheck = async (): Promise<Check> => {
    const required = !!o.ghRequired;
    const why = required ? "" : " (optional: for GitHub pull requests)";
    if (!found(ghBin)) return { name: "gh", ok: false, required, detail: `not found${why}`, fix: [INSTALL.gh[os]] };
    // `gh auth token` reads the stored token, locally (`gh auth status` asks GitHub: offline would read as signed out).
    const r = await run(ghBin, ["auth", "token"]);
    return r.code === 0
      ? { name: "gh", ok: true, required, detail: `signed in${why}`, fix: [] }
      : { name: "gh", ok: false, required, detail: `not signed in${why}`, fix: SIGN_IN.gh };
  };

  const [g, gh, ...agents] = await Promise.all([gitCheck(), ghCheck(), ...tools.map((t) => agentCheck(t, binOf(t), run, os, true))]);
  checks.push(g);
  const ready = agents.filter((c) => c.ok).map((c) => c.name as Agent);
  if (tools.length > 1 && ready.length) {
    // Either tool will do: one ready is enough, and the other is shown without a fix to run.
    for (const c of agents)
      if (!c.ok) {
        c.required = false;
        c.detail = `${c.detail} (not needed: ${ready[0]} is ready)`;
        c.fix = [];
      }
  }
  if (o.tool === "other") checks.push({ name: "agent", ok: true, required: true, detail: "kitchen.yaml starts its own agent tool: not checked", fix: [] });
  checks.push(...agents, gh);
  return { checks, ok: checks.every((c) => c.ok || !c.required), ready };
}

/** Pure: the lines `kitchen init` prints, one per tool, each ✗ followed by its fix. */
export function preflightLines(p: Preflight, resume: string): string[] {
  const out = ["Checking what Kitchen needs…"];
  for (const c of p.checks) {
    out.push(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(8)} ${c.detail}`);
    for (const f of c.fix) out.push(`      ${f}`);
  }
  // An install that worked can still look missing in this shell: its PATH was read before the install.
  if (p.checks.some((c) => !c.ok && /not found/.test(c.detail) && c.fix.length))
    out.push("  After an install, open a new terminal if the command still isn't found (its PATH is read when a terminal starts).");
  if (!p.ok) {
    out.push("");
    out.push("Kitchen needs the ✗ lines not marked optional fixed first. Run the command under each one yourself");
    out.push(`(Kitchen installs nothing and signs no one in), then check again. Resume: ${resume}`);
  }
  return out;
}
