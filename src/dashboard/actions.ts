// The dashboard's POST actions (ADR 0009). Each is a CLI verb: the same function, so the page can do nothing
// `kitchen` can't. The body is JSON; text is operator input, capped like a steer. An action that gives the queue work
// (WAKES) starts a headless orchestrator (`kitchen run --detach`) when none is working the queue.
import path from "node:path";
import * as control from "../engine/control.ts";
import { MAX_MESSAGE } from "../engine/messages.ts";
import { findJob } from "../engine/store.ts";
import { detachCollect, liveCollect } from "../inbox/collect.ts";
import * as inbox from "../inbox/store.ts";
import { run } from "../run/orchestrator.ts";
import { orchestrator } from "./data.ts";

export type ActionResult = { ok: boolean; lines: string[] };
type Body = Record<string, unknown>;
type Out = (l: string) => void;

const idOf = (b: Body) => {
  if (typeof b.id !== "string" || !/^[\w-]{1,80}$/.test(b.id)) throw new BadRequest("id: a job id or number");
  return b.id;
};
const textOf = (b: Body, required = true) => {
  if (b.text === undefined && !required) return "";
  if (typeof b.text !== "string") throw new BadRequest("text: a string");
  if (b.text.length > MAX_MESSAGE) throw new BadRequest(`text: at most ${MAX_MESSAGE} characters`);
  return b.text;
};

export class BadRequest extends Error {}

const pidOf = (b: Body) => {
  if (typeof b.id !== "string" || !inbox.isProposalId(b.id)) throw new BadRequest("id: a proposal id (p1…)");
  return b.id;
};
const optText = (b: Body, k: "title" | "text") => {
  const v = b[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > MAX_MESSAGE) throw new BadRequest(`${k}: a string of at most ${MAX_MESSAGE} characters`);
  return v;
};
type Collector = (repo: string, out: Out) => Promise<number> | number;
let collector: Collector | null = null;
/** Tests: what Collect starts, instead of a real detached `kitchen collect`. null: the real one. */
export const setCollector = (f: Collector | null) => {
  collector = f;
};
const CLI = path.resolve(import.meta.dirname, "..", `cli${path.extname(import.meta.filename)}`);

type Starter = (repo: string, out: Out) => Promise<number> | number;
let starter: Starter | null = null;
/** Tests: what starts an orchestrator, instead of a real detached `kitchen run`. null: the real one. */
export const setRunnerStarter = (f: Starter | null) => {
  starter = f;
};
const startOrchestrator: Starter = (repo, out) => run(repo, { detach: true }, out);

export const ACTIONS: Record<string, (repo: string, b: Body, out: Out) => Promise<number> | number> = {
  steer: async (repo, b, out) => (await control.steer(repo, idOf(b), textOf(b), out)).code,
  answer: (repo, b, out) => {
    const id = idOf(b);
    const j = findJob(repo, id);
    if (j.stage !== "needs-info" && j.stage !== "needs-human") {
      out(`${j.id}  is ${j.stage}: it is not waiting for an answer`);
      return 1;
    }
    return control.feedback(repo, id, textOf(b, j.stage === "needs-info"), out);
  },
  /** Follow up on a ready or merged job: another Build round. It reopens the job, so the page must say so: `reopen: true`. */
  "follow-up": (repo, b, out) => {
    const id = idOf(b);
    if (b.reopen !== true) throw new BadRequest("follow-up reopens a finished job for another round: it needs { reopen: true }");
    const j = findJob(repo, id);
    if (j.stage !== "done" && j.stage !== "ready") {
      out(`${j.id}  is ${j.stage}: only a ready or merged job takes a follow-up`);
      return 1;
    }
    const text = textOf(b);
    if (!text.trim()) throw new BadRequest("text: say what to change");
    return control.feedback(repo, id, text, out);
  },
  /** ADR 0020 §3: a job held after intake (intake.confirm) goes to Build on intake's criteria. */
  approve: (repo, b, out) => control.approve(repo, idOf(b), out),
  reject: (repo, b, out) => control.reject(repo, idOf(b), out),
  pause: (repo, b, out) => control.pause(repo, idOf(b), out),
  stop: (repo, b, out) => control.stop(repo, idOf(b), out),
  resume: (repo, b, out) => control.resume(repo, idOf(b), out),
  ticket: (repo, b, out) => {
    const t = textOf(b);
    if (!t.trim()) throw new BadRequest("text: what you want done");
    return control.ticket(repo, t, out);
  },
  /** ADR 0022: Collect, `kitchen collect --detach`; the page follows it in /inbox.json. */
  collect: (repo, _b, out) => {
    if (liveCollect(repo)) {
      out("a collect is already running");
      return 0;
    }
    return (collector ?? ((r, o) => detachCollect(r, CLI, o)))(repo, out);
  },
  /** Run selected / Run this: `kitchen inbox run`, highest priority first. */
  "inbox-run": async (repo, b, out) => {
    if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((x) => typeof x === "string" && inbox.isProposalId(x)))
      throw new BadRequest("ids: proposal ids (p1…)");
    for (const m of await inbox.run(repo, b.ids as string[])) out(`${m.proposal} → ${m.job}`);
    return 0;
  },
  "inbox-hold": async (repo, b, out) => {
    out(`${(await inbox.hold(repo, pidOf(b))).id} held`);
    return 0;
  },
  "inbox-unhold": async (repo, b, out) => {
    out(`${(await inbox.bringBack(repo, pidOf(b))).id} back`);
    return 0;
  },
  "inbox-remove": async (repo, b, out) => {
    out(`${(await inbox.remove(repo, pidOf(b))).id} removed`);
    return 0;
  },
  "inbox-edit": async (repo, b, out) => {
    out(`${(await inbox.edit(repo, pidOf(b), { title: optText(b, "title"), text: optText(b, "text") })).id} edited`);
    return 0;
  },
  /** Propose anyway: a set-aside (or unclear) proposal back to Proposed. */
  "inbox-verdict": async (repo, b, out) => {
    if (b.verdict !== "propose") throw new BadRequest('verdict: "propose" (the page only proposes anyway)');
    out(`${(await inbox.verdict(repo, [pidOf(b)], { verdict: "propose" })).id} proposed`);
    return 0;
  },
  /** Start Kitchen: `kitchen run --detach` (none is started while an orchestrator works the queue). */
  "start-runner": (repo, _b, out) => (starter ?? startOrchestrator)(repo, out),
};

/** Actions after which the queue has work: when one succeeds and no orchestrator works the queue, one is started. */
export const WAKES = new Set(["answer", "approve", "follow-up", "resume", "ticket", "inbox-run"]);

export async function act(repo: string, name: string, body: Body): Promise<ActionResult> {
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  const f = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
  if (!f) throw new BadRequest(`no action ${name}`);
  try {
    const ok = (await f(repo, body, out)) === 0;
    if (ok && WAKES.has(name) && !orchestrator(repo).running) await (starter ?? startOrchestrator)(repo, out);
    return { ok, lines };
  } catch (e) {
    if (e instanceof BadRequest) throw e;
    return { ok: false, lines: [...lines, (e as Error).message] };
  }
}
