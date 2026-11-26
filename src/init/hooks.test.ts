// Kitchen's guard hooks, run as Claude Code runs them: the script with the hook's JSON on stdin, a deny printed as
// hookSpecificOutput. And `kitchen init`'s merge of them into .claude/settings.json.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { HOOK_SCRIPTS, HOOKS_DIR, HOOKS_SRC, hooksBackupDir, hooksVersion, installHooks, KITCHEN_HOOKS, mergeHooks, refreshHooks } from "./hooks.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".kitchen-hooks-test-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Runs one hook script; returns the deny reason, the PostToolUse context, or null. */
function hook(script: string, payload: Record<string, unknown>, env: Record<string, string> = {}): string | null {
  const r = spawnSync("python3", [path.join(HOOKS_SRC, script)], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", ...payload }),
    encoding: "utf8",
    env: { PATH: process.env.PATH as string, HOME: os.homedir(), ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return null;
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  return o.permissionDecisionReason ?? o.additionalContext;
}
const bash = (command: string, cwd = root) => ({ tool_name: "Bash", tool_input: { command }, cwd });

test("guard-secrets: no reading .env or keys; the example file stays readable", () => {
  assert.match(String(hook("guard-secrets.py", bash("cat .env"))), /guard-secrets/);
  assert.ok(hook("guard-secrets.py", { tool_name: "Read", tool_input: { file_path: "/x/.env.local" } }));
  assert.ok(hook("guard-secrets.py", bash("cp ~/.ssh/id_ed25519 /tmp/k")));
  assert.equal(hook("guard-secrets.py", { tool_name: "Read", tool_input: { file_path: "/x/.env.example" } }), null);
  assert.equal(hook("guard-secrets.py", bash("npm test")), null);
});

test("guard-key-literals: a live-looking key is refused before it is written, by line, never echoed; placeholders pass", () => {
  const key = `sk-ant-${"a1B2".repeat(8)}`;
  const why = hook("guard-key-literals.py", { tool_name: "Write", tool_input: { file_path: "/x/a.js", content: `const k = "${key}";\n` } });
  assert.match(String(why), /line\(s\) 1/);
  assert.ok(!String(why).includes(key), "the value never reaches the transcript");
  assert.equal(
    hook("guard-key-literals.py", { tool_name: "Write", tool_input: { file_path: "/x/a.js", content: "const k = process.env.ANTHROPIC_API_KEY;\n" } }),
    null,
  );
  assert.equal(
    hook("guard-key-literals.py", { tool_name: "Write", tool_input: { file_path: "/x/a.js", content: 'api_key = "YOUR_example_placeholder_value_here"\n' } }),
    null,
  );
});

test("guard-protected-push: main, master and kitchen.yaml's staging.base are refused; job branches go", () => {
  const repo = path.join(root, "push");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "develop", repo]);
  fs.writeFileSync(path.join(repo, "kitchen.yaml"), "staging: { branch: staging, base: develop, max_lines: 400 }\n");
  const env = { CLAUDE_PROJECT_DIR: repo };
  for (const c of ["git push origin main", "git push origin HEAD:refs/heads/master", "git push -f origin develop", "git push", "gh pr merge 3 --admin"])
    assert.match(String(hook("guard-protected-push.py", bash(c, repo), env)), /Blocked by Kitchen/, c);
  assert.equal(hook("guard-protected-push.py", bash("git push origin kitchen/001-x", repo), env), null);
  assert.equal(
    hook("guard-protected-push.py", bash("git push origin main", repo), { ...env, KITCHEN_ALLOW_PROTECTED_PUSH: "1" }),
    null,
    "the person's own session can opt out",
  );
});

test("guard-delete-outside: no rm outside the project, never / or home", () => {
  const env = { CLAUDE_PROJECT_DIR: root };
  assert.ok(hook("guard-delete-outside.py", bash("rm -rf ~/Documents"), env));
  assert.ok(hook("guard-delete-outside.py", bash("rm -rf /"), env));
  assert.ok(hook("guard-delete-outside.py", bash("cd .. && rm -rf other"), env));
  assert.equal(hook("guard-delete-outside.py", bash("rm -rf node_modules dist"), env), null);
});

test("guard-worktree: worktrees only under .worktrees/; a bound lane agent writes only in its worktree and job folder", () => {
  const repo = path.join(root, "wt");
  const id = "001-add-x";
  const job = path.join(repo, ".kitchen", "jobs", id);
  fs.mkdirSync(job, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const wt = path.join(repo, ".worktrees", id);
  fs.writeFileSync(path.join(job, "job.json"), JSON.stringify({ id, running: { lane: "build", at: "t", key: "k" }, worktree: wt }));
  const env = { CLAUDE_PROJECT_DIR: repo };
  assert.match(String(hook("guard-worktree.py", bash("git worktree add ../elsewhere -b x", repo), env)), /outside/);
  assert.equal(hook("guard-worktree.py", bash(`git worktree add ${wt} -b y`, repo), env), null);
  const write = (file_path: string, agent_id?: string) => ({
    tool_name: "Write",
    tool_input: { file_path, content: "x" },
    cwd: repo,
    ...(agent_id ? { agent_id } : {}),
  });
  // The session itself (no agent_id) isn't a lane agent: never bound, never refused here.
  assert.equal(hook("guard-worktree.py", write(path.join(repo, "server.js")), env), null);
  // An agent's first call naming its job binds it; then the main checkout is off limits.
  assert.equal(hook("guard-worktree.py", write(path.join(wt, "server.js"), "agent-1"), env), null);
  assert.equal(fs.readFileSync(path.join(repo, ".kitchen", "agents", "agent-1"), "utf8"), id);
  assert.match(String(hook("guard-worktree.py", write(path.join(repo, "server.js"), "agent-1"), env)), /outside job 001-add-x's places/);
  assert.equal(hook("guard-worktree.py", write(path.join(job, "intake.md"), "agent-1"), env), null);
  // ADR 0031: the job folder's files Kitchen owns are not the agent's (Edit/Write only; Bash isn't covered).
  for (const [f, why] of [
    ["job.json", /the job's state/],
    ["control.json", /the steering file/],
    ["rounds/1/brief-build-m1.md", /the lane's brief/],
    ["rounds/1/qa/criteria.json", /the criteria QA was given/],
    ["rounds/1/qa/c1.png.meta.json", /a capture's stamp/],
  ] as const)
    assert.match(String(hook("guard-worktree.py", write(path.join(job, f), "agent-1"), env)), why, f);
  assert.equal(hook("guard-worktree.py", write(path.join(job, "rounds/1/qa/verdict.json"), "agent-1"), env), null, "QA writes its verdict");
  fs.writeFileSync(path.join(job, "job.json"), JSON.stringify({ id, running: { lane: "build", at: "t", key: "k" }, worktree: wt }));
  // ADR 0030: a lane session `kitchen run` started has no agent_id; KITCHEN_JOB binds it the same way.
  const lane = { ...env, KITCHEN_JOB: id };
  assert.match(String(hook("guard-worktree.py", write(path.join(repo, "server.js")), lane)), /outside job 001-add-x's places/);
  assert.equal(hook("guard-worktree.py", write(path.join(wt, "server.js")), lane), null);
  // kitchen remove: the job is archived, so the bound agent is refused every call (it stops); the session isn't.
  fs.writeFileSync(path.join(job, "job.json"), JSON.stringify({ id, running: null, worktree: wt, archived: { at: "t", by: "person" } }));
  assert.match(String(hook("guard-worktree.py", write(path.join(wt, "server.js"), "agent-1"), env)), /the person removed job 001-add-x\. Stop now/);
  assert.match(String(hook("guard-worktree.py", { ...bash("npm test", wt), agent_id: "agent-1" }, env)), /Stop now/);
  assert.equal(hook("guard-worktree.py", write(path.join(repo, "notes.md")), env), null);
  // ADR 0026: its PR merged on GitHub mid-lane: done with no lane open, so the bound agent stops the same way.
  fs.writeFileSync(path.join(job, "job.json"), JSON.stringify({ id, stage: "done", running: null, worktree: wt }));
  assert.match(String(hook("guard-worktree.py", write(path.join(wt, "server.js"), "agent-1"), env)), /job 001-add-x ended while you worked \(merged\)/);
});

test("the activity hook: a bound agent's calls land in its lane's stream, as stream-json tool_use / tool_result", () => {
  const repo = path.join(root, "act");
  const id = "002-y";
  const job = path.join(repo, ".kitchen", "jobs", id);
  fs.mkdirSync(path.join(job, "activity"), { recursive: true });
  fs.writeFileSync(path.join(job, "activity", "m3-qa-1.jsonl"), "");
  fs.writeFileSync(path.join(job, "job.json"), JSON.stringify({ id, running: { lane: "qa", at: "t", key: "k", stream: "activity/m3-qa-1.jsonl" } }));
  const env = { CLAUDE_PROJECT_DIR: repo };
  const base = {
    agent_id: "qa-1",
    tool_name: "Bash",
    tool_use_id: "tu1",
    cwd: path.join(repo, ".worktrees", id),
    tool_input: { command: "kitchen qa up 002" },
  };
  hook("activity.py", base, env);
  hook("activity.py", { ...base, hook_event_name: "PostToolUse", tool_response: { stdout: "app: up" } }, env);
  const lines = fs
    .readFileSync(path.join(job, "activity", "m3-qa-1.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.type, l.message.content[0].type]),
    [
      ["assistant", "tool_use"],
      ["user", "tool_result"],
    ],
  );
  assert.equal(lines[0].message.content[0].input.command, "kitchen qa up 002");
  // ADR 0030: in a lane session `kitchen run` started, Kitchen writes the whole stream itself: the hook adds nothing.
  hook("activity.py", { ...base, agent_id: undefined }, { ...env, KITCHEN_JOB: id });
  assert.equal(
    fs
      .readFileSync(path.join(job, "activity", "m3-qa-1.jsonl"), "utf8")
      .trim()
      .split("\n").length,
    2,
  );
});

test("kitchen init merges the hooks into .claude/settings.json: keeps what is there, backs it up, never twice", () => {
  const repo = path.join(root, "settings");
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  const mine = { permissions: { allow: ["Bash(npm test)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } };
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify(mine));
  const first = installHooks(repo);
  const total = Object.values(KITCHEN_HOOKS)
    .flat()
    .reduce((a, e) => a + e.hooks.length, 0);
  assert.equal(first.added, total);
  assert.ok(first.backup && JSON.parse(fs.readFileSync(first.backup, "utf8")).permissions, "the old file is kept beside it");
  const s = JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.permissions, mine.permissions);
  const bashHooks = s.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Bash").hooks.map((h: { command: string }) => h.command);
  assert.equal(bashHooks[0], "echo mine");
  assert.ok(bashHooks.some((c: string) => c.endsWith("guard-protected-push.py")));
  assert.ok(fs.existsSync(path.join(repo, ".claude", "hooks", "kitchen", "guard-secrets.py")));
  const second = installHooks(repo);
  assert.deepEqual([second.added, second.backup, second.scripts], [0, null, 0]);
  assert.equal(mergeHooks(s).added, 0);
});

test("ADR 0030: refreshHooks replaces only an older installed script, kept in .kitchen/hooks-backup; none where init never ran", () => {
  const repo = path.join(root, "refresh");
  fs.mkdirSync(repo, { recursive: true });
  assert.deepEqual(refreshHooks(repo), []);
  installHooks(repo);
  const f = path.join(repo, HOOKS_DIR, "kitchen_jobs.py");
  fs.writeFileSync(f, "# an older script\n");
  assert.deepEqual(refreshHooks(repo, new Date("2026-11-24T00:00:00Z")), [path.join(HOOKS_DIR, "kitchen_jobs.py")]);
  assert.equal(fs.readFileSync(path.join(hooksBackupDir(repo), "kitchen_jobs.py.2026-11-24T00-00-00-000Z"), "utf8"), "# an older script\n");
  assert.ok(fs.readFileSync(f).equals(fs.readFileSync(path.join(HOOKS_SRC, "kitchen_jobs.py"))));
  assert.deepEqual(
    fs.readdirSync(path.join(repo, HOOKS_DIR)).filter((x) => !x.endsWith(".py")),
    [],
    "nothing else beside the hooks",
  );
  assert.deepEqual(refreshHooks(repo), [], "nothing to do the second time");
  // A teammate's newer Kitchen installed a newer script: an older Kitchen leaves it.
  const newer = "# kitchen-hooks-version: 99\n# from a newer Kitchen\n";
  fs.writeFileSync(f, newer);
  assert.deepEqual(refreshHooks(repo), []);
  assert.equal(fs.readFileSync(f, "utf8"), newer);
  assert.ok(
    HOOK_SCRIPTS.every((x) => hooksVersion(fs.readFileSync(path.join(HOOKS_SRC, x), "utf8")) >= 2),
    "every script says its version",
  );
});
