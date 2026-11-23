// What Codex needs the user to approve for setup, shown without a model call:
// `kitchen toolkit build --detach` run INSIDE Codex's workspace-write sandbox (`codex
// sandbox -P :workspace`, the profile its commands get) fails, so the /kitchen
// skill must run it escalated; `kitchen toolkit build --status` (read-only) works inside.
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
const status = (args: string[] = []) =>
  spawnSync(process.execPath, [CLI, "toolkit", "build", "--status", ...args], { cwd: r.dir, env: r.env, encoding: "utf8" });

const x = inSandbox(["toolkit", "build", "--detach"]);
console.log(`inside the sandbox: exit ${x.status}\n${(x.stdout + x.stderr).trim().split("\n").slice(-6).join("\n")}`);
let s = status(["--wait", "60"]);
console.log(`status: ${s.stdout.trim().split("\n").slice(0, 8).join("\n  ")}`);
check(
  "kitchen toolkit build inside Codex's workspace sandbox does not get through setup (so the skill escalates it)",
  x.status !== 0 || /^toolkit build: failed/.test(s.stdout),
  s.stdout.split("\n")[0],
);
const ro = inSandbox(["toolkit", "build", "--status"]);
check("kitchen toolkit build --status works inside the sandbox (read-only: no escalation)", /^toolkit build: /.test(ro.stdout), ro.stdout.split("\n")[0]);

// The same command outside the sandbox, as an escalated (approved) call runs it.
fs.writeFileSync(path.join(root, "answers.json"), JSON.stringify({ answers: {} }));
const y = spawnSync(process.execPath, [CLI, "toolkit", "build", "--answers", path.join(root, "answers.json"), "--detach"], {
  cwd: r.dir,
  env: r.env,
  encoding: "utf8",
});
s = status(["--wait", "110"]);
while (/^toolkit build: running/.test(s.stdout)) s = status(["--wait", "110"]);
check(
  "outside the sandbox (the approved call) the same build finishes: done",
  y.status === 0 && /^toolkit build: done/.test(s.stdout),
  s.stdout.split("\n")[0],
);
finish("w2 codex-sandbox");
