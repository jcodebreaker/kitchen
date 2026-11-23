// The preflight (ADR 0011) against fake PATHs: each tool missing or present, signed in or not,
// the fix line for each OS, and `kitchen init` stopping with exit 2 before it writes anything.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { w2 } from "../cli/toolkit-commands.ts";
import { nodeOk, type PreflightOpts, preflight, preflightLines } from "./preflight.ts";

let root: string;
let repo: string;
let empty: string;
/** findBin skips the OS temp folder (session shims); the fakes live in it, so the tests name another (TMPDIR for w2). */
let tmp = "";
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-preflight-"));
  tmp = path.join(root, "T");
  fs.mkdirSync(tmp);
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync(realGit, ["init", "-q", "-b", "main", repo]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  execFileSync(realGit, ["-C", repo, "add", "-A"]);
  execFileSync(realGit, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "a"]);
  empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  execFileSync(realGit, ["init", "-q", "-b", "main", empty]);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A folder of fake tools: each name → a shell body. `git` is the real one unless given. */
function bins(label: string, tools: Record<string, string>): string {
  const dir = path.join(root, label);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    if (body === "real") fs.symlinkSync(realGit, path.join(dir, name));
    else fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return dir;
}
const CLAUDE_IN = `echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "secret@example.invalid"}'`;
const CLAUDE_OUT = `echo '{"loggedIn": false}'; exit 1`;
const OK = "exit 0";
const NO = "exit 1";

const run = (dir: string, o: Partial<PreflightOpts> = {}) =>
  preflight({ repo, env: { PATH: dir, HOME: root }, platform: "darwin", nodeVersion: "22.3.0", tmp, ...o });
const line = (p: Awaited<ReturnType<typeof preflight>>, name: string) => p.checks.find((c) => c.name === name);

test("everything there and signed in: one ✓ line per tool, nothing to fix, the email never printed", async () => {
  const dir = bins("all", { git: "real", claude: CLAUDE_IN, codex: OK, gh: OK });
  const p = await run(dir, { tool: "claude" });
  assert.equal(p.ok, true);
  assert.deepEqual(
    p.checks.map((c) => [c.name, c.ok]),
    [
      ["node", true],
      ["git", true],
      ["claude", true],
      ["gh", true],
    ],
  );
  const lines = preflightLines(p, "kitchen init");
  assert.match(lines.join("\n"), /✓ claude {3}signed in \(claude\.ai\)/);
  assert.match(lines.join("\n"), /✓ git {6}\d+\.\d+.* · the repo has a commit/);
  assert.ok(!lines.join("\n").includes("secret@"), "no personal details");
  assert.ok(!lines.some((l) => l.includes("Resume")), "nothing to resume");
});

test("claude missing: ✗ with the install line for each OS, required, exit-worthy", async () => {
  const dir = bins("noclaude", { git: "real", gh: OK });
  for (const [platform, fix] of [
    ["darwin", "brew install --cask claude-code"],
    ["linux", "curl -fsSL https://claude.ai/install.sh | bash"],
    ["win32", "winget install Anthropic.ClaudeCode"],
  ] as const) {
    const p = await run(dir, { tool: "claude", platform });
    assert.equal(p.ok, false, platform);
    assert.deepEqual(line(p, "claude"), { name: "claude", ok: false, required: true, detail: "not found", fix: [fix] });
  }
  const lines = preflightLines(await run(dir, { tool: "claude" }), "kitchen init --tool claude");
  assert.match(lines.join("\n"), /✗ claude {3}not found\n {6}brew install --cask claude-code/);
  assert.equal(lines.at(-1), "(Kitchen installs nothing and signs no one in), then check again. Resume: kitchen init --tool claude");
});

test("claude there but not signed in: `claude` then /login; an old claude that can't say: claude update", async () => {
  const p = await run(bins("claude-out", { git: "real", claude: CLAUDE_OUT, gh: OK }), { tool: "claude" });
  assert.equal(p.ok, false);
  assert.equal(line(p, "claude")?.detail, "not signed in");
  assert.match(line(p, "claude")?.fix[0] ?? "", /^claude +then type \/login/);
  const old = await run(bins("claude-old", { git: "real", claude: "echo 'Usage: claude [prompt]'", gh: OK }), { tool: "claude" });
  assert.equal(line(old, "claude")?.ok, false);
  assert.deepEqual(line(old, "claude")?.fix[0], "claude update");
});

test("codex: `codex login status` decides; not signed in → codex login; missing → its install line", async () => {
  const yes = await run(bins("codex-in", { git: "real", codex: '[ "$1 $2" = "login status" ] && exit 0; exit 9', gh: OK }), { tool: "codex" });
  assert.equal(yes.ok, true);
  assert.equal(line(yes, "codex")?.detail, "signed in");
  const no = await run(bins("codex-out", { git: "real", codex: NO, gh: OK }), { tool: "codex" });
  assert.deepEqual(line(no, "codex")?.fix, ["codex login"]);
  const none = await run(bins("codex-none", { git: "real", gh: OK }), { tool: "codex", platform: "linux" });
  assert.deepEqual(line(none, "codex")?.fix, ["npm install -g @openai/codex"]);
});

test("no tool named: either one ready is enough; the other is shown without a fix; neither → both fixes", async () => {
  const only = await run(bins("only-codex", { git: "real", codex: OK, gh: OK }));
  assert.equal(only.ok, true);
  assert.deepEqual(only.ready, ["codex"]);
  assert.deepEqual(line(only, "claude"), { name: "claude", ok: false, required: false, detail: "not found (not needed: codex is ready)", fix: [] });
  const both = await run(bins("both", { git: "real", claude: CLAUDE_IN, codex: OK, gh: OK }));
  assert.deepEqual(both.ready, ["claude", "codex"]);
  const neither = await run(bins("neither", { git: "real", gh: OK }));
  assert.equal(neither.ok, false);
  assert.deepEqual(
    neither.checks.filter((c) => !c.ok).map((c) => [c.name, c.required, c.fix.length]),
    [
      ["claude", true, 1],
      ["codex", true, 1],
    ],
  );
  // A tool Kitchen doesn't start itself (fake, agent.command): not checked.
  const other = await run(bins("other", { git: "real", gh: OK }), { tool: "other" });
  assert.equal(other.ok, true);
  assert.match(line(other, "agent")?.detail ?? "", /not checked/);
});

test("node older than 20.11, git missing, a repo with no commit: each ✗ and required", async () => {
  assert.equal(nodeOk("20.11.0"), true);
  assert.equal(nodeOk("v21.0.1"), true);
  assert.equal(nodeOk("20.10.9"), false);
  assert.equal(nodeOk("18.19.0"), false);
  const p = await run(bins("old-node", { git: "real", claude: CLAUDE_IN, gh: OK }), { tool: "claude", nodeVersion: "18.19.0", platform: "win32" });
  assert.equal(p.ok, false);
  assert.deepEqual(line(p, "node")?.fix, ["winget install OpenJS.NodeJS.LTS"]);
  const noGit = await run(bins("no-git", { claude: CLAUDE_IN, gh: OK }), { tool: "claude", platform: "linux" });
  assert.deepEqual(line(noGit, "git"), { name: "git", ok: false, required: true, detail: "not found", fix: ["sudo apt-get install -y git"] });
  const noCommit = await run(bins("git-only", { git: "real", claude: CLAUDE_IN, gh: OK }), { tool: "claude", repo: empty });
  assert.equal(noCommit.ok, false);
  assert.match(line(noCommit, "git")?.detail ?? "", /no commit yet/);
  assert.deepEqual(line(noCommit, "git")?.fix, ['git add -A && git commit -m "first commit"']);
  const notRepo = await run(bins("git-only2", { git: "real", claude: CLAUDE_IN, gh: OK }), { tool: "claude", repo: root });
  assert.match(line(notRepo, "git")?.detail ?? "", /not a git repository/);
});

test("gh is optional: missing or signed out it is ✗ with its fix, and init goes on; required once kitchen.yaml opens PRs", async () => {
  const signedOut = await run(bins("gh-out", { git: "real", claude: CLAUDE_IN, gh: NO }), { tool: "claude" });
  assert.equal(signedOut.ok, true);
  assert.deepEqual(line(signedOut, "gh"), {
    name: "gh",
    ok: false,
    required: false,
    detail: "not signed in (optional: for GitHub pull requests)",
    fix: ["gh auth login"],
  });
  const missing = await run(bins("gh-none", { git: "real", claude: CLAUDE_IN }), { tool: "claude" });
  assert.equal(missing.ok, true);
  assert.deepEqual(line(missing, "gh")?.fix, ["brew install gh"]);
  const forge = await run(bins("gh-none2", { git: "real", claude: CLAUDE_IN }), { tool: "claude", ghRequired: true });
  assert.equal(forge.ok, false);
});

test("kitchen init with claude missing: the lines, exit 2, and nothing written; fixed, the same command goes on", async () => {
  const dir = path.join(root, "init-repo");
  fs.cpSync(repo, dir, { recursive: true });
  const prev = { PATH: process.env.PATH, bin: process.env.KITCHEN_CLAUDE_BIN, home: process.env.KITCHEN_HOME, tmp: process.env.TMPDIR };
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((l: string) => printed.push(String(l)));
  try {
    delete process.env.KITCHEN_CLAUDE_BIN;
    process.env.KITCHEN_HOME = path.join(root, "home");
    process.env.TMPDIR = tmp;
    process.env.PATH = bins("init-missing", { git: "real", gh: OK });
    assert.equal(await w2("init", ["--repo", dir, "--tool", "claude"]), 2, printed.join("\n"));
    assert.match(printed.join("\n"), /✗ claude {3}not found/);
    assert.match(printed.join("\n"), new RegExp(`Resume: kitchen init --tool claude --repo ${dir}`));
    assert.deepEqual(fs.readdirSync(dir).sort(), [".git", "a.txt"], "nothing written before the preflight passes");
    // The person installs it; the re-check, not an installer's exit code, decides.
    fs.writeFileSync(path.join(process.env.PATH, "claude"), `#!/bin/sh\n${CLAUDE_IN}\n`, { mode: 0o755 });
    printed.splice(0);
    assert.equal(await w2("init", ["--repo", dir, "--tool", "claude"]), 0, printed.join("\n"));
    assert.match(printed.join("\n"), /✓ claude {3}signed in/);
    assert.ok(fs.existsSync(path.join(dir, "kitchen.yaml")));
  } finally {
    log.mockRestore();
    process.env.PATH = prev.PATH;
    if (prev.tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev.tmp;
    if (prev.bin === undefined) delete process.env.KITCHEN_CLAUDE_BIN;
    else process.env.KITCHEN_CLAUDE_BIN = prev.bin;
    if (prev.home === undefined) delete process.env.KITCHEN_HOME;
    else process.env.KITCHEN_HOME = prev.home;
  }
});

/** Runs `w2` with this PATH and nothing else of the person's: no KITCHEN_CLAUDE_BIN, a TMPDIR the fakes aren't in. */
async function withPath<T>(dir: string, fn: (printed: string[]) => Promise<T>): Promise<T> {
  const prev = {
    PATH: process.env.PATH,
    KITCHEN_CLAUDE_BIN: process.env.KITCHEN_CLAUDE_BIN,
    KITCHEN_HOME: process.env.KITCHEN_HOME,
    TMPDIR: process.env.TMPDIR,
  };
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((l: string) => printed.push(String(l)));
  try {
    delete process.env.KITCHEN_CLAUDE_BIN;
    process.env.KITCHEN_HOME = path.join(root, "home");
    process.env.TMPDIR = tmp;
    process.env.PATH = dir;
    return await fn(printed);
  } finally {
    log.mockRestore();
    for (const [k, v] of Object.entries(prev))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

test("a first kitchen init, both tools signed in: no 'stopped last time' line, and nobody is asked anything without a terminal", async () => {
  const dir = path.join(root, "first-init");
  fs.cpSync(repo, dir, { recursive: true });
  const bin = bins("both-ready", { git: "real", claude: CLAUDE_IN, codex: OK, gh: OK });
  await withPath(bin, async (printed) => {
    assert.equal(await w2("init", ["--repo", dir]), 0, printed.join("\n"));
    const text = printed.join("\n");
    assert.doesNotMatch(text, /stopped last time|Continu|Which agent/, text);
    assert.match(text, /Wrote kitchen\.yaml +agent claude/, "the recommended tool, taken without a question");
    // And the run after it, which finished, doesn't say it stopped either.
    printed.splice(0);
    assert.equal(await w2("init", ["--repo", dir]), 0);
    assert.doesNotMatch(printed.join("\n"), /stopped last time/);
  });
});

test("gh is checked with `gh auth token` (local, offline-safe), never `gh auth status`; an install fix says to open a new terminal", async () => {
  const onlyToken = bins("gh-token", { git: "real", claude: CLAUDE_IN, gh: '[ "$1 $2" = "auth token" ] && { echo gho_secret; exit 0; }; exit 9' });
  const p = await run(onlyToken, { tool: "claude" });
  assert.equal(line(p, "gh")?.ok, true);
  assert.ok(!preflightLines(p, "kitchen init").join("\n").includes("gho_secret"), "the token is never printed");
  const missing = preflightLines(await run(bins("hint-missing", { git: "real", gh: OK }), { tool: "claude" }), "kitchen init").join("\n");
  assert.match(missing, /open a new terminal if the command still isn't found/);
  const signedOut = preflightLines(await run(bins("hint-out", { git: "real", claude: CLAUDE_OUT, gh: OK }), { tool: "claude" }), "kitchen init").join("\n");
  assert.doesNotMatch(signedOut, /new terminal/, "a sign-in needs no new terminal");
});
