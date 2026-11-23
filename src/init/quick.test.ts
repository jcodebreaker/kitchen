// Quick init (ADR 0010) on fixture copies: seconds, no agent when the checks are obvious,
// no worktree, no Toolkit; and `init --toolkit` is quick init followed by `toolkit build`.
// The agent is the fake adapter throughout.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import type { AgentAdapter } from "../agents/adapter.ts";
import { FakeAdapter } from "../agents/fake.ts";
import { w2 } from "../cli/toolkit-commands.ts";
import { loadConfig } from "../config.ts";
import { readInitState } from "./build.ts";
import { checksRecord, quickInit, readQuickRecord } from "./quick.ts";

const KITCHEN = path.resolve(import.meta.dirname, "..", "..");
let root: string;
const prevHome = process.env.KITCHEN_HOME;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-quick-"));
  process.env.KITCHEN_HOME = path.join(root, "home");
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

/** fixtures/<name> (or the given files) as a fresh one-commit repo. */
function repo(label: string, from: string | Record<string, string>, yaml?: string): string {
  const dir = path.join(root, label);
  if (typeof from === "string") fs.cpSync(path.join(KITCHEN, "fixtures", from), dir, { recursive: true });
  else
    for (const [f, text] of Object.entries(from)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
  if (yaml) fs.writeFileSync(path.join(dir, "kitchen.yaml"), yaml);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

const noAgent = async (): Promise<AgentAdapter> => {
  throw new Error("no agent may run when the checks are obvious");
};

test("quick init on fixture E: kitchen.yaml with its checks, the skill, .gitignore, the checks run once; no agent, worktree or Toolkit", async () => {
  const dir = repo("e-library", "e-library");
  const lines: string[] = [];
  const t0 = Date.now();
  assert.equal(await quickInit({ repo: dir, agent: noAgent }, (l) => lines.push(l)), 0);
  assert.ok(Date.now() - t0 < 30_000, "seconds, not minutes");
  const cfg = loadConfig(dir);
  assert.deepEqual(
    cfg.checkList.map((c) => c.run),
    ["npm test"],
  );
  assert.equal(cfg.agent.tool, "claude");
  for (const f of [".claude/skills/kitchen/SKILL.md", ".agents/skills/kitchen/SKILL.md"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.worktrees\/$/m);
  const rec = readQuickRecord(dir);
  assert.equal(rec?.found, "files");
  assert.deepEqual(
    rec?.results.map((r) => [r.name, r.ok]),
    [["test", true]],
  );
  assert.match(rec?.results[0].tail ?? "", /pass 4/, "the fixture's real tests ran");
  // What quick init must never do.
  assert.equal(fs.existsSync(path.join(dir, ".worktrees")), false, "no worktree");
  assert.equal(fs.existsSync(path.join(dir, ".kitchen", "toolkit")), false, "no Toolkit");
  assert.equal(fs.existsSync(path.join(dir, ".env.kitchen")), false);
  assert.equal(readInitState(dir), null, "no Toolkit build state");
  assert.equal(git(dir, "branch", "--list", "kitchen/*"), "", "no kitchen/setup branch");
  // Quiet: one line per phase, a total, the next step.
  assert.match(lines.join("\n"), /… Running test \(npm test\)…\n.*✓ Ran the checks +test passed on main/);
  assert.match(lines.join("\n"), /Done in [\d.]+s · no agent/);
  assert.match(lines.join("\n"), /Installed the skill .* · role skills: \d+ of \d+ found \(kitchen skills\)/, "the role skills report rides on the skill line");
  assert.match(lines.join("\n"), /kitchen toolkit build \(about 3–15 min\)/);
  assert.ok(lines.length <= 10, lines.join("\n"));
});

test("quick init on fixture B (Python): unittest found without an agent; a second run keeps kitchen.yaml and re-runs the checks", async () => {
  const dir = repo("b-cli", "b-cli");
  assert.equal(await quickInit({ repo: dir, agent: noAgent }, () => {}), 0);
  assert.deepEqual(
    loadConfig(dir).checkList.map((c) => c.run),
    ["python3 -m unittest discover -s tests"],
  );
  assert.equal(loadConfig(dir).test_cmd, "python3 -m unittest {file}");
  assert.equal(readQuickRecord(dir)?.results[0].ok, true, String(readQuickRecord(dir)?.results[0].tail));
  const yaml = fs.readFileSync(path.join(dir, "kitchen.yaml"), "utf8");
  const lines: string[] = [];
  assert.equal(await quickInit({ repo: dir, agent: noAgent }, (l) => lines.push(l)), 0);
  assert.equal(fs.readFileSync(path.join(dir, "kitchen.yaml"), "utf8"), yaml, "kept as it is");
  assert.match(lines.join("\n"), /Kept kitchen.yaml +agent claude · 1 check kept from kitchen.yaml/);
});

const proposal = () => new FakeAdapter(() => ({ file: "CHECK: ci | sh ci.sh\nPREPARE: none\nTEST_CMD: none\n", line: "1 check" }));
const ODD = { "README.md": "Run ./ci.sh before pushing.\n", "ci.sh": `#!/bin/sh\ntouch ran-ci\necho ok\n` };

test("nothing obvious, no terminal: one short read-only agent call; its checks go in commented out and never run (review H1)", async () => {
  const dir = repo("odd", ODD);
  const fake = proposal();
  const lines: string[] = [];
  assert.equal(await quickInit({ repo: dir, agent: async () => fake }, (l) => lines.push(l)), 0);
  assert.equal(fake.calls.length, 1);
  const req = fake.calls[0];
  assert.equal(req.tier, "read");
  assert.equal(req.model, "haiku", "the cheap tier on Claude");
  assert.equal(req.bridge, undefined);
  assert.ok(req.timeoutSec <= 180 && req.maxTurns <= 15, "short");
  assert.deepEqual(loadConfig(dir).checkList, [], "not used");
  assert.match(fs.readFileSync(path.join(dir, "kitchen.yaml"), "utf8"), /^# {3}- \{ name: "ci", run: "sh ci.sh" \}$/m);
  assert.equal(fs.existsSync(path.join(dir, "ran-ci")), false, "never run");
  assert.equal(readQuickRecord(dir)?.found, "proposed");
  const text = lines.join("\n");
  assert.match(text, /proposes these checks[\s\S]*ci: sh ci.sh/);
  assert.match(text, /in kitchen.yaml commented out/);
  // A re-run doesn't pay for the agent again (review M7).
  const again = proposal();
  const more: string[] = [];
  await quickInit({ repo: dir, agent: async () => again }, (l) => more.push(l));
  assert.equal(again.calls.length, 0);
  assert.match(more.join("\n"), /proposed last time are in kitchen.yaml, commented out/);
});

test("nothing obvious, in a terminal: shown and asked; yes runs them, under the sandbox; no keeps them commented out", async () => {
  const yes = repo("odd-yes", ODD);
  const asked: string[] = [];
  const lines: string[] = [];
  const code = await quickInit(
    {
      repo: yes,
      agent: async () => proposal(),
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
    },
    (l) => lines.push(l),
  );
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(asked, ["Use these checks? [y/N] "], "the default is no (review R8)");
  assert.deepEqual(
    loadConfig(yes).checkList.map((c) => c.run),
    ["sh ci.sh"],
  );
  assert.equal(readQuickRecord(yes)?.found, "agent");
  assert.ok(fs.existsSync(path.join(yes, "ran-ci")), "it ran, once accepted");
  assert.match(lines.join("\n"), /… Running ci \(sh ci.sh\)…/);
  assert.match(lines.join("\n"), /1 check proposed by an agent, accepted/);
  const no = repo("odd-no", ODD);
  await quickInit({ repo: no, agent: async () => proposal(), confirm: async () => false }, () => {});
  assert.deepEqual(loadConfig(no).checkList, []);
  assert.equal(fs.existsSync(path.join(no, "ran-ci")), false);
});

test("a failed agent call says why (review M6), is recorded as agent-failed, and the next run asks again (review R4)", async () => {
  const dir = repo("odd-fail", ODD);
  const lines: string[] = [];
  const broken = new FakeAdapter(() => ({ ok: false, line: "claude: not logged in" }));
  assert.equal(await quickInit({ repo: dir, agent: async () => broken }, (l) => lines.push(l)), 0);
  assert.match(lines.join("\n"), /The agent call to find the checks failed: claude: not logged in/);
  assert.match(lines.join("\n"), /✗ Kept kitchen.yaml|✗ Wrote kitchen.yaml/);
  assert.equal(readQuickRecord(dir)?.found, "agent-failed");
  assert.equal(readQuickRecord(dir)?.agent?.error, "claude: not logged in");
  const again = proposal();
  await quickInit({ repo: dir, agent: async () => again }, () => {});
  assert.equal(again.calls.length, 1, "asked again");
  assert.equal(readQuickRecord(dir)?.found, "proposed");
});

test("Enter (or anything but y) at the question keeps proposed checks unused (review R8)", async () => {
  for (const answer of ["", "n", "sure"]) {
    const dir = repo(`odd-enter-${answer || "empty"}`, ODD);
    const { terminalAnswer } = await import("../cli/toolkit-commands.ts");
    const yes = terminalAnswer(answer);
    await quickInit({ repo: dir, agent: async () => proposal(), confirm: async () => yes }, () => {});
    assert.deepEqual(loadConfig(dir).checkList, [], JSON.stringify(answer));
  }
  const { terminalAnswer } = await import("../cli/toolkit-commands.ts");
  assert.equal(terminalAnswer("y"), true);
  assert.equal(terminalAnswer(" YES "), true);
});

test("unsafe scripts are named when they are left out (review R6)", async () => {
  const dir = repo("fixy", { "package.json": JSON.stringify({ scripts: { lint: "eslint . --fix", test: "node --test" } }) });
  const lines: string[] = [];
  await quickInit({ repo: dir, agent: noAgent }, (l) => lines.push(l));
  assert.match(lines.join("\n"), /skipped lint \(`eslint \. --fix` changes files\)/);
  assert.deepEqual(
    loadConfig(dir).checkList.map((c) => c.run),
    ["npm test"],
  );
});

test("after a lockfile is committed, a re-run adds just checks_install and doesn't repeat the stale 'no lockfile' (review R3)", async () => {
  const dir = repo("later-lock", { "package.json": JSON.stringify({ scripts: { test: "test -d node_modules" }, dependencies: { leftpad: "1" } }) });
  const first: string[] = [];
  await quickInit({ repo: dir, agent: noAgent }, (l) => first.push(l));
  assert.match(first.join("\n"), /no lockfile to install them from/);
  // The person edits kitchen.yaml's checks, then commits a lockfile.
  const yaml = fs.readFileSync(path.join(dir, "kitchen.yaml"), "utf8");
  fs.writeFileSync(path.join(dir, "kitchen.yaml"), yaml.replace('run: "npm test"', 'run: "npm test --silent"'));
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "lockfile");
  const again: string[] = [];
  await quickInit({ repo: dir, agent: noAgent }, (l) => again.push(l));
  const cfg = loadConfig(dir);
  assert.equal(cfg.checks_install, "npm");
  assert.deepEqual(
    cfg.checkList.map((c) => c.run),
    ["npm test --silent"],
    "the person's checks kept",
  );
  assert.match(again.join("\n"), /checks_install: npm added/);
  assert.doesNotMatch(again.join("\n"), /no lockfile/);
  // A third run adds nothing more.
  const before = fs.readFileSync(path.join(dir, "kitchen.yaml"), "utf8");
  await quickInit({ repo: dir, agent: noAgent }, () => {});
  assert.equal(fs.readFileSync(path.join(dir, "kitchen.yaml"), "utf8"), before);
});

test("checks run under Gate's sandbox, with CI=1: they can't write outside the checkout", async (t) => {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) return t.skip();
  const outside = path.join(root, "outside-marker");
  const dir = repo("boxed", { "package.json": JSON.stringify({ scripts: { test: `test "$CI" = 1 && touch inside && touch ${outside}` } }) });
  const lines: string[] = [];
  assert.equal(await quickInit({ repo: dir, agent: noAgent }, (l) => lines.push(l)), 1);
  assert.ok(fs.existsSync(path.join(dir, "inside")), "CI=1 was set and the checkout is writable");
  assert.equal(fs.existsSync(outside), false, "nothing written outside the checkout");
  assert.equal(readQuickRecord(dir)?.results[0].sandboxed, true);
});

test("checks that fail on the base: said plainly, the failing output shown, exit 1 and no 'kitchen ticket' next step (review M6)", async () => {
  const dir = repo("red", { "package.json": JSON.stringify({ scripts: { test: "echo 'expected 2, got 3' && exit 1" } }) });
  const lines: string[] = [];
  assert.equal(await quickInit({ repo: dir, agent: noAgent }, (l) => lines.push(l)), 1);
  const text = lines.join("\n");
  assert.match(text, /✗ Ran the checks +test FAILED \(exit 1\)/);
  assert.match(text, /\| expected 2, got 3/);
  assert.match(text, /Gate runs these checks on every job, so every job would fail them/);
  assert.match(text, /Next: fix them/);
  assert.doesNotMatch(text, /kitchen ticket/);
  assert.equal(JSON.parse(fs.readFileSync(checksRecord(dir), "utf8")).results[0].ok, false);
  assert.ok(fs.existsSync(path.join(dir, "kitchen.yaml")));
});

test("no commit yet: the files are written, the checks wait, and it says to commit first (review M6)", async () => {
  const dir = path.join(root, "fresh");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  git(root, "init", "-q", "-b", "main", dir);
  const lines: string[] = [];
  assert.equal(await quickInit({ repo: dir, agent: noAgent }, (l) => lines.push(l)), 0);
  assert.match(lines.join("\n"), /skipped: no commit yet/);
  assert.match(lines.join("\n"), /Next: make a first commit/);
  assert.doesNotMatch(lines.join("\n"), /kitchen ticket/);
});

test("dependencies: no lockfile, no install and the checks are skipped; an install is announced before it runs (review M1)", async () => {
  const loose = repo("loose", { "package.json": JSON.stringify({ scripts: { test: "node --test" }, dependencies: { leftpad: "1" } }) });
  const lines: string[] = [];
  assert.equal(await quickInit({ repo: loose, agent: noAgent }, (l) => lines.push(l)), 0);
  assert.match(lines.join("\n"), /skipped: dependencies not installed, and no lockfile to install them from/);
  assert.doesNotMatch(lines.join("\n"), /Installing/);
  assert.equal(loadConfig(loose).checks_prepare, undefined);
  // The person's own install command (kitchen.yaml checks_prepare) runs, announced first.
  const own = repo(
    "own-prepare",
    { "package.json": JSON.stringify({ scripts: { test: "test -d node_modules" }, dependencies: { leftpad: "1" } }) },
    'version: 1\nchecks: ["npm test"]\nchecks_prepare: "mkdir node_modules"\n',
  );
  const more: string[] = [];
  assert.equal(await quickInit({ repo: own, agent: noAgent }, (l) => more.push(l)), 0, more.join("\n"));
  const text = more.join("\n");
  assert.ok(text.indexOf("Installing dependencies (mkdir node_modules)…") < text.indexOf("Running"), text);
  assert.equal(readQuickRecord(own)?.prepare?.ok, true);
});

test("a repo whose base already has a Toolkit is not told to build one (review M6)", async () => {
  const dir = repo("has-toolkit", { "package.json": JSON.stringify({ scripts: { test: "node --test" } }), ".kitchen/toolkit/bin/dev": "#!/bin/sh\n" });
  const lines: string[] = [];
  await quickInit({ repo: dir, agent: noAgent }, (l) => lines.push(l));
  assert.doesNotMatch(lines.join("\n"), /kitchen toolkit build/);
  assert.match(lines.join("\n"), /Kitchen drives your app with the Toolkit already on main/);
});

test("a sandboxed check is killed with its process group on Ctrl-C (review M3)", async () => {
  const dir = fs.mkdtempSync(path.join(root, "sig-"));
  const mod = path.join(KITCHEN, "src", "proof", "run-sandboxed.ts");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { runSandboxed } from ${JSON.stringify(mod)}; await runSandboxed({ cwd: ${JSON.stringify(dir)}, cmd: "sleep 30 & echo $! > pid; wait", timeoutSec: 60, what: "t", killOnSignal: true });`,
    ],
    { env: process.env, stdio: "ignore" },
  );
  const pidFile = path.join(dir, "pid");
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  const sleeper = Number(fs.readFileSync(pidFile, "utf8"));
  child.kill("SIGINT");
  const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  assert.equal(code, 130);
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(sleeper, 0), "the check's own children are gone too");
});

/** A scripted setup role: the survey asks nothing, the build copies fixture E's bench Toolkit. */
const script = () => `import fs from "node:fs";
import path from "node:path";
const from = ${JSON.stringify(path.join(KITCHEN, "bench", "toolkits", "e-library"))};
export default (req) => {
  fs.appendFileSync(path.join(${JSON.stringify(root)}, "calls-" + path.basename(path.dirname(path.dirname(req.cwd))) + ".log"), req.role + " " + req.outFile + "\\n");
  if (req.outFile === "survey.md") return { line: "survey", file: "Surface: api\\n\`\`\`json\\n[]\\n\`\`\`\\n" };
  fs.cpSync(path.join(from, "toolkit"), path.join(req.cwd, ".kitchen", "toolkit"), { recursive: true });
  fs.copyFileSync(path.join(from, "env.kitchen"), path.join(req.cwd, ".env.kitchen"));
  return { line: "built", file: "STATUS: READY\\nSURFACE: api\\n" };
};
`;

test("kitchen init --toolkit is quick init followed by kitchen toolkit build", async () => {
  fs.writeFileSync(path.join(root, "setup-script.mjs"), script());
  const yaml = `version: 1\nagent: { tool: fake, script: ${path.join(root, "setup-script.mjs")} }\n`;
  const a = repo("both", "e-library", yaml);
  const b = repo("apart", "e-library", yaml);
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((l: string) => printed.push(String(l)));
  try {
    assert.equal(await w2("init", ["--toolkit", "--generate-only", "--repo", a]), 0, printed.join("\n"));
    const one = printed.splice(0);
    assert.equal(await w2("init", ["--repo", b]), 0);
    assert.equal(await w2("toolkit", ["build", "--generate-only", "--repo", b]), 0, printed.join("\n"));
    const two = printed.splice(0);
    // The same output, phase for phase (times and the repo's name aside).
    const norm = (ls: string[]) =>
      ls.filter(Boolean).map((l) =>
        l
          .replace(/\s+[\d.]+s( · \$[\d.]+)?$|\d+(\.\d+)?s\b/g, "T")
          .replace(/both|apart/g, "R")
          .replace(/\([0-9a-f]{7}\)/g, "(sha)"),
      );
    assert.deepEqual(norm(one), norm(two));
    // The same files, state and Toolkit commit.
    for (const f of ["kitchen.yaml", ".gitignore", ".claude/skills/kitchen/SKILL.md"])
      assert.equal(fs.readFileSync(path.join(a, f), "utf8"), fs.readFileSync(path.join(b, f), "utf8"), f);
    assert.deepEqual(Object.keys(readInitState(a)?.steps ?? {}), Object.keys(readInitState(b)?.steps ?? {}));
    assert.equal(readInitState(a)?.steps.check?.ok, true);
    assert.equal(git(a, "rev-parse", "kitchen/setup^{tree}"), git(b, "rev-parse", "kitchen/setup^{tree}"));
    assert.equal(fs.readFileSync(path.join(root, "calls-both.log"), "utf8"), "setup survey.md\nsetup setup.md\n");
    assert.equal(fs.readFileSync(path.join(root, "calls-apart.log"), "utf8"), "setup survey.md\nsetup setup.md\n");
    // The build's details went to init.log, not the terminal.
    assert.match(fs.readFileSync(path.join(a, ".kitchen", "init", "init.log"), "utf8"), /toolkit build: worktree \.worktrees\/_setup on kitchen\/setup/);
    assert.ok(!one.some((l) => /worktree|toolkit check:/.test(l)), one.join("\n"));
    // Old skills poll `kitchen init --status` for `init: …` (review L4).
    printed.splice(0);
    await w2("init", ["--status", "--repo", a]);
    assert.match(printed[0] ?? "", /^init: done/);
    // The old init's flags imply the build; on a repo quick init already set up they go straight to it (review M7).
    printed.splice(0);
    assert.equal(await w2("init", ["--generate-only", "--repo", a]), 0);
    assert.ok(!printed.some((l) => /Setting up Kitchen/.test(l)), printed.join("\n"));
    // Plain init has nothing more to show: --verbose and --wait are refused, not ignored (review L5).
    await assert.rejects(w2("init", ["--verbose", "--repo", a]), /--verbose goes with --toolkit/);
    await assert.rejects(w2("init", ["--wait", "5", "--repo", a]), /--wait goes with --status/);
  } finally {
    log.mockRestore();
  }
});
