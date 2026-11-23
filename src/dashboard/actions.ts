// The dashboard's POST actions (ADR 0009). Each is a CLI verb: the same function, so the page can do nothing
// `kitchen` can't. The body is JSON; text is operator input, capped like a steer. An action that gives the queue work
// (WAKES) starts a headless orchestrator (`kitchen run --detach`) when none is working the queue.
import * as control from "../engine/control.ts";
import { MAX_MESSAGE } from "../engine/messages.ts";
import { findJob } from "../engine/store.ts";
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
  reject: (repo, b, out) => control.reject(repo, idOf(b), out),
  pause: (repo, b, out) => control.pause(repo, idOf(b), out),
  stop: (repo, b, out) => control.stop(repo, idOf(b), out),
  resume: (repo, b, out) => control.resume(repo, idOf(b), out),
  ticket: (repo, b, out) => {
    const t = textOf(b);
    if (!t.trim()) throw new BadRequest("text: what you want done");
    return control.ticket(repo, t, out);
  },
  /** Start Kitchen: `kitchen run --detach` (none is started while an orchestrator works the queue). */
  "start-runner": (repo, _b, out) => (starter ?? startOrchestrator)(repo, out),
};

/** Actions after which the queue has work: when one succeeds and no orchestrator works the queue, one is started. */
export const WAKES = new Set(["answer", "follow-up", "resume", "ticket"]);

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
