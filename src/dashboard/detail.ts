// One job, as the dashboard's panel shows it (GET /jobs/<id>/detail.json): its stage history with what each lane
// agent did (its activity stream), the steering thread woven in by time, the criteria with QA's latest results.
// Read from .kitchen/ only.
import fs from "node:fs";
import path from "node:path";
import { type Config, loadConfig, targetOf } from "../config.ts";
import { testedLine, versionsLine } from "../engine/checked.ts";
import { type Failure, failureOf } from "../engine/diagnose.ts";
import { checkFindingKey, criteriaOf, qaDir, readQa } from "../engine/lanes.ts";
import { CATCH_UP_LIMIT, isActive, isCheck, type Job, prOpen, STAGES, type Stage } from "../engine/machine.ts";
import { type Message, readMessages } from "../engine/messages.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { listItems, listProposals } from "../inbox/store.ts";
import { type LedgerLine, readLedger } from "../ledger/append.ts";
import { activityOf, type Ev } from "./activity.ts";
import { agentOf, type Crit, critOf, liveStreams, questionOf, STAGE_NAMES, stateOf } from "./data.ts";

export type Seg = {
  stage: Stage;
  nm: string;
  /** ok, bad (sent back or escalated), run (an agent works now), you, paused, skip. */
  st: "ok" | "bad" | "back" | "run" | "you" | "paused" | "skip";
  round: number;
  who: string;
  start: string;
  end: string | null;
  sum: string;
  evs: (Ev | MsgEv)[];
  calls: number;
  sk?: string[];
};
export type MsgEv =
  | { c: "you"; t: string; at: string; kind: Message["kind"]; status: string; sent: boolean }
  /** ADR 0032 §3: `diag`, a failed step's three lines and raw output, in place of the raw reason. */
  | { c: "ask"; t: string; at: string; who: string; diag?: Failure }
  | { c: "sys"; t: string; at: string };
export type Detail = {
  id: string;
  tl: Seg[];
  /** `shot`: ADR 0028, a check's screenshot for the criterion (a path under the page, /jobs/<id>/qa/<round>/<file>). */
  crit: (Crit & { shot?: string })[];
  ticket: string;
  /** ADR 0028 §4: what a check found, each with the inbox proposal it became. */
  found?: { pid: string; title: string; seen: string }[];
  /** ADR 0032 §2: what QA tested and the versions in play (the Checks tab's foot); null on a job from before. */
  tested: { line: string; versions: string | null } | null;
};

/**
 * ADR 0028: a check's Checks tab: each criterion with the first screenshot QA cited for it, and each finding with the
 * inbox proposal it became (the engine proposes them in order, so the i-th finding is the i-th proposal).
 */
function checkTab(repo: string, dir: string, j: Job): Pick<Detail, "crit" | "found"> {
  const crit = critOf(dir, j.round, { check: true });
  const criteria = criteriaOf(dir);
  for (let r = j.round; r >= 1; r--) {
    const qa = readQa(dir, r, criteria, { check: true });
    if (!("criteria" in qa) || (!qa.criteria.length && !qa.findings.length)) continue;
    const at = (f: string) => `jobs/${encodeURIComponent(j.id)}/qa/${r}/${f.split("/").map(encodeURIComponent).join("/")}`;
    const ps = j.check?.proposals ?? [];
    return {
      // The icon says pass or fail and the thumbnail is the screenshot: the line under it is QA's note and any other file.
      crit: crit.map((c) => {
        const row = qa.criteria.find((x) => x.id === c.id);
        if (!row) return c;
        const shot = row.evidence.find((f) => /\.(png|jpe?g)$/i.test(f));
        // ADR 0029 §2: "not tested" with its why, from critOf.
        const e = row.result === "NOT_RUN" ? c.e : [row.note, ...row.evidence.filter((f) => f !== shot)].filter(Boolean).join(" · ");
        return { ...c, e, ...(shot ? { shot: at(shot) } : {}) };
      }),
      // By the finding's inbox item (its key keeps QA's numbering), never by position. ADR 0033 §4: missing tooling
      // says so; tooling findings that share a chore all link to it.
      found: qa.findings.flatMap((f, i) => {
        const pid = proposalOf(repo, ps, checkFindingKey(j.id, r, i + 1));
        return pid ? [{ pid, title: f.kind === "tooling" ? `Missing tooling: ${f.title}` : f.title, seen: f.seen }] : [];
      }),
    };
  }
  return { crit, found: [] };
}

/** The proposal (one of the job's `ps`) that took the inbox item keyed `key`, or null. */
function proposalOf(repo: string, ps: string[], key: string): string | null {
  const item = listItems(repo).find((x) => x.key === key);
  if (!item) return null;
  return listProposals(repo).find((p) => ps.includes(p.id) && p.items.includes(item.id))?.id ?? null;
}

/** ADR 0028: a check's screenshot, inside its round's QA folder only; null for anything else. */
export function qaShot(repo: string, id: string, round: number, rel: string): string | null {
  if (!/\.(png|jpe?g)$/i.test(rel)) return null;
  const qd = path.resolve(qaDir(jobDirOf(repo, id), round));
  const f = path.resolve(qd, rel);
  return f.startsWith(`${qd}${path.sep}`) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
}

/** ticket.md's body: everything after the `# <title>` line, at most 4,000 characters. */
export function ticketText(dir: string): string {
  try {
    const t = fs
      .readFileSync(path.join(dir, "ticket.md"), "utf8")
      .replace(/^# [^\n]*\n+/, "")
      .trim();
    return t.length > 4000 ? `${t.slice(0, 3999)}…` : t;
  } catch {
    return "";
  }
}

/** ADR 0028 §5: a schedule's interval as the Activity says it: daily, hourly, every 2 hours. */
const often = (every?: string) => (every === "day" ? "daily" : every === "hour" ? "hourly" : `every ${every ?? "tick"}`);

const EVENTS_PER_SEG = 160;
/** A move that sends a job back: to a person (intake asking its question is not a failure), or to an earlier lane. */
const sentBack = (from: Stage, to: string) =>
  to === "needs-human" ||
  (to === "needs-info" && from !== "intake") ||
  to === "rejected" ||
  (isActive(from) && isActive(to as Stage) && STAGES.indexOf(to as Stage) < STAGES.indexOf(from));

/** How a wait at Ready ended, as its segment says: the person merged it (here or its PR on GitHub), or the merge check went first. */
const readyEnd = (to: string, j: Job, target: string): string | null =>
  to === "done"
    ? j.mergedBy === "github"
      ? `Its PR merged into ${target} on GitHub`
      : `You merged it into ${target}`
    : to === "regress"
      ? "You said merge: the merge check drives the features it touches first"
      : null;

const msgStatus = (m: Message) =>
  m.kind === "answer"
    ? "Answer sent"
    : m.kind === "follow-up"
      ? "Sent · reopened for another round"
      : m.status === "read"
        ? `Read by the ${m.by}`
        : "Sent · the next agent reads it";

export async function detail(repo: string, ref: string): Promise<Detail> {
  const j: Job = findJob(repo, ref);
  const dir = jobDirOf(repo, j.id);
  const roots = [j.worktree, repo];
  const moves = readLedger(repo).filter((l): l is LedgerLine & { result: string } => l.job === j.id && l.event === "move" && typeof l.result === "string");
  const tl: Seg[] = [];
  let stage: Stage = "intake";
  let start = j.startedAt;
  /** ADR 0018: catch-ups in a row so far; a catch-up is a normal step (staging moved), never drawn as a failure. */
  let caught = 0;
  // ADR 0026: the job's target (staging.branch unless it names another).
  let target = j.target || "staging";
  let defaultTarget = "staging";
  let cfg: Config | undefined;
  try {
    cfg = loadConfig(repo);
    target = targetOf(cfg, j);
    defaultTarget = cfg.staging.branch;
  } catch {}
  // ADR 0032 §3: a step that failed and left the job with you: the ask below says it, once (its segment says nothing).
  const failed = failureOf(dir, j, cfg);
  const close = (m: number, end: string | null, to: string | null, l?: LedgerLine) => {
    const catchUp = !!l?.detail?.catchUp;
    const evs = liveStreams(dir, m).flatMap((f) => activityOf(f.file, roots));
    const runs = j.agentRuns.filter((r) => r.key.includes(`/m${m}/`));
    const waited = stage === "needs-human" || stage === "needs-info" || stage === "paused" || stage === "ready";
    const who = waited ? "you" : [...new Set(runs.map((r) => `${r.role}${r.model ? ` · ${r.model}` : ""}`))].join(", ");
    const bad = to !== null && !catchUp && sentBack(stage, to);
    const reason = typeof l?.detail?.reason === "string" ? l.detail.reason : "";
    const readyEnded = stage === "ready" && to ? readyEnd(to, j, target) : null;
    tl.push({
      stage,
      nm: STAGE_NAMES[stage],
      st:
        stage === "paused" ? "paused" : end === null ? "run" : catchUp ? "back" : bad ? "bad" : to === "paused" && l?.detail?.who === "person" ? "skip" : "ok",
      round: l?.round ?? j.round,
      who,
      start,
      end,
      sum: (catchUp
        ? `Caught up with ${target} (${caught} of ${CATCH_UP_LIMIT}) · no round spent`
        : readyEnded
          ? readyEnded
          : bad && reason
            ? failed && to === j.stage && l === moves.at(-1)
              ? ""
              : reason
            : (runs.at(-1)?.line ?? reason)
      ).slice(0, 220),
      evs: evs.slice(-EVENTS_PER_SEG),
      calls: evs.filter((e) => e.c === "tool").length,
    });
  };
  moves.forEach((l, i) => {
    if (l.detail?.catchUp) caught++;
    else if (l.result === "build") caught = 0;
    close(i, l.t, l.result, l);
    stage = l.result as Stage;
    start = l.t;
  });
  if (j.stage !== "done") {
    close(moves.length, null, null);
    const last = tl[tl.length - 1];
    last.stage = j.stage;
    last.nm = STAGE_NAMES[j.stage];
    const state = stateOf(j);
    if (prOpen(j) && j.pr) {
      // ADR 0026 §4: a person merges it on GitHub; Kitchen says what it did, plainly, and asks nothing here.
      last.st = "you";
      last.nm = "PR open";
      last.evs.push(
        { c: "sys", t: `Pushed ${j.branch} and opened PR #${j.pr.number} into ${target}, with the report in its body`, at: last.start },
        { c: "sys", t: "A person merges it on GitHub; Kitchen moves it to Done when it merges", at: last.start },
      );
    } else if (state === "you") {
      last.st = "you";
      const diag = failed;
      last.evs.push({
        c: "ask",
        t: diag?.what ?? questionOf(j, dir) ?? "",
        ...(diag ? { diag } : {}),
        at: j.updatedAt,
        // Held at Ready: Kitchen asks (the lanes passed); else the agent that stopped.
        who: diag || j.stage === "ready" ? "Kitchen" : (agentOf(j.stage === "needs-human" ? (j.escalatedFrom ?? "intake") : "intake") ?? "Kitchen"),
      });
    } else if (state === "paused") {
      last.st = "paused";
      last.sum = j.pausedReason?.includes("stopped") ? "Stopped by you" : "Paused by you";
    } else if (state === "rejected") last.st = "skip";
    // ADR 0029 §3: a job waiting for its lane says why on the panel from the card's line (data.json `waiting`).
  }
  for (const m of readMessages(dir)) {
    const seg = [...tl].reverse().find((s) => s.start <= m.at) ?? tl[0];
    if (!seg) continue;
    const i = seg.evs.findIndex((e) => !!e.at && e.at > m.at);
    seg.evs.splice(i < 0 ? seg.evs.length : i, 0, { c: "you", t: m.text, at: m.at, kind: m.kind, status: msgStatus(m), sent: m.status === "sent" });
  }
  // ADR 0022: the first line says where the job came from.
  tl[0]?.evs.unshift({
    c: "sys",
    t: `${j.from ? `Filed from the Outer loop · ${j.from.label}` : j.check?.filedBy === "schedule" ? `Filed by its schedule (${often(j.check.every)})` : "Filed by you (New ticket)"}${target !== defaultTarget ? ` · into ${target}` : ""}`,
    at: j.startedAt,
  });
  const tested = testedLine(j);
  return {
    id: j.id,
    tl,
    ...(isCheck(j) ? checkTab(repo, dir, j) : { crit: critOf(dir, j.round) }),
    ticket: ticketText(dir),
    // The lanes' models are on the Activity segments; the foot says Kitchen's and the tool's versions only.
    tested: tested ? { line: tested, versions: versionsLine(j, { models: false }) } : null,
  };
}
