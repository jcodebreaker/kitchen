// ADR 0032 §2 and §4: what a job's proof stands on. What was tested (the commits, what was left out, the versions in
// play), which kitchen.yaml checks ran, were off or are missing for a language the repo has, and which touched
// features the verify map has a recipe for. Read from the job, kitchen.yaml, the checks' results and the map; the
// Report shows all of it, the panel the first two lines.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CheckSpec, Config } from "../config.ts";
import { detectSources } from "../init/detect-checks.ts";
import { codeMatches, isVerifyPath, touchedFeatures } from "../verify/map.ts";
import { mapIn } from "../verify/where.ts";
import { regressDir } from "./lanes.ts";
import { isCheck, type Job } from "./machine.ts";
import { checksFile, jobDirOf, roundDir } from "./store.ts";

const LANE_WORD: Record<string, string> = { intake: "intake", builder: "build", qa: "QA", reviewer: "review" };
const short = (sha: string) => sha.slice(0, 7);

/** Pure: what QA tested, in words; null for a job from before ADR 0032 (it recorded nothing). */
export function testedLine(j: Pick<Job, "tested" | "branch"> & { kind?: Job["kind"] }): string | null {
  const t = j.tested;
  if (!t) return null;
  const on = j.kind === "check" ? `${t.target} at ${short(t.onto)}` : `${j.branch} at ${short(t.head)}, on ${t.target} at ${short(t.onto)}`;
  const left = t.dirty ? `committed code only: ${t.dirty} uncommitted change${t.dirty === 1 ? "" : "s"} in your checkout left out` : "committed code only";
  return `QA tested ${on} (${t.at.slice(0, 16).replace("T", " ")}) · ${left}`;
}

/**
 * Pure: Kitchen's version, the tool's when known, and (`models`, default on) each lane's model from the job's agent
 * runs (the latest per lane). Null for a job that recorded no `tested` (from before ADR 0032).
 */
export function versionsLine(j: Pick<Job, "tested" | "agentRuns">, o: { models?: boolean } = {}): string | null {
  if (!j.tested) return null;
  const models = new Map<string, string>();
  if (o.models !== false) for (const r of j.agentRuns) if (r.model && LANE_WORD[r.role] && r.stage !== "regress") models.set(LANE_WORD[r.role], r.model);
  return [
    `Kitchen ${j.tested.kitchen}`,
    j.tested.tool ?? "",
    ...["intake", "build", "QA", "review"].flatMap((l) => (models.has(l) ? [`${l} ${models.get(l)}`] : [])),
  ]
    .filter(Boolean)
    .join(" · ");
}

export type CheckLine = { name: string; st: "ok" | "bad" | "wait" | "off" | "none" | "unknown"; note: string };

/** The checks Build ran on the job's latest round that has results (a QA retry round has none: ADR 0029), or null. */
function ranChecks(dir: string, round: number): { name: string; ok: boolean; exit: number | null }[] | null {
  try {
    return JSON.parse(fs.readFileSync(checksFile(dir, round), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The round those results are from, when Build has run since without leaving results (its lane is open, or it was
 * refused before the checks): they are then that round's, not the code's now. A QA retry round (ADR 0029) has no
 * Build: its round's results are the ones before it. Null when they are current.
 */
function staleRound(dir: string, round: number): number | null {
  const f = checksFile(dir, round);
  const from = Number(path.basename(path.dirname(f)));
  if (!fs.existsSync(f) || from === round) return null;
  for (let r = from + 1; r <= round; r++) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(roundDir(dir, r));
    } catch {}
    if (names.some((n) => n.startsWith("brief-build-"))) return from;
  }
  return null;
}

/** Each language's own tools, for telling whether some kitchen.yaml check runs it in another form. */
const TOOLS: Record<string, RegExp> = {
  node: /\b(npm|pnpm|yarn|bun|npx|node|vitest|jest|tsc|eslint|biome)\b/,
  python: /\b(pytest|ruff|mypy|python3?|uv|poetry|unittest|tox)\b/,
  go: /\bgo (test|vet|build)\b/,
  rust: /\bcargo\b/,
  "end-to-end": /\b(e2e|playwright|cypress|integration)\b/,
};
const known = (run: string) => Object.values(TOOLS).some((t) => t.test(run));

/**
 * What the trial merge said about this round, from what Kitchen wrote: a check that failed there (merge.txt's
 * "the checks fail on …(name: exit n)"), or passed (merged, a PR opened on it, its features waiting to be driven or
 * driven), or null when it hasn't run.
 */
function trialMerge(dir: string, j: Job): { failed: string } | { passed: true } | null {
  if (j.merged || j.pr?.onto || j.drive) return { passed: true };
  try {
    const why = fs.readFileSync(path.join(roundDir(dir, j.round), "merge.txt"), "utf8").split("\n")[0] ?? "";
    const m = /^the checks fail on .* \((.+?): (?:exit \S+|timeout|the app did not start)\)$/.exec(why);
    if (m) return { failed: m[1] };
  } catch {}
  return fs.existsSync(path.join(regressDir(dir, j.round), "verdict.json")) ? { passed: true } : null;
}

/** The languages a job's tree has, read from its branch (or the commit it landed as) through git, never a checkout. */
function sourcesAt(repo: string, j: Job): ReturnType<typeof detectSources> | null {
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  const rev = [j.branch, j.merged?.sha, j.tested?.head].find((r) => {
    if (!r) return false;
    try {
      git("rev-parse", "--verify", "--quiet", `${r}^{commit}`);
      return true;
    } catch {
      return false;
    }
  });
  if (!rev) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-tree-"));
  try {
    // The top-level files detection reads (a lockfile only says it is there; yarn.lock's text tells Yarn Berry), and
    // the names in tests/ and test/ (detection only lists them).
    const top = git("ls-tree", "--name-only", rev).split("\n").filter(Boolean);
    for (const f of top) if (DETECTED.test(f)) fs.writeFileSync(path.join(tmp, f), /lock/i.test(f) && f !== "yarn.lock" ? "" : git("show", `${rev}:${f}`));
    for (const d of ["tests", "test"].filter((x) => top.includes(x))) {
      fs.mkdirSync(path.join(tmp, d));
      for (const f of git("ls-tree", "--name-only", `${rev}:${d}`).split("\n").filter(Boolean)) fs.writeFileSync(path.join(tmp, d, f), "");
    }
    return detectSources(tmp);
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const DETECTED =
  /^(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|[Mm]akefile|[\w.-]*lock[\w.-]*|npm-shrinkwrap\.json|\.yarnrc\.yml|ruff\.toml|mypy\.ini|pytest\.ini|conftest\.py|(playwright|cypress)\.config\.\w+)$/;

/**
 * Each kitchen.yaml check with what became of it on this job (passed, failed, not run, on the trial merge, off), then
 * each language the job's tree has that no check covers: red, or muted "can't tell" when some check runs something
 * Kitchen can't read (a Makefile, a script, just, docker compose run) that may run them.
 */
export function checkLines(cfg: Pick<Config, "checkList" | "checksOff">, dir: string, j: Job, repo: string): CheckLine[] {
  const ran = ranChecks(dir, j.round);
  const old = staleRound(dir, j.round);
  const out: CheckLine[] = [];
  const prep = ran?.find((r) => r.name === "prepare" && !r.ok);
  if (prep) out.push({ name: "prepare", st: "bad", note: `failed (exit ${prep.exit ?? "timeout"}): no check ran` });
  const tm = trialMerge(dir, j);
  const failedAt = tm && "failed" in tm ? cfg.checkList.findIndex((c) => c.name === tm.failed) : -1;
  cfg.checkList.forEach((c, i) => {
    const r = ran?.find((x) => x.name === c.name);
    if (c.when === "merge") {
      if (!tm) out.push({ name: c.name, st: "wait", note: "when: merge: runs on the trial merge" });
      else if ("passed" in tm) out.push({ name: c.name, st: "ok", note: "passed on the trial merge" });
      else if (i === failedAt) out.push({ name: c.name, st: "bad", note: "failed on the trial merge" });
      else if (failedAt >= 0 && i < failedAt) out.push({ name: c.name, st: "ok", note: "passed on the trial merge" });
      else out.push({ name: c.name, st: "wait", note: `not run: ${tm.failed} failed on the trial merge first` });
    } else if (r)
      out.push({ name: c.name, st: r.ok ? "ok" : "bad", note: `${r.ok ? "passed" : `failed (exit ${r.exit ?? "timeout"})`}${old ? ` on round ${old}` : ""}` });
    else if (!ran) out.push({ name: c.name, st: "wait", note: "not run yet" });
    else out.push({ name: c.name, st: "wait", note: ran.every((x) => x.ok) ? "not in this run (added since)" : "not run: an earlier check failed" });
  });
  for (const c of cfg.checksOff) out.push({ name: c.name, st: "off", note: `off in kitchen.yaml (${c.run})` });
  const all: CheckSpec[] = [...cfg.checkList, ...cfg.checksOff];
  const opaque = all.find((c) => !known(c.run));
  for (const s of sourcesAt(repo, j) ?? []) {
    const runs = new Set(s.checks.map((c) => c.run));
    if (all.some((c) => runs.has(c.run) || TOOLS[s.label]?.test(c.run))) continue;
    const has = `${s.from} has ${s.checks.map((c) => c.run).join(", ")}`;
    out.push(
      opaque
        ? { name: `${s.label} checks`, st: "unknown", note: `can't tell: ${opaque.run} may run them (${has})` }
        : { name: `${s.label} checks`, st: "none", note: `none in kitchen.yaml (${has})` },
    );
  }
  return out;
}

/** The files a job changed: the diff given, else git's (base...branch), else intake's FILES. */
function changedFiles(repo: string, j: Job, files?: string[]): string[] {
  if (files) return files;
  if (j.base && j.branch)
    try {
      return execFileSync("git", ["-C", repo, "diff", "--name-only", `${j.base}...${j.branch}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split("\n")
        .filter(Boolean);
    } catch {}
  return j.files ?? [];
}

/** `looked`: the touched features without a recipe that a merge check looked at anyway (a row in its verdict). */
export type FeatureLines = { recipe: string[]; none: string[]; looked: string[]; unmapped: string[] };

/** The features any round's merge check gave a row (rounds/<n>/regress/verdict.json). */
function lookedAt(dir: string, round: number): Set<string> {
  const ids = new Set<string>();
  for (let r = round; r >= 1; r--)
    try {
      const v = JSON.parse(fs.readFileSync(path.join(regressDir(dir, r), "verdict.json"), "utf8")) as { features?: { id?: unknown }[] };
      for (const f of v.features ?? []) if (typeof f.id === "string") ids.add(f.id);
    } catch {}
  return ids;
}
/** The verify map against the change: touched features with a recipe (QA drives them), without one, and files no feature covers. */
export function featureLines(repo: string, cfg: Config, j: Job, files?: string[]): FeatureLines | null {
  if (isCheck(j)) return null;
  const changed = changedFiles(repo, j, files).filter((f) => !isVerifyPath(f));
  if (!changed.length) return null;
  const wt = j.worktree && fs.existsSync(j.worktree) ? j.worktree : repo;
  let features: ReturnType<typeof mapIn>["features"] = [];
  try {
    features = mapIn(repo, cfg, wt).features;
  } catch {}
  const touched = touchedFeatures(features, changed);
  return {
    recipe: touched.filter((f) => f.steps.length).map((f) => f.id),
    none: touched.filter((f) => !f.steps.length).map((f) => f.id),
    looked: [...lookedAt(jobDirOf(repo, j.id), j.round)],
    unmapped: changed.filter((x) => !features.some((f) => f.code.some((c) => codeMatches(c, x)))),
  };
}
