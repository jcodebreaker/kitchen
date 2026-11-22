// W5 follow-up 4, no Docker, no agent: Gate on a Node repo whose job worktree
// has no node_modules. A clone of Kitchen's own repo (a CLI Toolkit, nothing to
// start), a job with a worktree, and Gate run as the gate stage runs it:
//   1. without `checks_prepare`: FAIL (tsc and vitest aren't there)
//   2. with `checks_prepare: npm ci` (sandboxed, checks_network: true): PASS, the
//      install stamped as a check
//   3. Gate again on the same HEAD: the install is cached (no second npm ci)
//   4. a `test` proof through prove(), as Verify runs it: passes, no new install
//   5. a lockfile change: the next Gate installs again
//   node spikes/w5/checks-prepare.ts [scratch]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGate } from "../../src/checks/gate.ts";
import { checksPrepareOf } from "../../src/checks/run-checks.ts";
import { parseConfig } from "../../src/config.ts";
import { ensureWorktree, headOf } from "../../src/engine/worktree.ts";
import { prove } from "../../src/proof/prove.ts";
import { check, finish, jobDir, jobOf, type Repo, ticket } from "../w3a/lib.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-checks-prepare-")));
fs.mkdirSync(root, { recursive: true });
const dir = path.join(root, "kitchen-copy");
fs.rmSync(dir, { recursive: true, force: true });
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=spike", "-c", "user.email=s@example.invalid", ...a], { cwd, stdio: "pipe" }).toString();
git(root, "clone", "--quiet", "--no-hardlinks", ROOT, dir);
const yaml = (prepare: boolean) =>
  [
    "agent: { tool: fake }",
    "checks:",
    "  - npm run typecheck",
    "  - name: unit (one file)",
    "    run: npx vitest run src/checks/run-checks.test.ts",
    'test_cmd: "npx vitest run {file}"',
    "checks_network: true",
    ...(prepare ? ["checks_prepare: npm ci --no-audit --no-fund --ignore-scripts"] : []),
    "",
  ].join("\n");
fs.writeFileSync(path.join(dir, "kitchen.yaml"), yaml(false));
git(dir, "add", "kitchen.yaml");
git(dir, "commit", "-q", "-m", "kitchen.yaml for the spike");
const home = path.join(root, "kitchen-home");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const r: Repo = { dir, home, env: { ...process.env, KITCHEN_HOME: home, KITCHEN_SLOTS: path.join(root, "slots") } };
process.env.KITCHEN_HOME = home;
process.env.KITCHEN_SLOTS = r.env.KITCHEN_SLOTS;
const id = ticket(r, "checks_prepare spike");
const jd = jobDir(r, id);
const job = await ensureWorktree(r.dir, jobOf(r, id));
check("the job worktree has no node_modules", !fs.existsSync(path.join(job.worktree, "node_modules")), job.worktree);

const gate = async (prepare: boolean) => {
  const cfg = parseConfig(yaml(prepare));
  return runGate({ jobDir: jd, checks: cfg.checkList, network: cfg.checks_network, headOf: () => headOf(job), prepare: checksPrepareOf(cfg) });
};
const t0 = Date.now();
const g1 = await gate(false);
check("1. without checks_prepare: Gate FAILs", g1.result === "FAIL", g1.why ?? "");

const g2 = await gate(true);
const installed = g2.lines.some((l) => /PASS checks_prepare/.test(l));
check(
  "2. with checks_prepare (npm ci, sandboxed): Gate PASSes, the install stamped",
  g2.result === "PASS" && installed,
  g2.lines.filter((l) => l.startsWith("-")).join(" | "),
);
if (g2.result !== "PASS") console.log(g2.lines.join("\n"));
check("   node_modules now in the worktree, the tree still clean", fs.existsSync(path.join(job.worktree, "node_modules", "typescript")));

const g3 = await gate(true);
check(
  "3. Gate again: PASS without a second install",
  g3.result === "PASS" && !g3.lines.some((l) => /checks_prepare/.test(l)),
  g3.lines.filter((l) => l.startsWith("-")).join(" | "),
);

const p = await prove({
  jobDir: jd,
  criterion: { id: "C1", proof: "test src/checks/run-checks.test.ts", expect: "exit 0" },
  role: "engine",
  testCmd: "npx vitest run {file}",
  checksPrepare: checksPrepareOf(parseConfig(yaml(true))),
});
check(
  "4. a `test` proof as Verify runs it: pass, no new install",
  p.status === "pass" && p.evidence.length === 1,
  `${p.status} ${p.why ?? ""} evidence ${p.evidence.join(",")}`,
);

// A lockfile change (committed, as a builder's would be): the next Gate installs again.
const lock = path.join(job.worktree, "package-lock.json");
fs.writeFileSync(lock, fs.readFileSync(lock, "utf8").replace(/\n?$/, "\n"));
fs.appendFileSync(lock, "\n");
git(job.worktree, "commit", "-q", "-am", "touch the lockfile");
const g4 = await gate(true);
check(
  "5. a lockfile change: the next Gate installs again",
  g4.lines.some((l) => /checks_prepare/.test(l)),
  g4.result,
);
console.log(`    (${Math.round((Date.now() - t0) / 1000)} s)`);
finish("checks-prepare");
