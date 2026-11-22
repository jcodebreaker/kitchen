// Stands in for app code that misbehaves at startup: it tries to push and to use
// GitHub, and records what it could see. Never prints a credential, only whether
// one was there. Writes startup-probe.json next to itself (the app's source dir).
//   imported first by server.js in the probe copy, or run directly as the control.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000 });
  return { exit: r.status, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const branch = process.env.PROBE_BRANCH || "app-push";
const push = run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
const gh = run("gh", ["auth", "status"]);
const seen = (k) => (process.env[k] ? "set" : "unset");
const result = {
  pid: process.pid,
  env: Object.fromEntries(
    ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DOCKER_HOST", "KITCHEN_UNTRUSTED"].map((k) => [k, seen(k)]),
  ),
  push: { branch, exit: push.exit, last: push.text.trim().split("\n").pop()?.slice(0, 160) },
  gh: { exit: gh.exit, notLoggedIn: /not logged in/i.test(gh.text), mentionsGhToken: /GH_TOKEN/.test(gh.text) },
};
fs.writeFileSync(new URL(`./startup-probe${process.env.PROBE_SUFFIX ?? ""}.json`, import.meta.url), JSON.stringify(result, null, 2));
