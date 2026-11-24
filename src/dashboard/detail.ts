// One job, as the dashboard's panel shows it (GET /jobs/<id>/detail.json): its stage history with what each lane
// agent did (its activity stream), the steering thread woven in by time, the criteria with QA's latest results.
// Read from .kitchen/ only.
import fs from "node:fs";
import path from "node:path";
import { isActive, type Job, STAGES, type Stage } from "../engine/machine.ts";
import { type Message, readMessages } from "../engine/messages.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { type LedgerLine, readLedger } from "../ledger/append.ts";
import { activityOf, type Ev } from "./activity.ts";
import { agentOf, critOf, liveStreams, questionOf, STAGE_NAMES, stateOf } from "./data.ts";

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
  | { c: "ask"; t: string; at: string; who: string }
  | { c: "sys"; t: string; at: string };
export type Detail = { id: string; tl: Seg[]; crit: { id: string; text: string; st: "ok" | "bad" | "wait"; e: string }[]; ticket: string };

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

const EVENTS_PER_SEG = 160;
/** A move that sends a job back: to a person (intake asking its question is not a failure), or to an earlier lane. */
const sentBack = (from: Stage, to: string) =>
  to === "needs-human" ||
  (to === "needs-info" && from !== "intake") ||
  to === "rejected" ||
  (isActive(from) && isActive(to as Stage) && STAGES.indexOf(to as Stage) < STAGES.indexOf(from));

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
  const close = (m: number, end: string | null, to: string | null, l?: LedgerLine) => {
    const evs = liveStreams(dir, m).flatMap((f) => activityOf(f.file, roots));
    const runs = j.agentRuns.filter((r) => r.key.includes(`/m${m}/`));
    const waited = stage === "needs-human" || stage === "needs-info" || stage === "paused";
    const who = waited ? "you" : [...new Set(runs.map((r) => `${r.role}${r.model ? ` · ${r.model}` : ""}`))].join(", ");
    const bad = to !== null && sentBack(stage, to);
    const reason = typeof l?.detail?.reason === "string" ? l.detail.reason : "";
    tl.push({
      stage,
      nm: STAGE_NAMES[stage],
      st: stage === "paused" ? "paused" : end === null ? "run" : bad ? "bad" : to === "paused" && l?.detail?.who === "person" ? "skip" : "ok",
      round: l?.round ?? j.round,
      who,
      start,
      end,
      sum: (bad && reason ? reason : (runs.at(-1)?.line ?? reason)).slice(0, 220),
      evs: evs.slice(-EVENTS_PER_SEG),
      calls: evs.filter((e) => e.c === "tool").length,
    });
  };
  moves.forEach((l, i) => {
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
    if (state === "you") {
      last.st = "you";
      last.evs.push({
        c: "ask",
        t: questionOf(j, dir) ?? "",
        at: j.updatedAt,
        who: agentOf(j.stage === "needs-human" ? (j.escalatedFrom ?? "intake") : "intake") ?? "Kitchen",
      });
    } else if (state === "paused") {
      last.st = "paused";
      last.sum = j.pausedReason?.includes("stopped") ? "Stopped by you" : "Paused by you";
    } else if (state === "rejected") last.st = "skip";
    else if (j.stage === "ready") {
      last.st = "you";
      last.sum = j.held ?? "Ready for you to merge";
    } else if (!j.running) last.sum = "Waiting for its lane to start";
  }
  for (const m of readMessages(dir)) {
    const seg = [...tl].reverse().find((s) => s.start <= m.at) ?? tl[0];
    if (!seg) continue;
    const i = seg.evs.findIndex((e) => !!e.at && e.at > m.at);
    seg.evs.splice(i < 0 ? seg.evs.length : i, 0, { c: "you", t: m.text, at: m.at, kind: m.kind, status: msgStatus(m), sent: m.status === "sent" });
  }
  // ADR 0022: the first line says where the job came from.
  tl[0]?.evs.unshift({ c: "sys", t: j.from ? `Filed from the Outer loop · ${j.from.label}` : "Filed by you (New ticket)", at: j.startedAt });
  return { id: j.id, tl, crit: critOf(dir, j.round), ticket: ticketText(dir) };
}
