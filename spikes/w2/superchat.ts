// The superchat-lite measurement (PLAN §7 W2: not a gate). Clones the checkout
// into a scratch dir (the real checkout and its running stack are never touched),
// runs `kitchen init --generate-only` on Claude with a 60-minute cap, and records
// time, cost, what was generated, and whether describe + the feature files pass.
// --generate-only because its stack (Postgres + a 2.85 GB engine image + a 2 GB
// host container per person) is over this laptop's Docker budget: the setup
// agent writes the Toolkit but nothing is started.
//   node spikes/w2/superchat.ts [scratch]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, finish, HERE, kitchenLive, ourContainers, type Repo, readJson } from "./lib.ts";

const SRC = "/Users/simo/pttx/superchat-lite";
const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work", "superchat"));
const model = process.env.W2_MODEL ?? "sonnet";
const effort = process.env.W2_EFFORT ?? "medium";
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const dir = path.join(root, "superchat-lite");
execFileSync("git", ["clone", "--quiet", "--no-hardlinks", SRC, dir], { stdio: "inherit" });
const head = execFileSync("git", ["-C", dir, "rev-parse", "--short=12", "HEAD"]).toString().trim();
const home = path.join(root, "kitchen-home");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(dir, "kitchen.yaml"), "agent: { tool: claude }\n");
const r: Repo = { dir, home, env: { ...process.env, KITCHEN_HOME: home } };
const log = path.join(root, "init.log");
console.log(`superchat-lite ${head} cloned to ${dir}`);

const CAP_MS = 60 * 60_000;
const t0 = Date.now();
const run = kitchenLive(r, ["toolkit", "build", "--verbose", "--generate-only", "--model", model, "--effort", effort], { logFile: log });
const timer = new Promise<{ out: string; code: number; secs: number }>((resolve) =>
  setTimeout(() => resolve({ out: "", code: -2, secs: CAP_MS / 1000 }), CAP_MS).unref(),
);
let x = await Promise.race([run, timer]);
if (x.code === 3) {
  const qs = readJson<{ questions: unknown[] }>(path.join(dir, ".kitchen", "setup-questions.json")).questions;
  console.log(`init asked: ${JSON.stringify(qs)}; answering with the defaults`);
  fs.writeFileSync(path.join(root, "answers.json"), JSON.stringify({ answers: {} }));
  x = await Promise.race([
    kitchenLive(r, ["toolkit", "build", "--verbose", "--generate-only", "--answers", path.join(root, "answers.json"), "--model", model, "--effort", effort], {
      logFile: log,
    }),
    timer,
  ]);
}
const secs = (Date.now() - t0) / 1000;
if (x.code === -2) {
  console.log("60-minute cap reached: stopping");
  try {
    execFileSync("pkill", ["-f", `--repo ${dir}`], { stdio: "ignore" });
  } catch {}
}
check("superchat-lite: init --generate-only finished inside 60 minutes", x.code !== -2, `${Math.round(secs)}s, exit ${x.code}`);
const state = fs.existsSync(path.join(dir, ".kitchen/init/state.json"))
  ? readJson<{ runs: { mode: string; secs: number; usd?: number; inTok?: number; outTok?: number }[]; steps: Record<string, unknown> }>(
      path.join(dir, ".kitchen/init/state.json"),
    )
  : null;
const wt = path.join(dir, ".worktrees", "_setup");
const files = fs.existsSync(path.join(wt, ".kitchen/toolkit"))
  ? fs
      .readdirSync(path.join(wt, ".kitchen/toolkit"), { recursive: true })
      .map(String)
      .filter((f) => !f.includes("node_modules"))
  : [];
let diffstat = "";
try {
  diffstat = execFileSync("git", ["-C", dir, "diff", "--stat", `${head}..kitchen/setup`])
    .toString()
    .trim();
} catch {}
check(
  "superchat-lite: a Toolkit was generated and committed on kitchen/setup",
  files.includes("app.mjs") && /app\.mjs/.test(diffstat),
  `${files.length} files`,
);
const left = ourContainers();
check("superchat-lite: no Kitchen containers left", left.length === 0, left.join(", "));
const result = {
  head,
  model,
  effort,
  at: new Date().toISOString(),
  exit: x.code,
  secs,
  runs: state?.runs ?? [],
  usd: (state?.runs ?? []).reduce((s, y) => s + (y.usd ?? 0), 0),
  steps: state?.steps ?? null,
  files,
  diffstat,
  setupMd: fs.existsSync(path.join(dir, ".kitchen/init/setup.md")) ? fs.readFileSync(path.join(dir, ".kitchen/init/setup.md"), "utf8") : null,
  surveyMd: fs.existsSync(path.join(dir, ".kitchen/init/survey.md")) ? fs.readFileSync(path.join(dir, ".kitchen/init/survey.md"), "utf8") : null,
  log,
};
fs.mkdirSync(path.join(HERE, "runs"), { recursive: true });
fs.writeFileSync(path.join(HERE, "runs", "superchat-claude.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`superchat-lite: ${Math.round(secs)}s, $${result.usd.toFixed(2)}, ${files.length} Toolkit files`);
finish("w2 superchat-lite");
