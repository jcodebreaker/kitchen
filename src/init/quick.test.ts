// Quick init (ADR 0010) on fixture copies: seconds, no agent when the checks are obvious,
// no worktree, no Toolkit; and `init --toolkit` is quick init followed by `toolkit build`.
// The agent is the fake adapter throughout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.match(lines.join("\n"), /✓ Ran the checks +test passed on main/);
  assert.match(lines.join("\n"), /Done in [\d.]+s · no agent/);
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

test("nothing obvious: one short read-only agent call on the cheap tier, no bridge, proposes the checks", async () => {
  const dir = repo("odd", { "README.md": "Run ./ci.sh before pushing.\n", "ci.sh": "#!/bin/sh\necho ok\n" });
  const fake = new FakeAdapter(() => ({ file: "CHECK: ci | sh ci.sh\nPREPARE: none\nTEST_CMD: none\n", line: "1 check" }));
  const lines: string[] = [];
  assert.equal(await quickInit({ repo: dir, agent: async () => fake }, (l) => lines.push(l)), 0);
  assert.equal(fake.calls.length, 1);
  const req = fake.calls[0];
  assert.equal(req.tier, "read");
  assert.equal(req.model, "haiku", "the cheap tier on Claude");
  assert.equal(req.bridge, undefined);
  assert.ok(req.timeoutSec <= 180 && req.maxTurns <= 15, "short");
  assert.deepEqual(
    loadConfig(dir).checkList.map((c) => c.run),
    ["sh ci.sh"],
  );
  assert.equal(readQuickRecord(dir)?.found, "agent");
  assert.match(lines.join("\n"), /1 check proposed by an agent/);
  assert.match(lines.join("\n"), /Done in [\d.]+s · one agent call/);
});

test("checks that fail on the base: said plainly, the failing output shown, and init still finishes", async () => {
  const dir = repo("red", { "package.json": JSON.stringify({ scripts: { test: "echo 'expected 2, got 3' && exit 1" } }) });
  const lines: string[] = [];
  assert.equal(await quickInit({ repo: dir, agent: noAgent }, (l) => lines.push(l)), 0);
  const text = lines.join("\n");
  assert.match(text, /✗ Ran the checks +test FAILED \(exit 1\)/);
  assert.match(text, /\| expected 2, got 3/);
  assert.match(text, /Gate runs these checks on every job, so every job would fail them/);
  assert.equal(JSON.parse(fs.readFileSync(checksRecord(dir), "utf8")).results[0].ok, false);
  assert.ok(fs.existsSync(path.join(dir, "kitchen.yaml")));
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
  } finally {
    log.mockRestore();
  }
});
