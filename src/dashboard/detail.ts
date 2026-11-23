// One job, as the dashboard's panel shows it (GET /jobs/<id>/detail.json): its stage history with
// what each agent did, the steering thread woven in by time, the criteria with their latest
// results, and the files it changed. Read from .kitchen/ and the agents' own streams only.
import fs from "node:fs";
import path from "node:path";
import { isActive, type Job, STAGES, type Stage } from "../engine/machine.ts";
import { type Message, readMessages } from "../engine/messages.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { type LedgerLine, readLedger } from "../ledger/append.ts";
import { toolkitState } from "../toolkit/approve.ts";
import { activityOf, claudeTranscript, type Ev } from "./activity.ts";
import { agentOf, critOf, liveStreams, questionOf, STAGE_NAMES, stateOf, toolkitStepName } from "./data.ts";

export type Seg = {
  stage: Stage;
  nm: string;
  /** ok, bad (a real failure: sent back or escalated), back (a normal retry: drives sent it back to gate), run (the agent works now), you, paused, skip. */
  st: "ok" | "bad" | "back" | "run" | "you" | "paused" | "skip";
  round: number;
  /** Agents that ran in it, "role · model". */
  who: string;
  start: string;
  end: string | null;
  sum: string;
  evs: (Ev | MsgEv)[];
  calls: number;
  /** Role skills its agents were given (ADR 0014). */
  sk?: string[];
  /** The Toolkit step ended with a proven Toolkit offered for approval (ADR 0015): its sha, for the Approve action. */
  approve?: string;
};
export type MsgEv =
  | { c: "you"; t: string; at: string; kind: Message["kind"]; status: string; sent: boolean }
  | { c: "ask"; t: string; at: string; who: string };
export type Detail = {
  id: string;
  tl: Seg[];
  crit: { id: string; text: string; st: "ok" | "bad" | "wait"; e: string }[];
  /** The ticket's full text (ticket.md without its title line): the title is short (ADR 0011), the panel shows all of it. */
  ticket: string;
};

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
/**
 * A move back that is the normal path, not a failure: drives sends the job back to gate after the verifier wrote
 * its own test or drive files (they are checked like any other change). Shown neutral, "↻ back to gate".
 */
export const normalRetry = (from: Stage, to: string) => from === "drives" && to === "gate";
/** A move that sends a job back: to a person who must decide (intake asking its question is not a failure), or to an earlier stage (a failed check, a contract sent back). */
const sentBack = (from: Stage, to: string) =>
  to === "needs-human" ||
  (to === "needs-info" && from !== "intake") ||
  to === "rejected" ||
  // The Toolkit step hands the job back to the stage that needed it (returnTo) when it succeeds: not a failure.
  (from !== "toolkit" && isActive(from) && isActive(to as Stage) && STAGES.indexOf(to as Stage) < STAGES.indexOf(from));

/** Verify's outcome for one stage entry (rounds/<round>/verdict-m<m>.md): which criteria failed, or that all passed. */
function verdictSum(dir: string, round: number, m: number): string {
  const f = path.join(dir, "rounds", String(round), `verdict-m${m}.md`);
  if (!fs.existsSync(f)) return "";
  const rows = [...fs.readFileSync(f, "utf8").matchAll(/^\|\s*(C\d+)\s*\|[^|]*\|\s*([A-Z-]+)/gm)].map((x) => ({ id: x[1], r: x[2] }));
  const bad = rows.filter((x) => x.r !== "PASS").map((x) => `${x.id} ${x.r.toLowerCase()}`);
  if (!rows.length) return "";
  if (!bad.length) return `${rows.map((x) => x.id).join(", ")} pass`;
  return `Round ${round}: ${bad.length > 1 ? `${bad.slice(0, -1).join(", ")} and ${bad.at(-1)}` : bad[0]}`;
}

function runEvents(dir: string, j: Job, m: number, roots: string[]): { evs: Ev[]; roles: string[] } {
  const files = liveStreams(dir, m);
  const evs: Ev[] = [];
  const roles: string[] = [];
  for (const f of files) {
    evs.push(...activityOf(f.file, roots));
    roles.push(f.role);
  }
  // Runs from before the stream tee: the Claude session transcript, by the session id job.json kept.
  if (!files.length)
    for (const r of j.agentRuns.filter((x) => x.key.includes(`/m${m}/`))) {
      roles.push(r.role);
      const t = r.adapter === "claude" && r.sessionId ? claudeTranscript(r.sessionId) : undefined;
      if (t) evs.push(...activityOf(t, roots));
    }
  return { evs, roles };
}

const byYou = (l: LedgerLine | undefined) => l?.detail?.note === "kitchen stop" || l?.detail?.note === "kitchen pause";

const msgStatus = (m: Message) =>
  m.kind === "answer"
    ? "Answer sent"
    : m.kind === "follow-up"
      ? "Sent · reopened for another round"
      : m.status === "read"
        ? `Read by ${m.by}${m.via === "mid-run" ? " while it worked" : ""}`
        : "Sent";

export async function detail(repo: string, ref: string): Promise<Detail> {
  const j = findJob(repo, ref);
  const dir = jobDirOf(repo, j.id);
  const roots = [j.worktree, repo];
  const moves = readLedger(repo).filter((l): l is LedgerLine & { result: string } => l.job === j.id && l.event === "move" && typeof l.result === "string");
  const msgs = readMessages(dir);
  // A proven Toolkit waiting for the person's approval (ADR 0015): the smith's offer, if this job made it.
  const tk = toolkitState(repo);
  const offer = tk.state === "waiting" ? tk.sha : undefined;
  const tl: Seg[] = [];
  let stage: Stage = "intake";
  let start = j.startedAt;
  const runsBy = (m: number) => j.agentRuns.filter((r) => r.key.includes(`/m${m}/`));
  const close = (m: number, end: string | null, to: string | null, l?: LedgerLine) => {
    const { evs, roles } = runEvents(dir, j, m, roots);
    const runs = runsBy(m);
    const waited = stage === "needs-human" || stage === "needs-info" || (stage === "paused" && byYou(moves[m - 1]));
    const who = waited ? "you" : [...new Set(runs.length ? runs.map((r) => `${r.role} · ${r.model}`) : roles)].join(", ");
    // The role skills its agents were given (ADR 0014), shown small under the segment.
    const sk = [...new Set(runs.flatMap((r) => (r.skills ?? []).map((s) => s.name)))];
    if (stage === "paused") {
      tl.push({ stage, nm: STAGE_NAMES[stage], st: "paused", round: l?.round ?? j.round, who, start, end, sum: "", evs: [], calls: 0 });
      return;
    }
    if (to === "paused" && byYou(l)) {
      const stopped = l?.detail?.note === "kitchen stop";
      tl.push({
        stage,
        nm: STAGE_NAMES[stage],
        st: stopped ? "skip" : "ok",
        round: l?.round ?? j.round,
        who,
        start,
        end,
        sum: stopped ? "Stopped by you" : "Paused by you after this step",
        evs: evs.slice(-EVENTS_PER_SEG),
        calls: evs.filter((e) => e.c === "tool").length,
        sk,
      });
      return;
    }
    const back = to !== null && normalRetry(stage, to);
    const bad = !back && to !== null && sentBack(stage, to);
    const round = l?.round ?? j.round;
    const note = (stage === "verify" ? verdictSum(dir, round, m) : "") || (typeof l?.detail?.note === "string" ? l.detail.note : "");
    const sum = back
      ? `↻ back to ${STAGE_NAMES[to as Stage].toLowerCase()}${note ? `: ${note}` : ""}`
      : bad || stage === "verify"
        ? note
        : (runs.at(-1)?.line ?? "");
    tl.push({
      stage,
      nm: stage === "toolkit" ? toolkitStepName(j.gap) : STAGE_NAMES[stage],
      st: end === null ? "run" : back ? "back" : bad ? "bad" : "ok",
      round,
      who: stage === "toolkit" && !waited && !who ? "Toolkit smith" : who,
      start,
      end,
      sum: sum.slice(0, 220),
      evs: evs.slice(-EVENTS_PER_SEG),
      calls: evs.filter((e) => e.c === "tool").length,
      sk,
      // Left with a proven Toolkit that waits for the person's approval: the Approve action sits on this step.
      ...(stage === "toolkit" && to !== null && to === (j.returnTo ?? "drives") && offer && offer === j.toolkitRef ? { approve: offer } : {}),
    });
  };
  moves.forEach((l, i) => {
    close(i, l.t, l.result, l);
    stage = l.result as Stage;
    start = l.t;
  });
  // The entry it is in now. A done job ends at Done; a waiting one shows why it waits.
  if (j.stage !== "done") {
    close(moves.length, null, null);
    const last = tl[tl.length - 1];
    last.stage = j.stage;
    last.nm = j.stage === "toolkit" ? toolkitStepName(j.gap) : STAGE_NAMES[j.stage];
    const state = stateOf(j);
    if (state === "you") {
      last.st = "you";
      last.evs.push({
        c: "ask",
        t: questionOf(j, dir) ?? "",
        at: j.updatedAt,
        // A no-toolkit wait is Kitchen's own question, not an agent's (ADR 0010).
        who:
          j.waitFor === "no-toolkit"
            ? "Kitchen"
            : (agentOf(j.stage === "needs-human" ? (j.escalatedFrom ?? "intake") : (tl.at(-2)?.stage ?? "intake")) ?? "Kitchen"),
      });
    } else if (state === "paused") {
      last.st = "paused";
      last.sum = j.pausedReason?.startsWith("by-you")
        ? j.pausedReason.includes("stopped")
          ? "Stopped by you"
          : "Paused by you"
        : `Waiting: ${j.waitFor ?? j.pausedReason}`;
    } else if (state === "rejected") last.st = "skip";
  }
  // The thread, by time, into the entry each message was sent in.
  for (const m of msgs) {
    const seg = [...tl].reverse().find((s) => s.start <= m.at) ?? tl[0];
    if (!seg) continue;
    const i = seg.evs.findIndex((e) => !!e.at && e.at > m.at);
    seg.evs.splice(i < 0 ? seg.evs.length : i, 0, {
      c: "you",
      t: m.text,
      at: m.at,
      kind: m.kind,
      status: msgStatus(m),
      sent: m.kind === "steer" && m.status === "sent",
    });
  }
  const crit = critOf(dir);
  return { id: j.id, tl, crit, ticket: ticketText(dir) };
}
