// The person's verbs (ADR 0009, ADR 0016): ticket, steer, pause, stop, resume, feedback, reject. One function each,
// shared by the CLI and the dashboard; the orchestrator never calls them.
//
// - steer: a message on the job's thread. The orchestrator hands it to the next lane agent (`kitchen job start`
//   quotes unread messages into the brief and marks them read by that lane).
// - pause: a job between lanes parks now; one whose lane agent works parks when that lane finishes.
// - stop: parks the job now. A lane agent still working finds its `kitchen job finish` refused, so its result is dropped.
// - resume: back to the stage it paused in.
// - feedback: answers a job that needs you, or sends a ready or done job back to Build with your words.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { appendLedger } from "../ledger/append.ts";
import { withFileLock } from "../lock.ts";
import { PromptSource } from "../sources/prompt.ts";
import { recordAnswers } from "./clarify.ts";
import { BY_YOU, BY_YOU_STOPPED, isActive, type Job, MoveRefused, move, pausedByYou, STAGES, type Stage } from "./machine.ts";
import { addMessage, checkText, type Message, type MessageKind } from "./messages.ts";
import { createJob, findJob, jobDirOf, updateJob, writeAtomic } from "./store.ts";

export type Out = (line: string) => void;

/**
 * The one way a job moves: under the job lock, through the stage table (machine.ts), logged in the ledger.
 * `check` sees the job as it is on disk and may refuse (a string) before the move is made.
 */
export async function moveJob(
  repo: string,
  id: string,
  to: Stage,
  o: { reason?: string; who: "orchestrator" | "person"; check?: (j: Job) => string | null; patch?: (j: Job) => void } = { who: "orchestrator" },
): Promise<Job> {
  let from: Stage = "intake";
  let round = 1;
  const j = await updateJob(repo, id, (disk) => {
    const why = o.check?.(disk);
    if (why) throw new MoveRefused(why);
    from = disk.stage;
    round = disk.round;
    const n = move(disk, to, { reason: o.reason });
    o.patch?.(n);
    return n;
  });
  appendLedger(repo, {
    job: id,
    stage: from,
    round,
    event: "move",
    key: `${id}/m${j.moves}`,
    result: to,
    detail: { who: o.who, ...(o.reason ? { reason: o.reason } : {}) },
  });
  return j;
}

export async function ticket(repo: string, text: string, out: Out): Promise<number> {
  const cfg = loadConfig(repo);
  const t = PromptSource.ticket(text);
  const job = await createJob(repo, { title: t.title, ticket: t.ref, body: t.body, roundLimit: cfg.round_limit });
  appendLedger(repo, { job: job.id, stage: "intake", round: 1, event: "ticket", key: `${job.id}/ticket` });
  out(`ticket ${job.id}  "${job.title}"  → intake`);
  return 0;
}

type Control = { pause?: string };
const controlFile = (jobDir: string) => path.join(jobDir, "control.json");
export function readControl(jobDir: string): Control {
  try {
    return JSON.parse(fs.readFileSync(controlFile(jobDir), "utf8")) as Control;
  } catch {
    return {};
  }
}
const writeControl = (jobDir: string, c: Control | null) =>
  withFileLock(path.join(jobDir, "control.lock"), async () => {
    if (c) writeAtomic(controlFile(jobDir), JSON.stringify(c));
    else fs.rmSync(controlFile(jobDir), { force: true });
  });
export const clearControl = (repo: string, id: string) => writeControl(jobDirOf(repo, id), null);

/** A job's state in a person's words, for a refusal. */
function stateWords(j: Job): string {
  if (pausedByYou(j)) return j.pausedReason === BY_YOU_STOPPED ? "stopped by you" : "paused by you";
  return j.stage;
}

export async function pause(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (!isActive(job.stage)) {
    out(job.stage === "paused" ? `${job.id}  is already ${stateWords(job)}; kitchen resume wakes it` : `${job.id}  is ${job.stage}: nothing running to pause`);
    return 1;
  }
  if (job.running) {
    await writeControl(jobDirOf(repo, job.id), { pause: new Date().toISOString() });
    out(`${job.id}  pausing after the current step (${job.stage})`);
    return 0;
  }
  await moveJob(repo, job.id, "paused", { reason: BY_YOU, who: "person" });
  out(`${job.id}  paused`);
  return 0;
}

export async function stop(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (!isActive(job.stage)) {
    out(job.stage === "paused" ? `${job.id}  is already ${stateWords(job)}; kitchen resume wakes it` : `${job.id}  is ${job.stage}: nothing running to stop`);
    return 1;
  }
  await clearControl(repo, job.id);
  const was = job.running?.lane;
  await moveJob(repo, job.id, "paused", { reason: BY_YOU_STOPPED, who: "person" });
  out(`${job.id}  stopped${was ? ` (the ${was} agent's result will be dropped)` : ""}`);
  return 0;
}

export async function resume(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (job.stage !== "paused") {
    if (readControl(jobDirOf(repo, job.id)).pause) {
      await clearControl(repo, job.id);
      out(`${job.id}  pause cancelled`);
      return 0;
    }
    out(
      `${job.id}  is ${job.stage}: ${job.stage === "needs-info" || job.stage === "needs-human" ? `it needs your answer: kitchen feedback ${job.id} "…"` : "nothing to resume"}`,
    );
    return 1;
  }
  const to = job.pausedFrom ?? "intake";
  await moveJob(repo, job.id, to, { who: "person" });
  out(`${job.id}  resumed → ${to}`);
  return 0;
}

/** `kitchen steer <id> "<text>"`: a message the next lane agent reads. */
export async function steer(repo: string, ref: string, text: string, out: Out): Promise<{ code: number; message?: Message }> {
  const job = findJob(repo, ref);
  const t = checkText(text);
  if ("refused" in t) {
    out(`${job.id}  not sent: ${t.refused}`);
    return { code: 1 };
  }
  if (job.stage === "needs-info" || job.stage === "needs-human") {
    out(`${job.id}  needs you: answer with kitchen feedback ${job.id} "…"`);
    return { code: 1 };
  }
  if (!isActive(job.stage) && job.stage !== "paused") {
    out(`${job.id}  is ${job.stage}: ${job.stage === "done" || job.stage === "ready" ? `follow up with kitchen feedback ${job.id} "…"` : "nothing to steer"}`);
    return { code: 1 };
  }
  const message = await addMessage(jobDirOf(repo, job.id), { kind: "steer", text: t.text, stage: job.stage });
  appendLedger(repo, { job: job.id, stage: job.stage, round: job.round, event: "steer", key: `${job.id}/steer/${message.id}` });
  out(
    `${job.id}  ${message.id} sent: ${
      job.stage === "paused"
        ? "it is read when you resume"
        : job.running
          ? `the next agent reads it (the ${job.running.lane} agent works now)`
          : "the next agent reads it"
    }`,
  );
  return { code: 0, message };
}

const STAGE_LIST = STAGES as readonly string[];

/**
 * `kitchen feedback <id> ["<text>"] [--to <stage>]`: answer a job that needs you (needs-info → intake; needs-human →
 * the stage it stopped in, or `--to`), or send a ready or done job back to Build with your words.
 */
export async function feedback(repo: string, ref: string, text: string, out: Out, o: { to?: string } = {}): Promise<number> {
  const job = findJob(repo, ref);
  const dir = jobDirOf(repo, job.id);
  const t = text.trim() ? checkText(text) : null;
  if (t && "refused" in t) {
    out(`${job.id}  not sent: ${t.refused}`);
    return 1;
  }
  const say = async (kind: MessageKind) => (t ? addMessage(dir, { kind, text: t.text, stage: job.stage }) : null);
  if (job.stage === "needs-info") {
    if (!t) {
      out(`${job.id}  needs an answer: kitchen feedback ${job.id} "<your answer>"`);
      return 1;
    }
    new PromptSource(repo).reply(job, t.text);
    recordAnswers(dir, [t.text]);
    await say("answer");
    await moveJob(repo, job.id, "intake", { who: "person" });
    out(`${job.id}  answered → intake`);
    return 0;
  }
  if (job.stage === "needs-human") {
    const to = (o.to ?? job.escalatedFrom ?? "build") as Stage;
    if (!STAGE_LIST.includes(to) || !["intake", "build", "qa", "review"].includes(to)) {
      out(`${job.id}  --to takes intake, build, qa or review`);
      return 1;
    }
    await say("answer");
    await moveJob(repo, job.id, to, { who: "person" });
    out(`${job.id}  → ${to}`);
    return 0;
  }
  if (job.stage === "done" || job.stage === "ready") {
    if (!t) {
      out(`${job.id}  is ${job.stage}: say what to change, kitchen feedback ${job.id} "<what>"`);
      return 1;
    }
    await say("follow-up");
    await moveJob(repo, job.id, "build", { who: "person" });
    out(`${job.id}  follow-up → build (round ${job.round + 1})`);
    return 0;
  }
  out(`${job.id}  is ${stateWords(job)}: ${isActive(job.stage) || job.stage === "paused" ? `use kitchen steer ${job.id} "…"` : "nothing to answer"}`);
  return 1;
}

export async function reject(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (job.stage === "rejected" || job.stage === "done") {
    out(`${job.id}  is ${job.stage}: nothing to reject`);
    return 1;
  }
  await moveJob(repo, job.id, "rejected", { reason: "rejected by you", who: "person" });
  out(`${job.id}  rejected`);
  return 0;
}
