// `kitchen verify sweep|maintain|finish` (ADR 0017 §6): thin. Kitchen prepares the run (a checkout of staging, the
// app, a brief and the agent's prompt) and reads its result; one agent, started by the orchestrator like a lane
// agent, does the driving.
//
// - sweep: drives every feature in the README's order against staging, writes a sweep report, changes nothing.
// - maintain: the pstack maintain pass (MIT © 2026 Lauren Tan, see NOTICE) on a branch of staging: index hygiene,
//   each feature read from its `Code:` and driven live, every finding sorted as doc drift, harness gap or product
//   regression. It edits only the verify skill; a product regression becomes a new ticket (`kitchen ticket`), never
//   a weaker map. `finish` refuses edits outside the skill and removals without a reason, then lands the branch
//   through the merge gate jobs use (a trial merge, the checks, compare-and-swap on staging).
import fs from "node:fs";
import path from "node:path";
import { type Config, loadConfig, modelFor } from "../config.ts";
import { git, gitOut, revParse } from "../engine/git.ts";
import { readFeatureVerdict } from "../engine/lanes.ts";
import type { Job } from "../engine/machine.ts";
import { mergeToStaging, stagingTip } from "../engine/staging.ts";
import { writeAtomic } from "../engine/store.ts";
import { appDown, appUp } from "../qa/app.ts";
import { KITCHEN_IDENTITY, mapAt } from "./admit.ts";
import { allFeaturesSection } from "./brief.ts";
import { type Feature, isVerifyPath, readMap, removals, SKILL_ROOTS, sweepOrder } from "./map.ts";
import { isRunId, runDir, runEvidence, runWorktree } from "./paths.ts";

export type Out = (l: string) => void;
const ROLES = path.resolve(import.meta.dirname, "..", "..", "roles");
type Kind = "sweep" | "maintain";
/**
 * `url`: a sweep against a deployed environment (ADR 0021 §3): no local app, recipes driven there. `seeded`: the
 * features whose recipes need a reset or seed, which such a sweep reports as not run. Kept in the run, never in a job.
 */
type RunInfo = { kind: Kind; id: string; at: string; onto: string; branch?: string; features: string[]; brief: string; url?: string; seeded?: string[] };
export type Prepared = { id: string; kind: Kind; brief: string; cwd: string; model: string; prompt: string; app: string };

const stampId = (kind: Kind, d = new Date()) => `${kind}-${d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
const runFile = (repo: string, id: string) => path.join(runDir(repo, id), "run.json");

export function readRun(repo: string, id: string): RunInfo {
  if (!isRunId(id)) throw new Error(`${id} is not a verify run id (sweep-… or maintain-…)`);
  try {
    return JSON.parse(fs.readFileSync(runFile(repo, id), "utf8")) as RunInfo;
  } catch {
    throw new Error(`no verify run ${id} (.kitchen/verify/${id}/run.json)`);
  }
}

/** Pure: the feature's recipe needs fresh seed data (a reset or seed step), which a deployed environment can't give. */
export const needsSeed = (f: Pick<Feature, "text">): boolean => {
  const drive = /## Driving it with kitchen qa([\s\S]*?)(\n## |$)/.exec(f.text)?.[1] ?? "";
  return /kitchen qa reset|app\.reset|\bseed(ed)?\b/i.test(drive);
};

/**
 * Open a run: staging checked out (on a branch for maintain), the app up, the brief and the prompt written. `url`
 * (sweep only): drive that deployed environment instead; nothing starts locally.
 */
export async function prepare(repo: string, kind: Kind, out: Out, now = new Date(), o: { url?: string } = {}): Promise<Prepared> {
  if (o.url !== undefined) {
    if (kind !== "sweep") throw new Error("--url is for kitchen verify sweep: map upkeep drives staging's own app");
    if (!/^https?:\/\/[^\s/]+/.test(o.url)) throw new Error(`--url takes an http(s) URL, got ${o.url}`);
  }
  const cfg = loadConfig(repo);
  const onto = await stagingTip(repo, cfg);
  if (!onto) throw new Error(`there is no ${cfg.staging.branch} branch (kitchen init creates it)`);
  const id = stampId(kind, now);
  const dir = runDir(repo, id);
  if (fs.existsSync(dir)) throw new Error(`${id} exists already; wait a second and try again`);
  fs.mkdirSync(runEvidence(repo, id), { recursive: true });
  const wt = runWorktree(repo, id);
  const branch = kind === "maintain" ? `kitchen/verify-${id}` : undefined;
  await git(repo, ["worktree", "add", "-q", ...(branch ? ["-b", branch] : ["--detach"]), wt, onto]);
  const map = readMap(wt);
  const ordered = sweepOrder(map.readme, map.features);
  const brief = path.join(dir, "brief.md");
  const url = o.url?.replace(/\/$/, "");
  const info: RunInfo = {
    kind,
    id,
    at: now.toISOString(),
    onto,
    ...(branch ? { branch } : {}),
    features: ordered.map((f) => f.id),
    brief,
    ...(url ? { url, seeded: ordered.filter(needsSeed).map((f) => f.id) } : {}),
  };
  writeAtomic(runFile(repo, id), `${JSON.stringify(info, null, 2)}\n`);
  const lines: string[] = [];
  const code = url ? 0 : cfg.app.start ? await appUp(repo, id, (l) => lines.push(l), cfg) : 1;
  const app = url
    ? `app: the deployed environment at ${url} (nothing started locally)`
    : cfg.app.start
      ? (lines.find((l) => l.startsWith("app:")) ?? "app: ?")
      : "app: none configured (kitchen.yaml has no app.start)";
  writeAtomic(brief, briefText(repo, cfg, info, wt, map, ordered, app, code === 0));
  const prompt = [
    `You are Kitchen's ${kind === "sweep" ? "sweep" : "map upkeep"} agent (run ${id}).`,
    `First run \`cd ${wt}\`. Then read your brief, ${brief}, and follow it exactly.`,
    kind === "sweep" ? "Change nothing: no file in the checkout, no commit." : "Edit only the verify skill, and commit only on the run's branch.",
    "Don't run `kitchen job` or `kitchen verify` commands, git push or git merge. When you are done, reply with the one line your brief asks for.",
  ].join(" ");
  out(
    `${kind} ${id}: ${ordered.length} feature${ordered.length === 1 ? "" : "s"} (${ordered.map((f) => f.id).join(", ") || "the map is empty"}) on ${cfg.staging.branch} ${onto.slice(0, 7)} · ${app}`,
  );
  return { id, kind, brief, cwd: wt, model: modelFor(cfg, "qa"), prompt, app };
}

function briefText(
  repo: string,
  cfg: Config,
  r: RunInfo,
  wt: string,
  map: ReturnType<typeof readMap>,
  ordered: ReturnType<typeof sweepOrder>,
  app: string,
  up: boolean,
): string {
  const role = fs.readFileSync(path.join(ROLES, `${r.kind}.md`), "utf8");
  const ev = runEvidence(repo, r.id);
  return [
    `# Kitchen verify ${r.kind}: run ${r.id}`,
    "",
    `- Repository (main checkout, read-only for you): ${repo}`,
    `- Checkout to drive: ${wt}, ${cfg.staging.branch} at ${r.onto.slice(0, 12)}${r.branch ? ` on branch ${r.branch} (commit your map fixes here)` : " (detached; change nothing)"}`,
    `- Evidence folder: ${ev}/`,
    r.url
      ? `- The app: the deployed environment at ${r.url}. Kitchen started nothing: \`kitchen qa page|http ${r.id} <path>\` drive ${r.url}; \`kitchen qa up|reset\` refuse. The checkout is only where the map is read: what is deployed may differ from it.`
      : `- The app: ${up ? `${app.replace(/^app: /, "")}. Kitchen started it; \`kitchen qa … ${r.id}\` drives it.` : `${app.replace(/^app: /, "")}. Start it with \`kitchen qa up ${r.id}\` when a feature needs it.`}`,
    `- The verify skill: ${map.name ? `${wt}/.claude/skills/${map.name}/SKILL.md` : "none on staging yet"}`,
    `- Your output: ${r.kind === "sweep" ? `verdict.json in ${ev}/` : `report.json in ${ev}/, and your map fixes committed on ${r.branch}`}`,
    "",
    r.url
      ? `Use \`kitchen qa page|http\` with the run id in place of a job id. Evidence lands in the evidence folder.`
      : "Use `kitchen qa up|down|reset|page|http` with the run id in place of a job id. Evidence lands in the evidence folder.",
    "",
    r.url ? deployedSection(r) : "",
    allFeaturesSection(map, ordered),
    role,
  ].join("\n");
}

/** A `--url` sweep's rules: drive the deployed URL, and which features to report as not run. */
function deployedSection(r: RunInfo): string {
  const seeded = r.seeded ?? [];
  return [
    `## Against a deployed environment (${r.url})`,
    "",
    `This sweep drives ${r.url}, not an app Kitchen started. Change nothing there beyond what a recipe's steps do as a user would.`,
    "",
    seeded.length
      ? `These features' recipes need a reset or fresh seed data, which a deployed environment can't give: don't drive them. Give each a row \`{ "id": "<feature>", "result": "NOT_RUN", "evidence": [], "note": "not run: needs a fresh seed" }\`: ${seeded.join(", ")}.`
      : "No feature's recipe needs a reset or seed: drive them all.",
    "",
  ].join("\n");
}

/** Close a run: read the agent's result, write the report, stop the app, remove the checkout (evidence stays). */
export async function finishRun(repo: string, id: string, out: Out): Promise<number> {
  const r = readRun(repo, id);
  await appDown(repo, id).catch(() => {});
  return r.kind === "sweep" ? finishSweep(repo, r, out) : finishMaintain(repo, r, out);
}

async function dropCheckout(repo: string, id: string) {
  await git(repo, ["worktree", "remove", "--force", runWorktree(repo, id)], { allowFail: true });
  fs.rmSync(runWorktree(repo, id), { recursive: true, force: true });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function reportHtml(title: string, sub: string, rows: { id: string; result: string; note: string; evidence: string[] }[], extra = ""): string {
  const tr = rows
    .map(
      (x) =>
        `<tr><td>${esc(x.id)}</td><td class="${x.result === "PASS" ? "ok" : x.result === "NOT_RUN" ? "st" : "bad"}">${esc(x.result.replace("_", " "))}</td><td>${esc(x.note)}<br><small>${x.evidence.map((e) => `<a href="evidence/${encodeURIComponent(e)}">${esc(e)}</a>`).join(" · ")}</small></td></tr>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#e5e5ea;--ok:#1a7f37;--bad:#c62828}
@media (prefers-color-scheme: dark){:root{--bg:#111;--fg:#f2f2f2;--mut:#a1a1a6;--line:#2c2c2e;--ok:#3fb950;--bad:#ff6b6b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:900px;margin:0 auto;padding:24px 16px}
td{border-top:1px solid var(--line);padding:8px 6px;vertical-align:top}table{width:100%;border-collapse:collapse}.ok{color:var(--ok)}.bad{color:var(--bad)}small,.st{color:var(--mut)}a{color:inherit}</style></head>
<body><main><h1>${esc(title)}</h1><p class="st">${esc(sub)}</p><table>${tr || "<tr><td>No features in the map.</td></tr>"}</table>${extra}</main></body></html>
`;
}

async function finishSweep(repo: string, r: RunInfo, out: Out): Promise<number> {
  const ev = runEvidence(repo, r.id);
  const v = readFeatureVerdict(ev, r.features, { notRun: r.url ? (r.seeded ?? []) : [] });
  if ("refused" in v) {
    out(`refused: ${v.refused} (the agent fixes its verdict.json; then kitchen verify finish ${r.id} again)`);
    return 1;
  }
  const file = path.join(runDir(repo, r.id), "report.html");
  writeAtomic(
    file,
    reportHtml(
      `Sweep ${r.id}: ${v.verdict}`,
      r.url
        ? `Every feature of the verify map (staging at ${r.onto.slice(0, 12)}), in sweep order, against the deployed environment at ${r.url}. Nothing was changed.`
        : `Every feature of the verify map, in sweep order, against staging at ${r.onto.slice(0, 12)}. Nothing was changed.`,
      v.features,
    ),
  );
  await dropCheckout(repo, r.id);
  for (const f of v.features) out(`${f.result.padEnd(4)}  ${f.id}: ${f.note}`);
  const notRun = v.features.filter((f) => f.result === "NOT_RUN").length;
  out(
    `sweep ${r.id}: ${v.verdict} (${v.features.filter((f) => f.result === "PASS").length} of ${v.features.length} features${notRun ? `, ${notRun} not run: need a fresh seed` : ""})${r.url ? ` against ${r.url}` : ""} · report ${path.relative(repo, file)}`,
  );
  return 0;
}

type MaintainReport = {
  outcome: "clean" | "changed" | "blocked";
  summary?: string;
  features: { id: string; result: "PASS" | "FAIL" | "UNREACHABLE"; note: string; evidence?: string[] }[];
  removals?: { item: string; why: string }[];
  tickets?: string[];
};

async function finishMaintain(repo: string, r: RunInfo, out: Out): Promise<number> {
  const cfg = loadConfig(repo);
  const ev = runEvidence(repo, r.id);
  const wt = runWorktree(repo, r.id);
  const branch = r.branch as string;
  let rep: MaintainReport;
  try {
    rep = JSON.parse(fs.readFileSync(path.join(ev, "report.json"), "utf8")) as MaintainReport;
  } catch (e) {
    out(`refused: no readable report.json in ${path.relative(repo, ev)}/: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  if (!["clean", "changed", "blocked"].includes(rep.outcome)) {
    out("refused: report.json's outcome is clean, changed or blocked");
    return 1;
  }
  const missing = r.features.filter((f) => !rep.features?.some((x) => x.id === f));
  if (missing.length && rep.outcome !== "blocked") {
    out(`refused: report.json has no row for ${missing.join(", ")} (every feature is read and driven)`);
    return 1;
  }
  if (fs.existsSync(path.join(wt, ".git")) && (await git(wt, ["status", "--porcelain"])).stdout.trim()) {
    out(`refused: ${wt} has uncommitted changes: commit the map fixes on ${branch}, or put them back`);
    return 1;
  }
  const head = (await revParse(repo, branch)) as string;
  const changed = (await git(repo, ["diff", "--name-only", r.onto, head])).stdout.split("\n").filter(Boolean);
  const outside = changed.filter((p) => !isVerifyPath(p));
  if (outside.length) {
    out(`refused: the upkeep changed files outside the verify skill (${outside.slice(0, 3).join(", ")}): it never edits product code`);
    return 1;
  }
  const rs = removals((await mapAt(repo, r.onto)).features, (await mapAt(repo, head)).features);
  const said = (rep.removals ?? []).filter((x) => x.why?.trim()).map((x) => x.item.toLowerCase());
  // A reason names the item, one of its sub-features (`feature/sub`), or the whole feature (a pruned file).
  const unexplained = rs.filter((x) => ![x.item, x.feature, ...x.subs.map((s) => `${x.feature}/${s}`)].some((k) => said.includes(k.toLowerCase())));
  if (unexplained.length) {
    out(
      `refused: these removals have no reason in report.json's removals: ${unexplained
        .slice(0, 5)
        .map((x) => x.item)
        .join("; ")} (prune only what the app no longer has; a broken feature is a ticket, never a weaker map)`,
    );
    return 1;
  }
  let landed = "";
  if (changed.length) {
    // Both tools read the same skill: the Codex copy mirrors the Claude one, as a Kitchen commit.
    const name = readMap(wt).name;
    if (name) {
      const [main, mirror] = SKILL_ROOTS;
      fs.rmSync(path.join(wt, mirror, name), { recursive: true, force: true });
      fs.cpSync(path.join(wt, main, name), path.join(wt, mirror, name), { recursive: true });
      await git(wt, ["add", "-A", "--", `${mirror}/${name}`]);
      if ((await git(wt, ["diff", "--cached", "--name-only"])).stdout.trim())
        await git(wt, [...KITCHEN_IDENTITY, "commit", "-q", "-m", `Mirror the verify skill for Codex (${r.id})`]);
    }
    const tip = await gitOut(repo, ["rev-parse", branch]);
    if (!cfg.staging.auto_merge) landed = `left on ${branch} (staging.auto_merge is off: a person merges it)`;
    else {
      const job = { id: r.id, title: `Verify map upkeep (${r.id})`, branch, pr: null } as unknown as Job;
      const m = await mergeToStaging(repo, cfg, job, tip, { log: path.join(runDir(repo, r.id), "merge.log") });
      landed = m.ok ? `merged into ${cfg.staging.branch} (${m.sha.slice(0, 7)})` : `not merged: ${m.why} (the branch ${branch} stays)`;
    }
  }
  const rows = (rep.features ?? []).map((f) => ({ id: f.id, result: f.result, note: f.note, evidence: f.evidence ?? [] }));
  const extra = [
    rep.summary ? `<h2>Summary</h2><p>${esc(rep.summary)}</p>` : "",
    rep.removals?.length ? `<h2>Removed from the map</h2><ul>${rep.removals.map((x) => `<li>${esc(x.item)}: ${esc(x.why)}</li>`).join("")}</ul>` : "",
    rep.tickets?.length ? `<h2>Product regressions filed as tickets</h2><ul>${rep.tickets.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "",
    `<h2>Changes</h2><p>${changed.length ? `${esc(changed.join(", "))}: ${esc(landed)}` : "None."}</p>`,
  ].join("");
  const file = path.join(runDir(repo, r.id), "report.html");
  writeAtomic(file, reportHtml(`Map upkeep ${r.id}: ${rep.outcome}`, `The verify map against staging at ${r.onto.slice(0, 12)}.`, rows, extra));
  await dropCheckout(repo, r.id);
  if (!changed.length) await git(repo, ["branch", "-D", branch], { allowFail: true });
  out(
    `maintain ${r.id}: ${rep.outcome}${changed.length ? ` · ${changed.length} file${changed.length === 1 ? "" : "s"} ${landed}` : ""}${rep.tickets?.length ? ` · tickets ${rep.tickets.join(", ")}` : ""} · report ${path.relative(repo, file)}`,
  );
  return 0;
}
