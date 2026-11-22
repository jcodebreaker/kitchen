// One job, as the dashboard's panel shows it (GET /jobs/<id>/detail.json): its stage history with
// what each agent did, the steering thread woven in by time, the criteria with their latest
// results, and the files it changed. Read from .kitchen/ and the agents' own streams only.
import fs from "node:fs";
import path from "node:path";
import { contractOf } from "../engine/contract.ts";
import { isActive, type Job, STAGES, type Stage } from "../engine/machine.ts";
import { type Message, readMessages } from "../engine/messages.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { type LedgerLine, readLedger } from "../ledger/append.ts";
import { activityOf, claudeTranscript, type Ev } from "./activity.ts";
import { agentOf, liveStreams, questionOf, STAGE_NAMES, stateOf } from "./data.ts";

export type Seg = {
  stage: Stage;
  nm: string;
  /** ok, bad (sent back or escalated), run (the agent works now), you, paused, wait. */
  st: "ok" | "bad" | "run" | "you" | "paused" | "skip";
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
};
export type MsgEv =
  | { c: "you"; t: string; at: string; kind: Message["kind"]; status: string; sent: boolean }
  | { c: "ask"; t: string; at: string; who: string };
export type Detail = {
  id: string;
  tl: Seg[];
  crit: { id: string; text: string; st: "ok" | "bad" | "wait"; e: string }[];
};

const EVENTS_PER_SEG = 160;
/** A move that sends a job back: to a person who must decide (intake asking its question is not a failure), or to an earlier stage (a failed check, a contract sent back). */
const sentBack = (from: Stage, to: string) =>
  to === "needs-human" ||
  (to === "needs-info" && from !== "intake") ||
  to === "rejected" ||
  (isActive(from) && isActive(to as Stage) && STAGES.indexOf(to as Stage) < STAGES.indexOf(from));

/** The latest verdict table of the job: criterion → result, evidence and why. */
function verdictRows(dir: string): Map<string, { result: string; e: string }> {
  const out = new Map<string, { result: string; e: string }>();
  const rounds = path.join(dir, "rounds");
  if (!fs.existsSync(rounds)) return out;
  for (const r of fs
    .readdirSync(rounds)
    .filter((x) => /^\d+$/.test(x))
    .sort((a, b) => Number(b) - Number(a))) {
    const f = fs
      .readdirSync(path.join(rounds, r))
      .filter((x) => /^verdict-m\d+\.md$/.test(x))
      .sort((a, b) => Number(/\d+/.exec(b)?.[0]) - Number(/\d+/.exec(a)?.[0]))[0];
    if (!f) continue;
    for (const m of fs.readFileSync(path.join(rounds, r, f), "utf8").matchAll(/^\|\s*(C\d+)\s*\|[^|]*\|\s*([A-Z-]+)\s*\|([^|]*)\|([^|]*)\|/gm))
      out.set(m[1], { result: m[2], e: [m[3].trim(), m[4].trim()].filter(Boolean).join(" · ") });
    return out;
  }
  return out;
}

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
    const bad = to !== null && sentBack(stage, to);
    const round = l?.round ?? j.round;
    const note = (stage === "verify" ? verdictSum(dir, round, m) : "") || (typeof l?.detail?.note === "string" ? l.detail.note : "");
    tl.push({
      stage,
      nm: STAGE_NAMES[stage],
      st: end === null ? "run" : bad ? "bad" : "ok",
      round,
      who,
      start,
      end,
      sum: (bad || stage === "verify" ? note : (runs.at(-1)?.line ?? "")).slice(0, 220),
      evs: evs.slice(-EVENTS_PER_SEG),
      calls: evs.filter((e) => e.c === "tool").length,
      sk,
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
    last.nm = STAGE_NAMES[j.stage];
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
  const rows = verdictRows(dir);
  const crit = (contractOf(dir)?.criteria ?? []).map((c) => {
    const r = rows.get(c.id);
    return {
      id: c.id,
      text: c.text,
      st: (!r ? "wait" : r.result === "PASS" ? "ok" : "bad") as "ok" | "bad" | "wait",
      e: r ? `${r.result}${r.e ? ` · ${r.e}` : ""}` : "",
    };
  });
  return { id: j.id, tl, crit };
}
