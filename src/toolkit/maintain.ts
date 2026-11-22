// `kitchen toolkit maintain` (PLAN §4, W4): pstack's maintain-verification-skill
// pass (MIT, Copyright (c) 2026 Lauren Tan; roles/maintainer.md), with the engine
// owning the loop:
//   1. source wave: one read-only `maintain-source` agent per feature file, at once
//      (up to `concurrency`), on a clean checkout of the base: how the feature
//      works today, and every claim of the feature file that no longer holds;
//   2. live pass: the full `kitchen toolkit check` of the base, which drives every
//      feature's check lines on a fresh app (required even when the source looks clean);
//   3. clean (no drift, check passes) → done, no branch, no PR;
//   4. otherwise one `maintain-fix` agent (write tier, the setup bridge to run its
//      Toolkit) fixes `.kitchen/toolkit/` only, on `kitchen/maintain-<sha>`; the engine
//      commits only Toolkit files and runs the full check on that commit (sandboxed:
//      it isn't merged); up to 2 fix rounds;
//   5. a passing check → one Toolkit PR of proven fixes through the forge (openPr);
//      else blocked, no PR.
// The outcome is recorded in .kitchen/maintain.json (the base sha it ran on) and the
// ledger. `kitchen run` starts it by itself when the feature-mapped paths changed by
// more than `maintain_churn_lines` since the last maintain (maintainDue).
import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/adapter.ts";
import { buildAgentEnv } from "../agents/env.ts";
import { type Config, loadConfig, modelFor } from "../config.ts";
import { linkedWorktree, openGit, plainCheckout } from "../engine/git.ts";
import { adapterFor } from "../engine/runner.ts";
import { pickMode, ROLES_DIR, roleFile } from "../engine/stages/prompts.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import type { Forge } from "../forge/forge.ts";
import { kitchenHome } from "../home.ts";
import { setupBridgeServer } from "../init/bridge.ts";
import { appendLedger } from "../ledger/append.ts";
import { type CheckReport, checkAtRef, readProven } from "./check.ts";
import { toolkitCheckout } from "./checkout.ts";
import { type Feature, parseFeature, touched } from "./contract.ts";

export type MaintainFeature = { file: string; drift: boolean; summary: string; live: "ok" | "failed" | "not-checked" };
export type MaintainState = {
  /** The base sha the pass ran on: churn is counted from here next time. */
  sha: string;
  at: string;
  outcome: "clean" | "changed" | "blocked";
  why?: string;
  features: MaintainFeature[];
  branch?: string;
  commit?: string;
  pr?: number;
  fixes: number;
  usd: number;
  secs: number;
  trigger: string;
};

export const maintainFile = (repo: string) => path.join(kitchenDir(repo), "maintain.json");
const workDir = (repo: string, sha: string) => path.join(kitchenDir(repo), "maintain", sha.slice(0, 12));
const WT_ID = "_maintain";
const IDENTITY = { GIT_AUTHOR_NAME: "Kitchen", GIT_AUTHOR_EMAIL: "kitchen@localhost", GIT_COMMITTER_NAME: "Kitchen", GIT_COMMITTER_EMAIL: "kitchen@localhost" };

export function readMaintain(repo: string): MaintainState | null {
  try {
    return JSON.parse(fs.readFileSync(maintainFile(repo), "utf8")) as MaintainState;
  } catch {
    return null;
  }
}

/** Lines added + removed in files under the globs, from `git diff --numstat` output. Pure. */
export function churnOf(numstat: string, globs: string[]): { lines: number; files: string[] } {
  const rows = numstat
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, file] = l.split("\t");
      return { file, lines: (Number(a) || 0) + (Number(d) || 0) };
    });
  const hit = new Set(
    touched(
      rows.map((r) => r.file),
      globs,
    ),
  );
  const mine = rows.filter((r) => hit.has(r.file));
  return { lines: mine.reduce((n, r) => n + r.lines, 0), files: mine.map((r) => r.file) };
}

/** Feature files at a checkout, parsed; a file that doesn't parse is listed with its error. */
function featuresAt(dir: string): { features: Feature[]; broken: { file: string; why: string }[] } {
  const d = path.join(dir, ".kitchen", "toolkit", "features");
  const features: Feature[] = [];
  const broken: { file: string; why: string }[] = [];
  if (!fs.existsSync(d)) return { features, broken };
  for (const f of fs
    .readdirSync(d)
    .filter((x) => x.endsWith(".md") && x !== "README.md")
    .sort()) {
    try {
      features.push(parseFeature(f, fs.readFileSync(path.join(d, f), "utf8")));
    } catch (e) {
      broken.push({ file: f, why: (e as Error).message });
    }
  }
  return { features, broken };
}

/**
 * Whether maintain is due: the feature-mapped paths changed by more than `maintain_churn_lines`
 * since the last maintain (or, before the first one, since the Toolkit was proven). No baseline: not due.
 */
export async function maintainDue(
  repo: string,
  cfg: Pick<Config, "maintain_churn_lines">,
): Promise<{ due: boolean; lines: number; since: string | null; files: string[] }> {
  const since = readMaintain(repo)?.sha ?? readProven(repo)?.sha ?? null;
  if (!since) return { due: false, lines: 0, since, files: [] };
  const git = await openGit(plainCheckout(repo));
  const head = (await git.run(["rev-parse", "HEAD"])).stdout.trim();
  if (head === since) return { due: false, lines: 0, since, files: [] };
  // The feature files as committed at HEAD. Engine git runs with the gitdir as its cwd (inside the work tree for a plain checkout): so --full-tree, full shas, and `--` after revisions.
  const dir = ".kitchen/toolkit/features";
  const names = (await git.run(["ls-tree", "--full-tree", "--name-only", `${head}:${dir}`]).catch(() => ({ stdout: "" }))).stdout
    .split("\n")
    .filter((f) => f.endsWith(".md") && f !== "README.md");
  const globs: string[] = [];
  for (const f of names) {
    try {
      globs.push(...parseFeature(f, (await git.run(["show", `${head}:${dir}/${f}`])).stdout).paths);
    } catch {} // a feature file that doesn't parse maps nothing; maintain itself reports it
  }
  let numstat: string;
  try {
    numstat = (await git.run(["diff", "--numstat", "--no-ext-diff", "--no-textconv", since, head, "--"])).stdout;
  } catch {
    return { due: true, lines: Number.POSITIVE_INFINITY, since, files: [] }; // the baseline is gone (rewritten history)
  }
  const c = churnOf(numstat, globs);
  return { due: c.lines > cfg.maintain_churn_lines, lines: c.lines, since, files: c.files };
}

type Run = { r: AgentResult; text: string | null; secs: number };

export async function maintain(o: {
  repo: string;
  forge: Forge;
  print: (l: string) => void;
  trigger?: string;
  agent?: AgentAdapter;
  maxFix?: number;
}): Promise<MaintainState> {
  const repo = plainCheckout(o.repo).workTree;
  const cfg = loadConfig(repo);
  const say = (l: string) => o.print(`maintain: ${l}`);
  const t0 = Date.now();
  const main = await openGit(plainCheckout(repo));
  const base = (await main.run(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  const dir = workDir(repo, base);
  fs.mkdirSync(dir, { recursive: true });
  const agent = o.agent ?? (await adapterFor(repo, cfg));
  const roleText = roleFile("maintainer", repo) ?? fs.readFileSync(path.join(ROLES_DIR, "maintainer.md"), "utf8");
  let usd = 0;
  const ledgerKey = `maintain/${base.slice(0, 12)}`;
  const run = async (
    role: "maintain-source" | "maintain-fix",
    req: Omit<AgentRequest, "role" | "model" | "timeoutSec" | "maxTurns" | "env">,
    label: string,
  ): Promise<Run> => {
    const model = modelFor(cfg, role);
    const s = Date.now();
    say(`${label}: ${agent.name} ${model} (${req.tier}) …`);
    const r = await agent.run({
      ...req,
      role,
      model,
      timeoutSec: cfg.agent.timeout_sec,
      maxTurns: role === "maintain-fix" ? Math.max(cfg.agent.max_turns, 120) : cfg.agent.max_turns,
      env: buildAgentEnv(path.join(kitchenHome(), "agent-scrub")),
    });
    const secs = (Date.now() - s) / 1000;
    usd += r.usage?.usd ?? 0;
    appendLedger(repo, {
      job: "-",
      stage: "maintain",
      round: 0,
      event: "agent",
      key: `${ledgerKey}/${label}/${s}`,
      result: r.ok ? "ok" : r.rateLimited ? "rate-limited" : "error",
      role,
      agent: agent.name,
      model,
      secs,
      usd: r.usage?.usd,
      detail: { line: r.line, error: r.error, inTok: r.usage?.inTok, outTok: r.usage?.outTok },
    });
    let text: string | null = null;
    if (r.outPath && fs.existsSync(r.outPath)) {
      text = fs.readFileSync(r.outPath, "utf8");
      writeAtomic(path.join(dir, req.outFile), text);
      fs.rmSync(r.outPath, { force: true });
    }
    say(
      `${label}: ${r.ok ? "done" : `failed: ${r.error}`} in ${Math.round(secs)}s${r.usage?.usd !== undefined ? `, $${r.usage.usd.toFixed(3)}` : ""}  ${r.line.slice(0, 160)}`,
    );
    return { r, text, secs };
  };
  const finish = (s: Omit<MaintainState, "sha" | "at" | "usd" | "secs" | "trigger">): MaintainState => {
    const st: MaintainState = {
      sha: base,
      at: new Date().toISOString(),
      usd: Math.round(usd * 10000) / 10000,
      secs: Math.round((Date.now() - t0) / 1000),
      trigger: o.trigger ?? "kitchen toolkit maintain",
      ...s,
    };
    writeAtomic(maintainFile(repo), `${JSON.stringify(st, null, 2)}\n`);
    appendLedger(repo, {
      job: "-",
      stage: "maintain",
      round: 0,
      event: "maintain",
      key: `${ledgerKey}/${st.at}`,
      result: st.outcome,
      usd: st.usd,
      secs: st.secs,
      detail: { ...st },
    });
    say(
      `${st.outcome}${st.why ? ` (${st.why})` : ""}${st.pr !== undefined ? `: Toolkit PR #${st.pr} (${st.branch})` : ""}; ${st.secs}s, $${st.usd.toFixed(3)}`,
    );
    return st;
  };

  // 0. The base's Toolkit, in the engine-owned clean checkout.
  const co = await toolkitCheckout(repo, base);
  const { features, broken } = featuresAt(co.dir);
  say(
    `base ${base.slice(0, 12)}: ${features.length} feature file(s)${broken.length ? `, ${broken.length} unreadable (${broken.map((b) => b.file).join(", ")})` : ""}`,
  );

  // 1. Source wave: one read-only reader per feature file, in parallel (the checkout is leased meanwhile).
  const reports = new Map<string, { drift: boolean; text: string }>();
  const queue = [...features];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(cfg.concurrency, queue.length)) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const stem = f.file.replace(/\.md$/, "");
        const { text } = await run(
          "maintain-source",
          {
            prompt: [
              pickMode(roleText, "source"),
              "",
              "# This pass",
              `Repository (clean checkout of the base, read only): ${co.dir}`,
              `Your feature file: ${path.join(co.dir, ".kitchen", "toolkit", "features", f.file)}`,
              `Its mapped source paths: ${f.paths.join(", ")}`,
              `Its drives: ${f.drives.map((d) => d.name).join(", ")}`,
              `Toolkit docs: ${path.join(co.dir, ".kitchen", "toolkit", "SKILL.md")}`,
              `Write: source-${stem}.md`,
            ].join("\n"),
            cwd: co.dir,
            tier: "read",
            outFile: `source-${stem}.md`,
            outDir: path.join(dir, "out", `source-${stem}`),
          },
          `source ${f.file}`,
        );
        reports.set(f.file, { drift: /^DRIFT:\s*yes/im.test(text ?? ""), text: text ?? "(no report written)" });
      }
    }),
  ).finally(co.release);

  // 2. Live pass: the full check of the base drives every feature.
  say("live pass: kitchen toolkit check on the base (every feature's check drives)");
  const live = await checkAtRef(repo, { rev: base, print: (l) => o.print(`  ${l}`) });
  const failedFeature = (f: Feature, r: CheckReport) => r.steps.some((s) => !s.ok && f.drives.some((d) => s.step.includes(d.name)));
  const feats = (r: CheckReport | null): MaintainFeature[] =>
    features.map((f) => ({
      file: f.file,
      drift: reports.get(f.file)?.drift ?? false,
      summary: (/\*\*Summary\*\*:?\s*(.*)/.exec(reports.get(f.file)?.text ?? "")?.[1] ?? "").slice(0, 200),
      live: !r ? "not-checked" : failedFeature(f, r) ? "failed" : r.ok ? "ok" : "not-checked",
    }));
  const drifted = features.filter((f) => reports.get(f.file)?.drift);
  if (live.ok && !drifted.length && !broken.length) return finish({ outcome: "clean", features: feats(live), fixes: 0 });
  say(
    `to fix: ${[...(live.ok ? [] : [`live check failed at ${live.failed}`]), ...drifted.map((f) => `drift in ${f.file}`), ...broken.map((b) => `${b.file} unreadable`)].join("; ")}`,
  );

  // 3. Fix on its own branch, Toolkit files only; the engine commits and checks.
  const branch = `kitchen/maintain-${base.slice(0, 12)}`;
  const wt = path.join(repo, ".worktrees", WT_ID);
  await main.run(["worktree", "prune"]);
  if (fs.existsSync(wt)) await main.run(["worktree", "remove", "--force", wt]).catch(() => fs.rmSync(wt, { recursive: true, force: true }));
  await main.run(["worktree", "prune"]);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  await main.run(["worktree", "add", "--quiet", "-B", branch, wt, base]);
  const wtGit = linkedWorktree(repo, WT_ID, wt);
  const git = await openGit(wtGit);
  const maxFix = o.maxFix ?? 2;
  let failures = live.ok ? "" : stepsText(live);
  let session: string | undefined;
  let fixes = 0;
  try {
    for (;;) {
      fixes++;
      const { r, text } = await run(
        "maintain-fix",
        {
          prompt: [
            pickMode(roleText, "fix"),
            "",
            "# This pass",
            `Worktree (your working directory; branch ${branch} off the base ${base.slice(0, 12)}): ${wt}`,
            "",
            "## The live check",
            failures || "The last check passed; the drift below still needs fixing.",
            "",
            "## The source readers",
            ...features.map((f) => `### ${f.file}\n${reports.get(f.file)?.text ?? "(none)"}`),
            ...(broken.length ? ["", "## Feature files that don't parse", ...broken.map((b) => `- ${b.file}: ${b.why}`)] : []),
            "",
            "Write: maintain.md",
          ].join("\n"),
          cwd: wt,
          tier: "write",
          outFile: "maintain.md",
          bridge: setupBridgeServer({ repo, worktree: wt }),
          ...(session ? { resumeSession: session } : {}),
        },
        `fix ${fixes}`,
      );
      session = r.sessionId ?? session;
      if (!r.ok || text === null)
        return finish({ outcome: "blocked", why: `the fixer failed: ${r.error ?? "no maintain.md"}`, features: feats(live), fixes, branch });
      if (!/^STATUS:\s*FIXED/m.test(text))
        return finish({ outcome: "blocked", why: /^REASON:\s*(.*)$/m.exec(text)?.[1] ?? "the fixer did not say FIXED", features: feats(live), fixes, branch });
      // Only Toolkit files are committed; anything else the fixer touched is put back.
      fs.rmSync(path.join(wt, ".kitchen-out"), { recursive: true, force: true });
      const status = (await git.run(["status", "--porcelain", "--untracked-files=all"])).stdout.split("\n").filter(Boolean);
      const outside = status.map((l) => l.slice(3)).filter((p) => !p.startsWith(".kitchen/toolkit/"));
      if (outside.length) {
        say(`kept off the branch (outside the Toolkit): ${outside.join(", ")}`);
        await git.run(["checkout", "--", ...outside.filter((p) => status.some((l) => l.slice(3) === p && !l.startsWith("??")))]).catch(() => {});
        for (const p of outside) if (status.some((l) => l.startsWith("??") && l.slice(3) === p)) fs.rmSync(path.join(wt, p), { recursive: true, force: true });
      }
      await git.run(["add", "-A", "--", ".kitchen/toolkit"]);
      let staged = true;
      try {
        await git.run(["diff", "--cached", "--quiet", "--no-ext-diff"]);
        staged = false;
      } catch {}
      if (!staged) return finish({ outcome: "blocked", why: "the fixer changed no Toolkit file", features: feats(live), fixes, branch });
      await git.run(["commit", "--quiet", "--no-verify", "-m", `kitchen maintain: Toolkit fixes for ${base.slice(0, 12)} (round ${fixes})`], { env: IDENTITY });
      const commit = (await git.run(["rev-parse", "HEAD"])).stdout.trim();
      say(`committed ${commit.slice(0, 12)} on ${branch}; full check on it`);
      // The engine's proof: the full check of that commit (unmerged: bin/dev runs sandboxed), the fixer's worktree as the source.
      const again = await checkAtRef(repo, { rev: commit, src: wt, print: (l) => o.print(`  ${l}`) });
      if (again.ok) {
        const changed = (await main.run(["diff", "--name-only", base, commit])).stdout.split("\n").filter(Boolean);
        const pr = await o.forge.openPr({
          key: `maintain/${base}`,
          branch,
          head: commit,
          title: `Kitchen Toolkit maintenance (${base.slice(0, 8)})`,
          body: [
            "Proven Toolkit fixes from `kitchen toolkit maintain` (pstack's maintain-verification-skill pass).",
            "",
            `Base ${base}; the full \`kitchen toolkit check\` passes on ${commit}.`,
            "",
            "Changed:",
            ...changed.map((f) => `- ${f}`),
            "",
            "Findings:",
            ...features.map(
              (f) => `- ${f.file}: ${reports.get(f.file)?.drift ? "drift" : "no drift"}${failedFeature(f, live) ? ", failed the live pass" : ""}`,
            ),
            "",
            text.trim(),
          ].join("\n"),
        });
        return finish({ outcome: "changed", features: feats(live), fixes, branch, commit, pr });
      }
      if (fixes >= maxFix)
        return finish({
          outcome: "blocked",
          why: `the check of ${commit.slice(0, 12)} still fails at ${again.failed} after ${fixes} fix round(s)`,
          features: feats(live),
          fixes,
          branch,
          commit,
        });
      failures = stepsText(again);
    }
  } finally {
    await main.run(["worktree", "remove", "--force", wt]).catch(() => {});
    await main.run(["worktree", "prune"]).catch(() => {});
  }
}

function stepsText(r: CheckReport): string {
  return r.steps
    .filter((s) => !s.ok)
    .map((s) => `- ${s.step}: ${s.detail ?? ""}${s.tail ? `\n  stderr:\n${s.tail.replace(/^/gm, "    ")}` : ""}`)
    .join("\n");
}
