// What Codex needs the user to approve for setup, shown without a model call:
// `kitchen init --detach` run INSIDE Codex's workspace-write sandbox (`codex
// sandbox -P :workspace`, the profile its commands get) fails, so the /kitchen
// skill must run it escalated; `kitchen init --status` (read-only) works inside.
// The setup role is the scripted one (no model), so this costs nothing.
//   node spikes/w2/codex-sandbox.ts [scratch]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLI, check, finish, fixtureRepo, HERE } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work", "codex-sandbox"));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const r = fixtureRepo(root, "a-web", "a-codex-sandbox", {
  fresh: true,
  yaml: `agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-setup.ts"))} }\n`,
});
const codex = (process.env.W2_CODEX_CMD ?? "npx -y @openai/codex@0.171.0").split(" ");
const inSandbox = (args: string[]) =>
  spawnSync(codex[0], [...codex.slice(1), "sandbox", "-P", ":workspace", "--", process.execPath, CLI, ...args], {
    cwd: r.dir,
    env: r.env,
    encoding: "utf8",
    timeout: 300_000,
  });
const status = (args: string[] = []) => spawnSync(process.execPath, [CLI, "init", "--status", ...args], { cwd: r.dir, env: r.env, encoding: "utf8" });

const x = inSandbox(["init", "--detach"]);
console.log(`inside the sandbox: exit ${x.status}\n${(x.stdout + x.stderr).trim().split("\n").slice(-6).join("\n")}`);
let s = status(["--wait", "60"]);
console.log(`status: ${s.stdout.trim().split("\n").slice(0, 8).join("\n  ")}`);
check(
  "kitchen init inside Codex's workspace sandbox does not get through setup (so the skill escalates it)",
  x.status !== 0 || s.status !== 0,
  s.stdout.split("\n")[0],
);
const ro = inSandbox(["init", "--status"]);
check("kitchen init --status works inside the sandbox (read-only: no escalation)", /^init: /.test(ro.stdout), ro.stdout.split("\n")[0]);

// The same command outside the sandbox, as an escalated (approved) call runs it.
fs.writeFileSync(path.join(root, "answers.json"), JSON.stringify({ answers: {} }));
const y = spawnSync(process.execPath, [CLI, "init", "--answers", path.join(root, "answers.json"), "--detach"], { cwd: r.dir, env: r.env, encoding: "utf8" });
s = status(["--wait", "110"]);
while (/^init: running/.test(s.stdout)) s = status(["--wait", "110"]);
check("outside the sandbox (the approved call) the same init finishes: done", y.status === 0 && s.status === 0, s.stdout.split("\n")[0]);
finish("w2 codex-sandbox");
