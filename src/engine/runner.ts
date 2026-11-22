// The run loop (PLAN §4 `kitchen run`): take the run lock, reclaim stale slots,
// resume every job from its files, then dispatch stage handlers across
// `concurrency` slots, oldest-moved job first, one stage per dispatch so jobs
// take turns. Paused jobs hold no slot; their waitFor is checked every tick.
// Every move goes through machine.ts; every refused move is printed and logged
// with its reason.
//
// `once`: one tick (waits checked once, every runnable job runs one stage), then exit.
// Default: until no job is runnable or paused.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentAdapter } from "../agents/adapter.ts";
import { ClaudeAdapter } from "../agents/claude.ts";
import { CodexAdapter } from "../agents/codex.ts";
import { FakeAdapter, type FakeScript } from "../agents/fake.ts";
import { type Config, loadConfig } from "../config.ts";
import { type Forge, forgeFor, isTrusted } from "../forge/forge.ts";
import { appendLedger } from "../ledger/append.ts";
import { self } from "../lock.ts";
import { procsDirOf, reapGroups } from "../procs.ts";
import { GithubSource } from "../sources/github.ts";
import { PromptSource } from "../sources/prompt.ts";
import type { TicketSource } from "../sources/source.ts";
import { effectiveConcurrency, readProven } from "../toolkit/check.ts";
import { maintain, maintainDue } from "../toolkit/maintain.ts";
import { beforeNewWork } from "../toolkit/reproof.ts";
import { acquireSlot, downSlot, listSlots, reclaimStaleSlots, releaseSlot } from "../toolkit/slots.ts";
import { takeTicket } from "./base.ts";
import { ensureJobToolkit } from "./job-toolkit.ts";
import { acquireRunLock } from "./lock.ts";
import { type Facts, isActive, type Job, move, type Stage } from "./machine.ts";
import { HANDLERS } from "./stages/index.ts";
import { hasToolkit } from "./stages/toolkit-info.ts";
import { LockLost, type Proposal, RoleFailure, type StageContext } from "./stages/types.ts";
import { jobDirOf, listJobs, readJobAt, repairManifest, scanJobs, updateJob, writeAtomic } from "./store.ts";

export type RunOpts = { repo: string; once?: boolean; job?: string; tickMs?: number; print?: (line: string) => void; logFile?: string };
type Deps = { config: Config; agent: AgentAdapter; forge: Forge; source: TicketSource; holdsLock: () => boolean };

export async function adapterFor(repo: string, cfg: Config): Promise<AgentAdapter> {
  const cmd = cfg.agent.command ?? [];
  if (cfg.agent.tool === "claude") {
    if (cmd.length > 1) throw new Error("agent.command for claude is one path");
    return new ClaudeAdapter(cmd[0] ?? process.env.KITCHEN_CLAUDE_BIN ?? "claude");
  }
  if (cfg.agent.tool === "codex") return new CodexAdapter(cmd[0] ?? process.env.KITCHEN_CODEX_BIN ?? "codex", cmd.slice(1));
  if (!cfg.agent.script) throw new Error("agent.tool fake needs agent.script");
  const mod = (await import(pathToFileURL(path.resolve(repo, cfg.agent.script)).href)) as { default: FakeScript };
  return new FakeAdapter(mod.default);
}

const short = (j: Pick<Job, "id">) => j.id;

export async function runKitchen(o: RunOpts): Promise<{ steps: number; moves: number; refused: number }> {
  const print = o.print ?? ((l: string) => console.log(l));
  const repo = path.resolve(o.repo);
  const config = loadConfig(repo);
  const lock = acquireRunLock(repo, { log: o.logFile, argv: process.argv.slice(2) });
  const deps: Deps = {
    config,
    agent: await adapterFor(repo, config),
    forge: forgeFor(repo, config),
    source: config.source.kind === "github" ? new GithubSource(config, repo) : new PromptSource(repo),
    holdsLock: () => !lock.lost(),
  };
  const me = self();
  const stats = { steps: 0, moves: 0, refused: 0 };
  const runKey = `run/${me.pid}/${lock.info.startedAt}`;
  appendLedger(repo, { job: "-", stage: "-", round: 0, event: "run-start", key: runKey, detail: { pid: me.pid, once: !!o.once, job: o.job } });
  print(`run: pid ${me.pid}${o.logFile ? `, log ${o.logFile}` : ""}${lock.takenOver ? `, took over the run lock (${lock.takenOver})` : ""}`);
  if (lock.takenOver)
    appendLedger(repo, {
      job: "-",
      stage: "-",
      round: 0,
      event: "lock-takeover",
      key: `${runKey}/takeover`,
      detail: { why: lock.takenOver, previous: lock.previous },
    });

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    print(`run: ${sig}, stopping (jobs resume from their files on the next run)`);
    lock.release();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  try {
    // Stale slots (owner dead): their own Toolkit's down, then dropped.
    for (const s of await reclaimStaleSlots({ onStale: (s) => downSlot(s) })) {
      print(`slot ${s.n} (${s.id}) reclaimed: owner pid ${s.pid} is gone`);
      appendLedger(repo, { job: s.id, stage: "-", round: 0, event: "slot-reclaimed", key: `${runKey}/slot/${s.id}/${s.at}`, detail: { n: s.n, pid: s.pid } });
    }
    await resumeAll(repo, me.pid, print, runKey);
    // Base moved since the Toolkit was proven: re-check it first; a failure pauses the queue (PLAN §2).
    if (!(await beforeNewWork({ repo, forge: deps.forge, print }))) return stats;
    // The feature-mapped paths churned past maintain_churn_lines since the last maintain: run it first (once per base).
    const due = await maintainDue(repo, config).catch(() => null);
    if (due?.due) {
      print(
        `toolkit: ${due.lines} lines changed in feature-mapped paths since ${due.since?.slice(0, 12)} (> ${config.maintain_churn_lines}): kitchen toolkit maintain`,
      );
      await maintain({ repo, forge: deps.forge, print, agent: deps.agent, trigger: `churn ${due.lines} lines since ${due.since?.slice(0, 12)}` }).catch((e) =>
        print(`toolkit: maintain failed: ${(e as Error).message}`),
      );
    }
    // A Toolkit proven parallel:false runs one job at a time, whatever kitchen.yaml says.
    const concurrency = effectiveConcurrency(config.concurrency, readProven(repo));
    if (concurrency < config.concurrency) print(`run: the Toolkit is proven parallel:false, so one job at a time (kitchen.yaml says ${config.concurrency})`);

    const inFlight = new Map<string, Promise<void>>();
    const wanted = (j: Job) => !o.job || j.id === o.job;
    const tickMs = o.tickMs ?? Number(process.env.KITCHEN_TICK_MS ?? 2000);
    const dispatch = (j: Job) => {
      const p = step(repo, j, deps, print, stats).finally(() => inFlight.delete(j.id));
      inFlight.set(j.id, p);
    };

    if (o.once) {
      await takeNew(repo, deps, print);
      await checkWaits(repo, deps, print, wanted);
      const queue = listJobs(repo)
        .filter((j) => wanted(j) && isActive(j.stage))
        .sort(byOldest);
      while (queue.length || inFlight.size) {
        if (lock.lost() && queue.length) {
          print("run: lost the run lock to another runner, dispatching nothing more");
          queue.length = 0;
        }
        while (queue.length && inFlight.size < concurrency) dispatch(queue.shift() as Job);
        if (inFlight.size) await Promise.race(inFlight.values());
      }
    } else {
      for (;;) {
        if (lock.lost()) {
          print("run: lost the run lock to another runner, stopping");
          break;
        }
        await takeNew(repo, deps, print);
        await checkWaits(repo, deps, print, wanted);
        const jobs = listJobs(repo).filter(wanted);
        const runnable = jobs.filter((j) => isActive(j.stage) && !inFlight.has(j.id)).sort(byOldest);
        while (runnable.length && inFlight.size < concurrency) dispatch(runnable.shift() as Job);
        const waiting = jobs.filter((j) => j.stage === "paused");
        if (!inFlight.size && !runnable.length && !waiting.length) break;
        await Promise.race([...inFlight.values(), new Promise((r) => setTimeout(r, tickMs))]);
      }
    }
  } finally {
    // Leaving: give back the slots this runner holds (the next run takes new ones).
    for (const s of listSlots().filter((x) => x.pid === me.pid)) {
      const job = listJobs(repo).find((j) => j.slotId === s.id);
      if (job) await freeSlot(repo, job, print);
    }
    appendLedger(repo, { job: "-", stage: "-", round: 0, event: "run-end", key: `${runKey}/end`, detail: stats });
    lock.release();
  }
  print(`run: done (${stats.steps} stage runs, ${stats.moves} moves, ${stats.refused} refused)`);
  return stats;
}

const byOldest = (a: Job, b: Job) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);

/**
 * After a crash: name corrupt jobs (skipped from here on), kill the process
 * groups a dead runner left running for each job (agents, checks: src/procs.ts)
 * and wait until they are gone, cut unsigned manifest tails back to the signed
 * head, and note jobs a dead runner was working on.
 */
async function resumeAll(repo: string, pid: number, print: (l: string) => void, runKey: string) {
  for (const e of scanJobs(repo)) {
    if (e.corrupt === undefined) continue;
    print(`${e.id}  corrupt (${e.corrupt}): skipped`);
    appendLedger(repo, { job: e.id, stage: "-", round: 0, event: "corrupt", key: `${runKey}/corrupt/${e.id}`, detail: { reason: e.corrupt } });
  }
  for (const job of listJobs(repo)) {
    for (const g of await reapGroups(procsDirOf(jobDirOf(repo, job.id)))) {
      print(`${short(job)}  killed ${g.what} left running by pid ${g.by} (process group ${g.pgid})`);
      appendLedger(repo, {
        job: job.id,
        stage: job.stage,
        round: job.round,
        event: "orphan-killed",
        key: `${job.id}/orphan/${g.pgid}/${g.at}`,
        detail: { ...g },
      });
    }
    const cut = await repairManifest(repo, job.id);
    if (cut) {
      print(`${short(job)}  manifest: ${cut.from - cut.to} unsigned line(s) past the signed head cut (kept in ${path.basename(cut.kept)})`);
      appendLedger(repo, {
        job: job.id,
        stage: job.stage,
        round: job.round,
        event: "manifest-truncated",
        key: `${job.id}/manifest-truncated/${cut.to}/${cut.from}`,
        detail: cut,
      });
    }
    if (job.running && job.running.pid !== pid) {
      print(`${short(job)}  resume ${job.stage} (interrupted ${job.running.at}, pid ${job.running.pid})`);
      appendLedger(repo, {
        job: job.id,
        stage: job.stage,
        round: job.round,
        event: "resumed",
        key: `${job.id}/resumed/m${job.moves}/${job.running.at}`,
        detail: { pid: job.running.pid },
      });
      await updateJob(repo, job.id, (j) => {
        j.running = null;
        return j;
      });
    }
  }
}

/** New tickets from the source (GitHub issues with the label); a ticket already taken in is skipped (createJob looks it up). */
async function takeNew(repo: string, d: Deps, print: (l: string) => void) {
  let incoming: Awaited<ReturnType<TicketSource["poll"]>> = [];
  try {
    incoming = await d.source.poll();
  } catch (e) {
    print(`source: ${d.source.kind} poll failed: ${(e as Error).message}`);
    return;
  }
  for (const t of incoming) {
    const r = await takeTicket(repo, d.config, t);
    if (r.created) print(`ticket ${r.job.id}  "${r.job.title}"  (${t.ref.source} ${t.ref.id}) → intake`);
  }
}

/** Paused jobs whose condition cleared go back to pausedFrom; needs-info jobs with a reply go back to intake. */
async function checkWaits(repo: string, d: Deps, print: (l: string) => void, wanted: (j: Job) => boolean) {
  for (const job of listJobs(repo).filter(wanted)) {
    if (job.stage === "paused" && job.pausedFrom) {
      let cleared = false;
      if (job.waitFor === "backoff") cleared = !job.until || Date.now() >= Date.parse(job.until);
      // Merged, or closed without merging (Ready then sends the job to needs-human, naming the PR).
      else if (job.waitFor === "toolkit-pr") cleared = job.smith.toolkitPr !== null && (await d.forge.prState(job.smith.toolkitPr)) !== "open";
      else if (job.waitFor === "ci") {
        // Within Ready's window (no checks yet after a push, or a cancelled run): only a real result ends it early.
        const ci = await d.forge.checks(job.pr);
        const waiting = !!job.until && Date.now() < Date.parse(job.until);
        cleared = ci !== "pending" && (!waiting || ci === "pass" || ci === "fail");
      } else if (job.waitFor === "toolkit-ticket") cleared = !!job.toolkitTicketRef && (await d.forge.ticketClosed(job.toolkitTicketRef));
      if (cleared) await moveJob(repo, job, { to: job.pausedFrom, facts: { waitCleared: true }, note: `${job.waitFor} cleared` }, print);
    } else if (job.stage === "needs-info" && (await d.source.replies(job)).length) {
      await moveJob(repo, job, { to: "intake", facts: { replied: true }, note: "the author replied" }, print);
    } else if (job.stage === "done" && job.pr !== null) {
      await prCommentsBack(repo, job, d, print);
    }
  }
}

/**
 * done → build from review comments on the PR (PLAN §2). Comments are read through the
 * forge; only a trusted person's count (forge.ts isTrusted: kitchen.yaml `feedback`).
 * The new trusted ones become one feedback file for the builder (quoted, with the
 * author) and the job goes back to build; an untrusted one is logged and ignored.
 * Each comment is handled once (`pr-comment/<id>` in `filed`).
 */
async function prCommentsBack(repo: string, job: Job, d: Deps, print: (l: string) => void) {
  const fresh = (await d.forge.reviewComments(job.pr)).filter((c) => !job.filed.includes(`pr-comment/${c.id}`));
  if (!fresh.length) return;
  const trusted = fresh.filter((c) => isTrusted(c, d.config.feedback));
  const ignored = fresh.filter((c) => !trusted.includes(c));
  for (const c of ignored) {
    print(`${job.id}  PR comment ${c.id} by ${c.author} (${c.association}) ignored: not a trusted person`);
    appendLedger(repo, {
      job: job.id,
      stage: job.stage,
      round: job.round,
      event: "pr-comment-ignored",
      key: `${job.id}/pr-comment/${c.id}`,
      detail: { author: c.author, association: c.association },
    });
  }
  const mark = (keys: string[]) =>
    updateJob(repo, job.id, (j) => {
      for (const k of keys) if (!j.filed.includes(k)) j.filed.push(k);
      return j;
    });
  if (!trusted.length) {
    await mark(ignored.map((c) => `pr-comment/${c.id}`));
    return;
  }
  const lead = trusted[0];
  const file = path.join(jobDirOf(repo, job.id), "feedback", `${new Date().toISOString().replace(/[:.]/g, "-")}-pr-${lead.id}.md`);
  writeAtomic(
    file,
    `${trusted.map((c) => `Review comment on PR #${c.pr} by ${c.author} (${c.association}), ${c.at}. It is a person's request, quoted:\n\n${c.body.trim().replace(/^/gm, "> ")}`).join("\n\n")}\n`,
  );
  const r = await moveJob(
    repo,
    job,
    {
      to: "build",
      facts: { prComment: { id: lead.id, author: lead.author, trusted: true } },
      note: `PR comment ${trusted.map((c) => c.id).join(", ")} by ${lead.author}`,
    },
    print,
    "human",
  );
  if (r === "moved") await mark(fresh.map((c) => `pr-comment/${c.id}`));
  else fs.rmSync(file, { force: true });
}

function backoffUntil(cfg: Config, job: Job): string {
  const secs = Math.min(cfg.backoff.max_sec, cfg.backoff.base_sec * 2 ** job.attempts.backoff);
  return new Date(Date.now() + secs * 1000).toISOString();
}

/** One stage run for one job. */
async function step(repo: string, start: Job, d: Deps, print: (l: string) => void, stats: { steps: number; moves: number; refused: number }) {
  const me = self();
  if (!d.holdsLock()) return; // another runner has the lock: it runs the job
  let job = await updateJob(repo, start.id, (j) => {
    j.running = { pid: me.pid, start: me.start, stage: j.stage, at: new Date().toISOString() };
    return j;
  });
  if (job.stage !== start.stage) return;
  stats.steps++;
  const handler = HANDLERS[job.stage];
  if (!handler) return;
  const jobDir = jobDirOf(repo, job.id);
  const log = (m: string) => print(`${short(job)}  ${job.stage}: ${m}`);
  // The job's Toolkit: the engine-owned checkout at its toolkitRef (job-toolkit.ts).
  try {
    job = await ensureJobToolkit(repo, job, log);
  } catch (e) {
    log(`Toolkit checkout at ${job.toolkitRef.slice(0, 12)} failed: ${(e as Error).message}`);
  }
  // Also when job.json still names a slot: a runner killed mid-stage leaves it there while its
  // registry entry was reclaimed at start-up, and this runner must own the slot to free it on exit.
  if (hasToolkit(job) && (!job.slot || !listSlots().some((s) => s.id === job.slotId))) {
    const { slot } = await acquireSlot({ id: job.slotId, toolkitBin: job.toolkitBin, src: job.worktree || repo, pid: me.pid });
    job = await updateJob(repo, job.id, (j) => {
      j.slot = { n: slot.n, ports: slot.ports };
      return j;
    });
    log(`slot ${slot.n} (ports ${slot.ports[0]}–${slot.ports.at(-1)})`);
  }
  const ctx: StageContext = { repo, job, jobDir, ...d, now: () => new Date(), log, refresh: () => readJobAt(jobDir) };
  let p: Proposal;
  try {
    p = await handler(ctx);
  } catch (e) {
    const fresh = readJobAt(jobDir);
    const msg = (e as Error).message;
    if (e instanceof LockLost || !d.holdsLock()) {
      print(`${short(job)}  ${job.stage}: run lock lost, left for the runner that holds it`);
      return;
    }
    if (e instanceof RoleFailure && (e.rateLimited || e.authFailure)) {
      p = { to: "paused", facts: { adapter: { rateLimited: e.rateLimited, authFailure: e.authFailure, until: backoffUntil(d.config, fresh), error: msg } } };
    } else if (fresh.attempts.errors + 1 >= 2) {
      // A role that failed is the adapter's error; anything else (git, worktree, files) is the engine's.
      p = { to: "needs-human", facts: { escalate: e instanceof RoleFailure ? "adapter-error" : "engine-error", why: msg } };
    } else {
      print(`${short(job)}  ${job.stage}: error (retried next tick): ${msg}`);
      appendLedger(repo, {
        job: job.id,
        stage: job.stage,
        round: job.round,
        event: "error",
        key: `${job.id}/m${fresh.moves}/error/${fresh.attempts.errors + 1}`,
        detail: { error: msg },
      });
      await updateJob(repo, job.id, (j) => {
        j.attempts.errors += 1;
        j.running = null;
        return j;
      });
      return;
    }
  }
  if (!d.holdsLock()) {
    print(`${short(job)}  ${job.stage}: run lock lost, ${job.stage} → ${p.to} not made; the runner that holds the lock resumes it`);
    return;
  }
  const r = await moveJob(repo, job, p, print);
  if (r === "moved") stats.moves++;
  else if (r === "refused") stats.refused++;
}

/**
 * Ask the machine to move the job, under the job lock against the job as it is
 * on disk. A refusal is printed and logged.
 * - A runner proposal (`by: "runner"`, a stage handler's result): an escalation
 *   code (round or smith limit) or a second refusal in the same stage sends the
 *   job to needs-human.
 * - A human command (`by: "human"`: feedback, reject, resume) that is refused
 *   changes nothing: no counter, no escalation, job.json untouched.
 */
export async function moveJob(
  repo: string,
  seen: Job,
  p: Proposal,
  print: (l: string) => void,
  by: "runner" | "human" = "runner",
): Promise<"moved" | "refused" | "stale"> {
  let outcome: "moved" | "refused" | "stale" = "stale";
  const lines: string[] = [];
  let after: Job | null = null;
  await updateJob(repo, seen.id, (fresh) => {
    if (fresh.stage !== seen.stage || fresh.moves !== seen.moves) return fresh; // moved by someone else meanwhile
    const now = new Date().toISOString();
    const log = (j: Job, to: Stage, row: string, note?: string) => {
      appendLedger(repo, {
        job: j.id,
        stage: j.stage,
        round: j.round,
        event: "move",
        result: to,
        key: `${j.id}/m${j.moves + 1}/${j.stage}>${to}`,
        detail: { row, ...(note ? { note } : {}) },
      });
      lines.push(`${j.id}  ${j.stage} → ${to}${note ? `  (${note})` : ""}`);
    };
    const r = move(fresh, p.to, { ...p.facts, now } as Facts);
    if ("job" in r) {
      log(fresh, p.to, r.row, p.note ?? reasonOf(r.job));
      outcome = "moved";
      after = r.job;
      return r.job;
    }
    outcome = "refused";
    lines.push(`${fresh.id}  refused ${r.refused}`);
    appendLedger(repo, {
      job: fresh.id,
      stage: fresh.stage,
      round: fresh.round,
      event: "refused",
      result: p.to,
      key: by === "human" ? `${fresh.id}/m${fresh.moves}/human/${now}/refused` : `${fresh.id}/m${fresh.moves}/x${fresh.attempts.refused}/refused`,
      detail: { reason: r.refused, code: r.code, by, ...(p.note ? { note: p.note } : {}) },
    });
    if (by === "human") return fresh; // unchanged: updateJob writes nothing
    const esc = move(fresh, "needs-human", { now, escalate: r.code ?? "refused", why: r.refused });
    if ("job" in esc) {
      log(fresh, "needs-human", esc.row, esc.job.pausedReason);
      after = esc.job;
      return esc.job;
    }
    fresh.attempts.refused += 1;
    fresh.running = null;
    return fresh;
  });
  for (const l of lines) print(l);
  const moved = after as Job | null;
  if (moved?.slot && !isActive(moved.stage)) await freeSlot(repo, moved, print);
  return outcome;
}

/** A paused or finished job gives its slot back: its Toolkit's `down`, then the registry entry. */
async function freeSlot(repo: string, job: Job, print: (l: string) => void) {
  const s = listSlots().find((x) => x.id === job.slotId);
  if (s) await downSlot(s);
  await releaseSlot(job.slotId);
  await updateJob(repo, job.id, (j) => {
    j.slot = null;
    return j;
  });
  print(`${job.id}  slot ${job.slot?.n} released (${job.stage})`);
}

const reasonOf = (j: Job) => (j.stage === "paused" ? `waitFor ${j.waitFor}${j.until ? ` until ${j.until}` : ""}` : j.pausedReason);
