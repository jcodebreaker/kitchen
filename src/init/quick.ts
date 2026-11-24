// `kitchen init` (ADR 0010, ADR 0016): seconds, no agent. It checks what Kitchen needs (preflight.ts), then writes
// kitchen.yaml with the checks and how to start the app it finds in the repo (asking at most one question, only when
// no start command is obvious and someone is there to answer), installs the /kitchen skill and the guard hooks,
// adds Kitchen's .gitignore entries, creates the staging branch from the base, and runs the checks once.
import fs from "node:fs";
import path from "node:path";
import { prepareOf, runChecks } from "../checks/run-checks.ts";
import { checksFor, loadConfig } from "../config.ts";
import { currentBranch, git, revParse } from "../engine/git.ts";
import { ensureStaging } from "../engine/staging.ts";
import { writeAtomic } from "../engine/store.ts";
import { appendLedger } from "../ledger/append.ts";
import { writeVerifySkill } from "../verify/skill.ts";
import { type DetectedApp, detectApp } from "./detect-app.ts";
import { composeWarning, detectChecks } from "./detect-checks.ts";
import { addGitignore, hasOwnChecks, installSkill, toolFor, writeConfig } from "./files.ts";
import { installHooks } from "./hooks.ts";
import { preflight, preflightLines } from "./preflight.ts";
import { dur, phaseLine } from "./say.ts";
import { skillsReport } from "./skills-report.ts";

export type InitOpts = {
  repo: string;
  tool?: "claude" | "codex";
  /** Asks the person one line (a terminal). Absent: no one to ask. */
  ask?: (question: string) => Promise<string>;
  /** Skip the preflight (tests). */
  skipPreflight?: boolean;
};

export const checksRecord = (repo: string) => path.join(repo, ".kitchen", "init", "checks.json");

/** origin's GitHub owner/name, or null. */
async function githubRepo(repo: string): Promise<string | null> {
  const url = (await git(repo, ["remote", "get-url", "origin"], { allowFail: true })).stdout.trim();
  const m = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  return m ? m[1] : null;
}

export async function init(o: InitOpts, out: (l: string) => void): Promise<number> {
  const t0 = Date.now();
  const repo = o.repo;
  const tool = toolFor(repo, o.tool) as "claude" | "codex";
  if (!o.skipPreflight) {
    const gh = await githubRepo(repo).catch(() => null);
    const p = await preflight({ repo, tool, ghRequired: false });
    for (const l of preflightLines(p, "kitchen init")) out(l);
    if (!p.ok) return 2;
    if (gh && !p.checks.find((c) => c.name === "gh")?.ok) out(`  (origin is GitHub, ${gh}, but gh isn't signed in: jobs merge into a local staging branch)`);
    out("");
  }
  out(`Setting up Kitchen in ${path.basename(repo)}…`);

  // 1. kitchen.yaml: the checks, how to start the app, staging from the branch you are on
  const det = detectChecks(repo);
  const own = hasOwnChecks(repo);
  let app: DetectedApp | null =
    fs.existsSync(path.join(repo, "kitchen.yaml")) && /^app\s*:/m.test(fs.readFileSync(path.join(repo, "kitchen.yaml"), "utf8")) ? null : detectApp(repo);
  let asked = false;
  const legacyToolkit = fs.existsSync(path.join(repo, ".kitchen", "toolkit", "bin", "dev"));
  if (
    !app &&
    !legacyToolkit &&
    o.ask &&
    !/^app\s*:/m.test(fs.existsSync(path.join(repo, "kitchen.yaml")) ? fs.readFileSync(path.join(repo, "kitchen.yaml"), "utf8") : "")
  ) {
    const a = (await o.ask("How do I start your app? (a command that serves it on $PORT; Enter if there is no app) ")).trim();
    if (a) {
      app = { start: a, health: "/", from: "your answer" };
      asked = true;
    }
  }
  // ADR 0021: the e2e suite runs against the app when there is one to start (found now, or already in kitchen.yaml).
  let hadApp = false;
  try {
    hadApp = !!loadConfig(repo).app.start;
  } catch {}
  if (det) det.checks = det.checks.map((c) => (c.when === "merge" ? { ...c, needsApp: !!app?.start || hadApp } : c));
  const branch = (await currentBranch(repo)) || "main";
  const base = ["staging"].includes(branch) ? "main" : branch;
  const cfgW = writeConfig(repo, tool, own ? (det?.install ? { checks: [], install: det.install, from: det.from } : null) : det, {
    app,
    appAsked: asked,
    base,
  });
  const gh = await githubRepo(repo).catch(() => null);
  if (gh && cfgW.written) {
    const ghOk = (await import("./preflight.ts")).runCmd(process.env);
    const t = await ghOk(process.env.KITCHEN_GH_BIN || "gh", ["auth", "token"]);
    if (t.code === 0) {
      // ADR 0026 §4: on GitHub a person merges: Kitchen opens the PR with the Report (staging.merge: pr).
      const f = path.join(repo, "kitchen.yaml");
      const text = fs.readFileSync(f, "utf8").replace(/^(staging: \{.*?)( \})$/m, "$1, merge: pr$2");
      fs.writeFileSync(
        f,
        `${text}# origin is on GitHub: passing jobs go to their target through a pull request a person merges (staging.merge: pr)\nforge: { kind: github, repo: ${gh} }\n`,
      );
    }
  }
  const cfg = loadConfig(repo);
  const n = cfg.checkList.length;
  const atMerge = cfg.checkList.filter((c) => c.when === "merge");
  out(
    phaseLine(
      true,
      cfgW.written ? "Wrote kitchen.yaml" : "Kept kitchen.yaml",
      `${n ? `${n} check${n === 1 ? "" : "s"}${det?.checks.length && !own ? ` from ${det.from.join(", ")}` : ""}` : "no checks found"} · app: ${
        cfg.app.start
          ? `\`${cfg.app.start}\`${cfg.app.reset ? ` (reset \`${cfg.app.reset}\`)` : ""}`
          : legacyToolkit
            ? "the repo's Toolkit (bin/dev up)"
            : "none"
      } · staging from ${cfg.staging.base}${cfg.forge.kind === "github" ? " (GitHub)" : ""}`,
    ),
  );
  for (const d of cfg.dropped.length ? [`  kitchen.yaml keys from an older Kitchen are ignored now: ${cfg.dropped.join(", ")}`] : []) out(d);
  for (const c of atMerge)
    out(`  ${c.name}: \`${c.run}\` runs on every merge into staging only (when: merge)${c.needsApp ? ", against the app started from the merged result" : ""}`);
  const e2e = det?.checks.find((c) => c.when === "merge");
  if (own && e2e && !atMerge.length)
    out(
      `  Found an end-to-end suite (\`${e2e.run}\`); your kitchen.yaml names its own checks, so add it yourself: - { name: e2e, run: ${JSON.stringify(e2e.run)}, when: merge, needs_app: ${!!e2e.needsApp}, timeout_sec: 900 }`,
    );
  const cw = composeWarning(repo);
  if (cw)
    out(
      `  ${cw.file} publishes fixed host ports (${cw.ports.join(", ")}): two jobs' stacks can't both bind them. If app.start runs it, publish only the app's port, as "\${PORT}:<its port>" (Kitchen gives each job its own project and port).`,
    );

  // 2. the skill, the hooks, .gitignore
  installSkill(repo);
  let roleSkills = "?";
  try {
    roleSkills = skillsReport(repo).short;
  } catch {}
  out(phaseLine(true, "Installed the skill", `/kitchen for Claude Code and Codex · role skills: ${roleSkills} (kitchen skills)`));
  const vs = writeVerifySkill(repo, cfg);
  const wrote = vs.files.filter((f) => f.did === "wrote" || f.did === "refreshed").length;
  const kept = vs.files.filter((f) => f.did === "kept").length;
  out(
    phaseLine(
      true,
      "Verify skill",
      `${vs.name} for Claude Code and Codex: ${wrote ? `${wrote} file${wrote === 1 ? "" : "s"} written` : "up to date"}${kept ? `, ${kept} you changed kept as they are` : ""} · the feature map fills in as QA touches features`,
    ),
  );
  const h = installHooks(repo);
  out(
    phaseLine(
      true,
      "Installed guard hooks",
      `${h.added ? `${h.added} added to .claude/settings.json${h.backup ? ` (backup ${path.basename(h.backup)})` : ""}` : "already in .claude/settings.json"} · secrets, key literals, protected push, deletes, worktree`,
    ),
  );
  const added = addGitignore(repo);
  out(phaseLine(true, "Updated .gitignore", added.length ? `${added.length} Kitchen entries` : "already has Kitchen's entries"));

  // 3. staging
  const sha = await revParse(repo, "HEAD");
  if (sha) {
    try {
      const lines: string[] = [];
      await ensureStaging(repo, cfg, (l) => lines.push(l));
      out(phaseLine(true, "Staging branch", lines.join("; ").replace(/^staging: /, "")));
    } catch (e) {
      out(phaseLine(false, "Staging branch", (e as Error).message));
    }
  }

  // 4. the checks, once, on your checkout
  let failed = false;
  if (checksFor(cfg, "build").length && sha) {
    const c0 = Date.now();
    const log = path.join(repo, ".kitchen", "init", "checks.log");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, "");
    const needDeps = !!prepareOf(cfg) && fs.existsSync(path.join(repo, "package.json")) && !fs.existsSync(path.join(repo, "node_modules"));
    // The `when: merge` checks (an e2e suite) aren't run here: they need the merged result, and often the app.
    const r = await runChecks({ dir: repo, checks: checksFor(cfg, "build"), prepare: needDeps ? prepareOf(cfg) : undefined, log });
    writeAtomic(checksRecord(repo), `${JSON.stringify({ at: new Date().toISOString(), sha, results: r.results }, null, 2)}\n`);
    appendLedger(repo, { job: "-", stage: "init", round: 0, event: "checks", key: `init/checks/${Date.now()}`, result: r.ok ? "pass" : "fail" });
    const bad = r.results.find((x) => !x.ok);
    failed = !r.ok;
    out(
      phaseLine(
        r.ok,
        "Ran the checks",
        r.ok ? `${r.results.map((x) => x.name).join(", ")} passed on ${branch}` : `${bad?.name} FAILED (exit ${bad?.exit ?? "timeout"})`,
        (Date.now() - c0) / 1000,
      ),
    );
    if (bad) out(bad.tail.split("\n").slice(-15).join("\n").replace(/^/gm, "  | "));
  } else if (!sha) out(phaseLine(false, "Ran the checks", "skipped: no commit yet"));

  out(`Done in ${dur((Date.now() - t0) / 1000)} · no agent`);
  if (failed) {
    out("Every job's checks would fail too: fix them (or edit checks: in kitchen.yaml), then kitchen init again.");
    return 1;
  }
  if (!n) out('No checks: add them to kitchen.yaml (checks: ["npm test"]) so Kitchen can hold every job to them.');
  if (!cfg.app.start && !legacyToolkit) out("No app to start: QA checks with tests and commands. Add app: { start: … } to kitchen.yaml if there is one.");
  else if (cfg.app.start && !cfg.app.reset)
    out(
      "No app.reset found: QA's restarts keep the data earlier checks left. If the app stores data, add app.reset to kitchen.yaml (a command that puts it back to its seed, e.g. rm -f data/*.json) so kitchen qa reset starts it fresh.",
    );
  out('Next: kitchen ticket "<what you want>"  then  kitchen run  (or /kitchen run in Claude Code)');
  out("      commit kitchen.yaml, .gitignore, .claude/settings.json and the skill and hook folders (the verify skill too) before the first run:");
  out("      jobs start from staging, so the verify skill must be on it for QA to keep the map");
  return 0;
}
