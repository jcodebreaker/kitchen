// The base-change re-proof (PLAN §2, end of "Toolkit contract"): before
// `kitchen run` takes new work, the Toolkit is checked again when the base moved
// since `.kitchen/toolkit.proven`:
// - the Toolkit, `.env.kitchen` or a feature's mapped paths changed → the full check;
// - otherwise → prepare (cached per sha), up, doctor and one smoke drive.
// A failure pauses the queue (.kitchen/queue.json) and files one Toolkit ticket
// per base sha. The queue stays paused until the base moves again or that ticket
// is closed; then the re-proof runs again. Also removes Toolkit checkouts nothing
// points at any more.
import fs from "node:fs";
import path from "node:path";
import { openGit, plainCheckout } from "../engine/git.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { mainHead } from "../engine/worktree.ts";
import type { Forge } from "../forge/forge.ts";
import { appendLedger } from "../ledger/append.ts";
import { type CheckReport, checkAtRef, type Proven, provenFile, readProven, runToolkitCheck } from "./check.ts";
import { gcCheckouts, isPrepared, referencedShas, short, toolkitCheckout } from "./checkout.ts";
import { toolkitPaths, touched } from "./contract.ts";

export type QueueState = { paused: true; base: string; ticket: string; reason: string; at: string };
export const queueFile = (repo: string) => path.join(kitchenDir(repo), "queue.json");

export function readQueue(repo: string): QueueState | null {
  try {
    return JSON.parse(fs.readFileSync(queueFile(repo), "utf8")) as QueueState;
  } catch {
    return null;
  }
}

/** One line for `kitchen status`, or null when the queue runs. */
export function queueLine(repo: string): string | null {
  const q = readQueue(repo);
  return q ? `queue: paused (${q.reason}; Toolkit ticket ${q.ticket})` : null;
}

async function changedSince(repo: string, from: string, to: string): Promise<string[] | null> {
  try {
    const git = await openGit(plainCheckout(repo));
    return (await git.run(["diff", "--name-only", "--no-ext-diff", "--no-textconv", from, to])).stdout.split("\n").filter(Boolean);
  } catch {
    return null; // the proven sha is gone (rewritten history): full check
  }
}

async function hasToolkitAt(repo: string, sha: string): Promise<boolean> {
  try {
    await (await openGit(plainCheckout(repo))).run(["cat-file", "-e", `${sha}:.kitchen/toolkit/bin/dev`]);
    return true;
  } catch {
    return false;
  }
}

/** Returns true when the runner may take new work. */
export async function beforeNewWork(o: { repo: string; forge: Forge; print: (l: string) => void }): Promise<boolean> {
  const repo = o.repo;
  const say = (l: string) => o.print(`toolkit: ${l}`);
  const proven = readProven(repo);
  try {
    if (!proven) {
      if (fs.existsSync(path.join(repo, ".kitchen", "toolkit", "bin", "dev"))) say("never proven on this repo (kitchen toolkit check); not re-checking");
      return true;
    }
    let base: string;
    try {
      base = await mainHead(repo);
    } catch {
      return true;
    }
    if (proven.sha === base) {
      if (readQueue(repo)) fs.rmSync(queueFile(repo), { force: true });
      return true;
    }
    if (!(await hasToolkitAt(repo, base))) {
      say(`the base (${short(base)}) has no Toolkit yet${proven.branch ? ` (proven on ${proven.branch}: merge it)` : ""}; not re-checking`);
      return true;
    }
    const q = readQueue(repo);
    if (q && q.base === base && !(await o.forge.ticketClosed(q.ticket).catch(() => false))) {
      say(`queue paused: ${q.reason} (ticket ${q.ticket}); fix the Toolkit on the base or close the ticket`);
      return false;
    }

    const changed = await changedSince(repo, proven.sha, base);
    const hit = changed ? touched(changed, toolkitPaths(proven.features)) : null;
    const full = !hit || hit.length > 0;
    say(
      `base moved ${short(proven.sha)} → ${short(base)}: ${
        full
          ? `full check (${hit ? `Toolkit paths changed: ${hit.slice(0, 5).join(", ")}${hit.length > 5 ? ", …" : ""}` : "proven sha not found"})`
          : "doctor + smoke drive"
      }`,
    );
    const prefixed = (l: string) => o.print(`  ${l}`);
    let r: CheckReport;
    if (full) r = await checkAtRef(repo, { print: prefixed });
    else {
      const co = await toolkitCheckout(repo, base);
      r = await runToolkitCheck({ repo, toolkitBin: co.bin, src: co.dir, smoke: true, prepare: !isPrepared(repo, co.sha, co.dir), print: prefixed });
      if (r.ok) {
        const next: Proven = { ...proven, sha: base, at: new Date().toISOString(), secs: r.secs };
        delete next.branch;
        writeAtomic(provenFile(repo), `${JSON.stringify(next, null, 2)}\n`);
      }
    }
    const key = `toolkit-reproof/${base}`;
    appendLedger(repo, {
      job: "-",
      stage: "-",
      round: 0,
      event: "toolkit-reproof",
      key: `${key}/${Date.now()}`,
      result: r.ok ? "pass" : "fail",
      secs: r.secs,
      detail: { from: proven.sha, to: base, full, failed: r.failed, changed: hit },
    });
    if (r.ok) {
      fs.rmSync(queueFile(repo), { force: true });
      say(`re-proven on ${short(base)}`);
      return true;
    }
    const failed = r.steps.find((s) => !s.ok);
    const reason = `Toolkit ${full ? "check" : "smoke"} failed on ${short(base)} at ${r.failed}`;
    const ticket = await o.forge.fileTicket({
      key,
      title: `Toolkit: re-proof failed on ${short(base)} (${r.failed})`,
      body: [
        `\`kitchen run\` re-checked the Toolkit after the base moved from ${proven.sha} to ${base} and it failed, so the queue is paused.`,
        "",
        `- mode: ${full ? "full check" : "doctor + smoke drive"}`,
        ...(hit?.length ? [`- Toolkit paths changed: ${hit.join(", ")}`] : []),
        `- failed step: ${failed?.step ?? r.failed}${failed?.detail ? `: ${failed.detail}` : ""}`,
        ...(failed?.tail ? ["", "```", failed.tail, "```"] : []),
        "",
        `Check evidence: ${path.relative(repo, r.jobDir)}. Reproduce with \`kitchen toolkit check\`.`,
      ].join("\n"),
    });
    const state: QueueState = { paused: true, base, ticket, reason, at: new Date().toISOString() };
    writeAtomic(queueFile(repo), `${JSON.stringify(state, null, 2)}\n`);
    say(`queue paused: ${reason}; filed ${ticket}`);
    return false;
  } finally {
    const gone = await gcCheckouts(repo, referencedShas(repo, readProven(repo)?.sha ?? null)).catch(() => []);
    if (gone.length) say(`removed unused Toolkit checkouts ${gone.join(", ")}`);
  }
}
