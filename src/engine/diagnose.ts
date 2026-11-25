// ADR 0032 §3: what failed, in three lines: the operation in words, the useful line of its log, and what to do next.
// One helper for the dashboard's card and panel and for the Report. The kinds are Kitchen's own failures (its reasons
// have known words), so nothing here asks an agent.
import fs from "node:fs";
import path from "node:path";
import { type Config, targetOf } from "../config.ts";
import { type Job, QA_BLOCKED } from "./machine.ts";
import { JOB_ID, roundDir } from "./store.ts";

export type FailKind = "checks" | "app" | "lane" | "merge" | "proposals";
export type Diagnosis = { what: string; line: string; next: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes in a command's output
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const USEFUL = /error|failed|cannot|ENOENT|exit|\bFAIL\b/i;
/** A failure in so many words (vitest, jest, pytest, go, tsc, a stack's head): read before anything merely error-ish. */
const FAILURE = /^(FAIL(ED)?\b|--- FAIL|[×✗✕]\s|E\s|\w*Error:|Error\b|panic:)|\berror TS\d+/;
/** A line that says something passed (a ✓ test, `ok` go package, pytest's dots), whatever names it carries. */
const PASSING = /^([✓√✔]\s|ok\s|PASS(ED)?\b)|^\S+\.py\s+\.+(\s+\[\s*\d+%\])?$|\bPASSED\b/;
/** Kitchen's own markers in a log: the command header and its exit line. */
const MARKER = /^(\$ |\[exit [^\]]*\]$|# )/;

/**
 * Pure: the line of a log worth reading. In a log of `$ cmd` sections (checks.log, app.log), only the last section:
 * the checks stop at the first failure, so it is the failing one. Lines that say something passed (`✓ x`, `ok pkg`,
 * pytest's dots) and Kitchen's markers are skipped; the first failure in so many words (FAIL, ×, Error:, error TS,
 * pytest's `E `) wins, else the first line matching error|failed|cannot|ENOENT|exit, else the last line of output,
 * else the last marker (the `[exit n]` alone says something). At most 300 characters.
 */
export function usefulLine(log: string): string {
  const lines = log
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let start = -1;
  lines.forEach((l, i) => {
    if (l.startsWith("$ ")) start = i;
  });
  const sec = start >= 0 ? lines.slice(start) : lines;
  const out = sec.filter((l) => !MARKER.test(l) && !PASSING.test(l));
  const hit = out.find((l) => FAILURE.test(l)) ?? out.find((l) => USEFUL.test(l)) ?? out.at(-1) ?? sec.at(-1) ?? "";
  return hit.length > 300 ? `${hit.slice(0, 299)}…` : hit;
}

/**
 * Pure: what failed, its useful line and the recovery. `o.why`: Kitchen's reason (the line when the log has none);
 * `o.name`: the check (for a lane: how often, "3 times"; for the app: the criteria QA couldn't test, "C2, C4"); `o.lane`: the lane refused; `o.target`: the branch
 * it merges into; `o.ready`: a Ready job (held, not merged), whose way back is Ask for changes.
 */
export function diagnose(
  kind: FailKind,
  log: string,
  o: { why?: string; name?: string; lane?: string; target?: string; ready?: boolean; num?: string } = {},
): Diagnosis {
  const line = usefulLine(log) || o.why || "";
  if (kind === "checks")
    return {
      what: `Checks failed${o.name ? `: ${o.name}` : ""}`,
      line,
      next: "Reply with how to fix it: it goes back to Build for another round",
    };
  // ADR 0029 §2: QA's own words say what is wrong with the environment; the app's log is the raw output.
  if (kind === "app")
    return {
      what: o.name ? `QA couldn't test ${o.name}` : "QA couldn't run: the app or its data",
      line: o.why || line,
      // The dashboard's Reply on this job sends it to QA (its escalatedFrom); the CLI has resume too.
      next: `Fix the environment, then Reply: QA runs again (or kitchen resume ${o.num ?? "<id>"})`,
    };
  // ADR 0029 §6: the findings are kept, and Kitchen proposes them again.
  if (kind === "proposals")
    return { what: "Proposals failed", line: o.why || line, next: "The findings are kept: Kitchen proposes them again on the next wave" };
  if (kind === "merge")
    return {
      what: `Merge into ${o.target ?? "its target"} failed`,
      line,
      // The dashboard's Reply sends this kind to Build (`to: "build"`, checked against the diagnosis by the server).
      next: o.ready ? "Ask for changes to send it back to Build, or merge it yourself" : "Reply with what to change: it goes back to Build",
    };
  const lane = LANE_NAME[o.lane ?? ""] ?? "its lane";
  return {
    what: `Kitchen refused the ${lane} agent's work${o.name ? ` ${o.name}` : ""}`,
    line,
    next: `Reply with what to change: it goes back to ${lane}`,
  };
}
const LANE_NAME: Record<string, string> = { intake: "Intake", build: "Build", qa: "QA", review: "Review", regress: "Merge check" };

export type Failure = Diagnosis & {
  kind: FailKind;
  /** The log, relative to the job folder, or null. */
  log: string | null;
  /** Its last 60 lines (or the reason). */
  raw: string;
};

/** A log's last 64 KB (a failing step's lines are at its end; a long install's output isn't read whole on every poll). */
export const LOG_TAIL = 64 * 1024;
const read = (f: string) => {
  let fd: number;
  try {
    fd = fs.openSync(f, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, LOG_TAIL));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    const t = buf.toString("utf8");
    // Cut mid-file: drop the partial first line.
    return size > buf.length ? t.slice(t.indexOf("\n") + 1) : t;
  } finally {
    fs.closeSync(fd);
  }
};
const tail = (t: string) => t.replace(ANSI, "").trimEnd().split("\n").slice(-60).join("\n");

/**
 * What failed for a job that needs you because a step failed (needs-human, or held at Ready not merged), read from
 * what Kitchen wrote: its reason, and the step's log in the job folder. Null for any other job (a QA FAIL or a
 * blocking review out of rounds have their own words: the criteria and the findings).
 */
export function failureOf(dir: string, j: Job, cfg?: Pick<Config, "staging">): Failure | null {
  // ADR 0029 §6: a finished check whose findings couldn't be proposed.
  const pf = j.check?.proposalsFailed;
  if (pf && j.stage === "done") return { ...diagnose("proposals", "", { why: pf.error }), kind: "proposals", log: null, raw: `proposals failed: ${pf.error}` };
  const ready = j.stage === "ready" && !!j.held?.startsWith("not merged: ");
  if (j.stage !== "needs-human" && !ready) return null;
  const why = (ready ? j.held?.replace(/^not merged: /, "") : j.pausedReason) ?? "";
  const target = cfg ? targetOf(cfg, j) : (j.target ?? "staging");
  const num = JOB_ID.exec(j.id)?.[1] ?? j.id;
  const at = (rel: string, kind: FailKind, o: Parameters<typeof diagnose>[2]): Failure => {
    const text = read(path.join(dir, rel));
    return { ...diagnose(kind, text, { why, target, ready, num, ...o }), kind, log: text ? rel : null, raw: text ? tail(text) : why };
  };
  const rd = path.relative(dir, roundDir(dir, j.round));
  const lane = /^the (\w+) lane failed (\d+) times: /.exec(why);
  const rest = lane ? why.slice(lane[0].length) : why;
  const chk = /^the checks failed: (.+?) \((?:exit |timeout)/.exec(rest);
  if (chk) return at(path.join(rd, "checks.log"), "checks", { name: chk[1], lane: lane?.[1] });
  // ADR 0029 §2: "QA couldn't test C2, C4: <why>", or "QA couldn't run: <why>" (no criterion to name).
  if (QA_BLOCKED.test(rest)) {
    const q = /^QA couldn't (?:test (.+?)|run): ([\s\S]*)$/.exec(rest);
    return at("app.log", "app", { why: q?.[2] ?? rest, name: q?.[1] });
  }
  // A refused lane's reason may quote anything; the merge's own words count only outside one.
  if (ready || (!lane && /keeps moving under it|merge into .* failed/.test(why))) return at(path.join(rd, "merge.txt"), "merge", {});
  if (lane) return { ...diagnose("lane", rest, { why: rest, lane: lane[1], name: `${lane[2]} times` }), kind: "lane", log: null, raw: why };
  return null;
}
