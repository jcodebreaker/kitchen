// The person's verbs (ADR 0009, ADR 0016): ticket, steer, pause, stop, resume, feedback, reject. One function each,
// shared by the CLI and the dashboard; the orchestrator never calls them.
//
// - steer: a message on the job's thread. The orchestrator hands it to the next lane agent (`kitchen job start`
//   quotes unread messages into the brief and marks them read by that lane).
// - pause: a job between lanes parks now; one whose lane agent works parks when that lane finishes.
// - stop: parks the job now. A lane agent still working finds its `kitchen job finish` refused, so its result is dropped.
// - resume: back to the stage it paused in.
// - feedback: answers a job that needs you, or sends a ready or done job back to Build with your words.
// - approve: a job intake.confirm holds after intake (ADR 0020 §3) goes to Build on intake's criteria.
// - remove: off the dashboard, any stage: a working lane is stopped (its agent's next tool call is refused by the
//   guard hook, its result dropped), an unfinished job is rejected, its worktree removed; a merged job is only hidden.
//   The folder and the branch stay: restore shows it again. Intake's checkout of the base goes too (ADR 0025 §1).
import fs from "node:fs";
import path from "node:path";
import { endGroup } from "../agents/session.ts";
import { loadConfig } from "../config.ts";
import { appendLedger } from "../ledger/append.ts";
import { unconfirmed, withFileLock } from "../lock.ts";
import { PromptSource } from "../sources/prompt.ts";
import { recordAnswers } from "./clarify.ts";
import { readIntake } from "./lanes.ts";
import {
  BY_YOU,
  BY_YOU_STOPPED,
  isActive,
  isCheck,
  type Job,
  type JobFrom,
  MoveRefused,
  move,
  pausedByYou,
  promotable,
  QA_BLOCKED,
  STAGES,
  type Stage,
} from "./machine.ts";
import { addMessage, checkText, type Message, type MessageKind } from "./messages.ts";
import { numOf } from "./refine.ts";
import { realGh, refuseTarget } from "./staging.ts";
import { createJob, findJob, intakeCheckoutOf, jobDirOf, shortTitle, updateJob, worktreeOf, writeAtomic } from "./store.ts";

export type Out = (line: string) => void;

/**
 * The one way a job moves: under the job lock, through the stage table (machine.ts), logged in the ledger.
 * `check` sees the job as it is on disk and may refuse (a string) before the move is made.
 */
export async function moveJob(
  repo: string,
  id: string,
  to: Stage,
  o: {
    reason?: string;
    who: "orchestrator" | "person";
    check?: (j: Job) => string | null;
    patch?: (j: Job) => void;
    catchUp?: boolean;
    mergedOnGitHub?: boolean;
  } = {
    who: "orchestrator",
  },
): Promise<Job> {
  let from: Stage = "intake";
  let round = 1;
  const j = await updateJob(repo, id, (disk) => {
    const why = o.check?.(disk);
    if (why) throw new MoveRefused(why);
    from = disk.stage;
    round = disk.round;
    const n = move(disk, to, { reason: o.reason, catchUp: o.catchUp, mergedOnGitHub: o.mergedOnGitHub });
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
    detail: { who: o.who, ...(o.reason ? { reason: o.reason } : {}), ...(o.catchUp ? { catchUp: true } : {}) },
  });
  // ADR 0029 §5: every way out of a lane stops the job's app (done, rejected, needs-human, paused or stopped).
  if (LEFT_LANES.includes(to)) await (await import("../qa/app.ts")).appDown(repo, id).catch(() => {});
  return j;
}
const LEFT_LANES: readonly Stage[] = ["done", "rejected", "needs-human", "paused"];

export async function ticket(repo: string, text: string, out: Out, o: { into?: string; check?: boolean; schedule?: string } = {}): Promise<number> {
  let job: Job;
  try {
    job = await fileTicket(repo, text, { target: o.into, check: o.check, schedule: o.schedule });
  } catch (e) {
    if (!(e instanceof TargetRefused)) throw e;
    out(`kitchen ticket: ${e.message}. Nothing filed.`);
    return 1;
  }
  out(`${o.check ? "check" : "ticket"} ${job.id}  "${job.title}"${job.target ? `  ${o.check ? "on" : "into"} ${job.target}` : ""}  → intake`);
  return 0;
}

/** A ticket's target (`--into`) that doesn't exist or that Kitchen never merges into (ADR 0026 §3). */
export class TargetRefused extends Error {}

/**
 * A new job from a person's ticket text: what `kitchen ticket` does, Kitchen for an intake's later slices, and
 * `kitchen inbox run` for a proposal the person chose (ADR 0022: its title and where it came from). `target`: the
 * branch it merges into (ADR 0026), checked here; staging's own name is the default and isn't stored.
 */
export async function fileTicket(
  repo: string,
  text: string,
  o: { title?: string; from?: JobFrom; target?: string; check?: boolean; schedule?: string; refiledFrom?: string } = {},
): Promise<Job> {
  const cfg = loadConfig(repo);
  const target = o.target?.trim() && o.target.trim() !== cfg.staging.branch ? o.target.trim() : undefined;
  if (target) {
    const why = await refuseTarget(repo, cfg, target);
    if (why) throw new TargetRefused(why);
  }
  const t = PromptSource.ticket(text);
  const title = (o.title && shortTitle(o.title)) || t.title;
  const job = await createJob(repo, {
    title,
    ticket: t.ref,
    body: t.body,
    roundLimit: cfg.round_limit,
    from: o.from,
    target,
    check: o.check,
    schedule: o.schedule,
    refiledFrom: o.refiledFrom,
  });
  appendLedger(repo, { job: job.id, stage: "intake", round: 1, event: "ticket", key: `${job.id}/ticket` });
  return job;
}

/**
 * ADR 0020: the later slices of a ticket split with its author (intake's `## Later slices`), filed when the job goes
 * to Build: each as its own ticket, in order, each after the one before it (the first after this job). Each is
 * recorded on the job as it is filed, so a re-run files only what isn't yet. Returns the line's tail:
 * "; filed 007, 008", "; already filed 007, 008", or "".
 */
export async function fileSlices(repo: string, job: Job, texts: string[]): Promise<string> {
  const before = findJob(repo, job.id).slices ?? [];
  let done = before;
  for (const text of texts.slice(done.length)) {
    const after = done.at(-1)?.id ?? job.id;
    // A slice goes where its job goes (ADR 0026).
    const t = await fileTicket(repo, `${text.replace(/[\s.]+$/, "")}. Comes after job ${numOf(after)}.`, { target: job.target });
    const filed = { text, id: t.id };
    done = (await updateJob(repo, job.id, (j) => ({ ...j, slices: [...(j.slices ?? []), filed] }))).slices ?? [];
  }
  const nums = (xs: { id: string }[]) => xs.map((x) => numOf(x.id)).join(", ");
  return (
    (done.length > before.length ? `; filed ${nums(done.slice(before.length))}` : "") + (before.length && texts.length ? `; already filed ${nums(before)}` : "")
  );
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

/**
 * ADR 0030: the lane session `kitchen run` started for this job ends now. Called after the lane is closed, so the
 * run's finish finds no lane open and drops the result.
 */
async function endLane(job: Job, out: Out) {
  const s = job.running?.session;
  if (s && !s.ended && (await endGroup(s)) === "unconfirmed") out(`${job.id}  ${unconfirmed(s.pid, `its ${job.running?.lane} agent`)}`);
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
  await endLane(job, out);
  out(`${job.id}  stopped${was ? ` (the ${was} agent's result will be dropped)` : ""}`);
  return 0;
}

export async function resume(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  // ADR 0029 §2: QA couldn't test it twice; the person fixed the environment, so QA runs again.
  if (job.stage === "needs-human" && job.escalatedFrom === "qa" && QA_BLOCKED.test(job.pausedReason ?? "")) {
    await moveJob(repo, job.id, "qa", { who: "person" });
    out(`${job.id}  resumed → qa`);
    return 0;
  }
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
    // ADR 0020: a refinement is recorded with its reason, so intake doesn't send the job back for the same one.
    const w = job.waits;
    await moveJob(repo, job.id, "intake", {
      who: "person",
      patch: (j) => {
        if (w?.for === "refine") j.refined = [...(j.refined ?? []), { reason: w.reason, at: new Date().toISOString() }];
      },
    });
    out(`${job.id}  ${w?.for === "refine" ? "refined" : w?.for === "confirm" ? "changes sent" : "answered"} → intake`);
    return 0;
  }
  if (job.stage === "needs-human") {
    const to = (o.to ?? job.escalatedFrom ?? "build") as Stage;
    if (!STAGE_LIST.includes(to) || !["intake", "build", "qa", "review", "regress"].includes(to)) {
      out(`${job.id}  --to takes intake, build, qa, review or regress`);
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
    // ADR 0028: a check is run again (QA on the target's tip as it is now), never built.
    const to = isCheck(job) ? "qa" : "build";
    await moveJob(repo, job.id, to, { who: "person" });
    out(`${job.id}  follow-up → ${to === "qa" ? "qa: the check runs again" : "build"} (round ${job.round + 1})`);
    return 0;
  }
  out(`${job.id}  is ${stateWords(job)}: ${isActive(job.stage) || job.stage === "paused" ? `use kitchen steer ${job.id} "…"` : "nothing to answer"}`);
  return 1;
}

/**
 * ADR 0028 amendment, `kitchen promote <id>`: a job verified and not merged (KEEP: no) takes the rest of the way:
 * Review → merge check → merge into its target (or its PR, with staging.merge: pr). The branch QA verified is what
 * the review reads; a fresh round budget.
 */
export async function promote(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (job.archived) {
    out(`${job.id}  was removed (kitchen restore shows it again)`);
    return 1;
  }
  if (!promotable(job)) {
    out(`${job.id}  is ${job.merged ? "merged already" : stateWords(job)}: promote takes a job verified and not merged (KEEP: no)`);
    return 1;
  }
  await moveJob(repo, job.id, "review", {
    who: "person",
    reason: "promoted by you",
    check: (j) => (promotable(j) ? null : `${j.id} is no longer verified and waiting`),
    patch: (j) => {
      delete j.keep;
      j.promoted = new Date().toISOString();
    },
  });
  out(`${job.id}  promoted → review (then the merge check and the merge into ${job.target ?? loadConfig(repo).staging.branch})`);
  return 0;
}

/** `kitchen approve <id>`: the person approves intake's criteria for a job intake.confirm holds; it goes to Build. */
export async function approve(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  const waiting = (j: Job) => j.stage === "needs-info" && j.waits?.for === "confirm";
  if (!waiting(job)) {
    out(
      `${job.id}  isn't waiting for your approval (it is ${job.waits?.for === "refine" ? "waiting to be refined with you: kitchen refine" : stateWords(job)}): approve is for a job held after intake (intake.confirm)`,
    );
    return 1;
  }
  const dir = jobDirOf(repo, job.id);
  const check = isCheck(job);
  await moveJob(repo, job.id, check ? "qa" : "build", {
    who: "person",
    reason: "approved by you",
    check: (j) => (waiting(j) ? null : `${j.id} is no longer waiting for your approval`),
    patch: (j) => {
      j.approved = new Date().toISOString();
    },
  });
  recordAnswers(dir, ["Approved as written."]);
  // ADR 0020: the split the person just approved, from intake.md as it stands now.
  const i = readIntake(dir);
  const filed = i?.decision === "ACCEPT" && !check ? await fileSlices(repo, job, i.slices) : "";
  out(`${job.id}  approved → ${check ? "qa (a check)" : "build"}${filed}`);
  return 0;
}

/**
 * `kitchen remove <id>`: take a job off the dashboard, whatever its stage. A lane working on it is closed now (its
 * agent is refused from its next tool call; its `job finish` is refused quietly); a job not merged is rejected; its
 * worktree and trial merge go (the branch and the job folder stay). A merged job is only hidden: staging is never
 * touched.
 */
export async function remove(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (job.archived) {
    out(`${job.id}  is removed already (kitchen restore ${numOf(job.id)} shows it again)`);
    return 1;
  }
  const now = new Date().toISOString();
  const lane = job.running?.lane;
  await clearControl(repo, job.id);
  if (job.running) {
    // The lane's app (QA, regress) is a process of Kitchen's: stop it now.
    await (await import("../qa/app.ts")).appDown(repo, job.id).catch(() => {});
  }
  const key = job.running?.key;
  const archive = (j: Job) => {
    const r = key ? j.agentRuns.find((x) => x.key === key) : undefined;
    if (r && !r.end) Object.assign(r, { end: now, ok: false, line: "removed by you" });
    j.running = null;
    j.archived = { at: now, by: "person" };
  };
  const merged = job.stage === "done";
  if (merged || job.stage === "rejected")
    await updateJob(repo, job.id, (j) => {
      archive(j);
      return j;
    });
  else await moveJob(repo, job.id, "rejected", { reason: "removed by you", who: "person", patch: archive });
  await endLane(job, out);
  appendLedger(repo, { job: job.id, stage: job.stage, round: job.round, event: "remove", key: `${job.id}/remove/${now}`, detail: { who: "person" } });
  let gone = "";
  if (!merged) {
    const { git } = await import("./git.ts");
    for (const wt of [job.worktree || worktreeOf(repo, job.id), job.drive?.wt, intakeCheckoutOf(repo, job.id)].filter((x): x is string => !!x && x !== repo)) {
      if (!fs.existsSync(wt)) continue;
      await git(repo, ["worktree", "remove", "--force", wt], { allowFail: true });
      fs.rmSync(wt, { recursive: true, force: true });
      gone = ", its worktree removed";
    }
    await git(repo, ["worktree", "prune"], { allowFail: true });
    if (job.drive) await git(repo, ["update-ref", "-d", `refs/kitchen/drive/${job.id}`], { allowFail: true });
  }
  const closed = merged ? "" : await closePr(repo, job.id, "removed");
  out(
    `${job.id}  removed${lane ? ` (the ${lane} agent was stopped)` : ""}${merged ? ` from view (it stays merged into ${job.merged?.into ?? "staging"})` : job.stage === "rejected" ? "" : ", rejected"}${gone}${closed}; kitchen restore ${numOf(job.id)} shows it again`,
  );
  return 0;
}

/** `kitchen restore <id>`: a removed job back in view, as it was left (rejected, or merged). Its worktree comes back when a lane needs it. */
export async function restore(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (!job.archived) {
    out(`${job.id}  isn't removed`);
    return 1;
  }
  await updateJob(repo, job.id, (j) => {
    delete j.archived;
    return j;
  });
  appendLedger(repo, { job: job.id, stage: job.stage, round: job.round, event: "restore", key: `${job.id}/restore/${new Date().toISOString()}` });
  const pr = job.pr?.closedBy === "kitchen" ? `; its PR #${job.pr.number} stays closed (reopen it on GitHub to take it up again)` : "";
  out(`${job.id}  back in view (${job.stage})${pr}`);
  return 0;
}

export async function reject(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (job.stage === "rejected" || job.stage === "done") {
    out(`${job.id}  is ${job.stage}: nothing to reject`);
    return 1;
  }
  await moveJob(repo, job.id, "rejected", { reason: "rejected by you", who: "person" });
  // A check's checkout (its QA reads it) goes with it.
  if (isCheck(job)) await (await import("./jobs.ts")).dropCheckCheckout(repo, job.id).catch(() => {});
  out(`${job.id}  rejected${await closePr(repo, job.id, "rejected")}`);
  return 0;
}

/**
 * ADR 0026: a job whose PR is still open was rejected or removed by the person: Kitchen closes the PR on GitHub, with
 * a comment saying why. Best effort, once (the job's `filed` keys). Returns the line's tail.
 */
async function closePr(repo: string, id: string, why: "rejected" | "removed"): Promise<string> {
  const job = findJob(repo, id);
  const pr = job.pr;
  if (pr?.state !== "open") return "";
  const key = `pr-close:${pr.number}`;
  if (job.filed.includes(key)) return "";
  const comment = `Kitchen: job ${job.id} was ${why} by the person, so this PR is closed without merging.`;
  const r = await realGh(["pr", "close", String(pr.number), "--comment", comment], repo).catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
  await updateJob(repo, job.id, (j) => ({
    ...j,
    filed: [...j.filed, key],
    ...(r.code ? {} : { pr: { ...pr, state: "closed" as const, closedBy: "kitchen" as const } }),
  }));
  return r.code ? `; couldn't close PR #${pr.number}: ${r.stderr.trim().split("\n").pop()}` : `; PR #${pr.number} closed on GitHub`;
}
