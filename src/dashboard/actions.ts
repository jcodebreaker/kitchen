// The dashboard's POST actions (ADR 0009). Each is a CLI verb: the same engine function, so the
// page can do nothing `kitchen` can't. The body is JSON; text is operator input, capped like a steer.
// An action that makes work runnable (WAKES) starts a detached runner when none works the queue, the
// same way `kitchen run --detach` does (commands.ts startRunner), so an answer never waits for a terminal.
import * as cmd from "../cli/commands.ts";
import { answerSetup } from "../cli/toolkit-commands.ts";
import { MAX_MESSAGE } from "../engine/messages.ts";
import { findJob } from "../engine/store.ts";
import { approveToolkit } from "../toolkit/approve.ts";

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

/** The action names and what each one runs. */
export const ACTIONS: Record<string, (repo: string, b: Body, out: Out) => Promise<number> | number> = {
  steer: async (repo, b, out) => (await cmd.steer(repo, idOf(b), textOf(b), out)).code,
  /** Answer a job that needs you (kitchen feedback). */
  answer: (repo, b, out) => {
    const id = idOf(b);
    const j = findJob(repo, id);
    if (j.stage !== "needs-info" && j.stage !== "needs-human") {
      out(`${j.id}  is ${j.stage}: it is not waiting for an answer`);
      return 1;
    }
    return cmd.feedback(repo, id, textOf(b, j.stage === "needs-info"), out);
  },
  /**
   * Follow up on a done job: another Build round (kitchen feedback, ADR 0007). It reopens a finished job, so the
   * page must say so: `reopen: true`, sent only by its Ask for changes button, never by a plain message.
   */
  "follow-up": (repo, b, out) => {
    const id = idOf(b);
    if (b.reopen !== true) throw new BadRequest("follow-up reopens a done job for another round: it needs { reopen: true }");
    const j = findJob(repo, id);
    if (j.stage !== "done") {
      out(`${j.id}  is ${j.stage}: only a done job takes a follow-up`);
      return 1;
    }
    const text = textOf(b);
    if (!text.trim()) throw new BadRequest("text: say what to change");
    return cmd.feedback(repo, id, text, out);
  },
  reject: (repo, b, out) => cmd.reject(repo, idOf(b), out),
  pause: (repo, b, out) => cmd.pause(repo, idOf(b), out),
  stop: (repo, b, out) => cmd.stop(repo, idOf(b), out),
  resume: (repo, b, out) => cmd.resume(repo, idOf(b), out),
  ticket: (repo, b, out) => {
    const t = textOf(b);
    if (!t.trim()) throw new BadRequest("text: what you want done");
    return cmd.ticket(repo, t, out);
  },
  /**
   * The person approves the proven Toolkit (kitchen toolkit approve, ADR 0015): the same engine function, its default
   * sha (kitchen/setup's proven tip) only, so the page can't name another. Waiting jobs wake.
   */
  "toolkit-approve": (repo, b, out) => {
    // `expect`: the sha the page showed. It only guards (refused when the Toolkit waiting is another by now), never names one.
    if (Object.keys(b).some((k) => k !== "expect") || typeof b.expect !== "string" || !/^[0-9a-f]{12,40}$/.test(b.expect))
      throw new BadRequest('toolkit-approve takes { "expect": "<the sha you were shown>" } only');
    return approveToolkit(repo, { expect: b.expect }, out);
  },
  /** The runner bar's Start runner: `kitchen run --detach` (none is started while one works the queue). */
  "start-runner": (repo, _b, out) => (starter ?? cmd.startRunner)(repo, out),
  "setup-answers": (repo, b, out) => {
    if (!b.answers || typeof b.answers !== "object" || Array.isArray(b.answers)) throw new BadRequest('answers: { "<question id>": "<answer>" }');
    return answerSetup(repo, b.answers as Record<string, unknown>, out);
  },
};

/** Actions after which a job can run: when one succeeds and no runner works the queue, one is started. */
export const WAKES = new Set(["answer", "follow-up", "resume", "ticket", "toolkit-approve"]);

type Starter = (repo: string, out: Out) => number;
let starter: Starter | null = null;
/** Tests: what starts a runner, instead of a real detached `kitchen run`. null: the real one. */
export const setRunnerStarter = (f: Starter | null) => {
  starter = f;
};

export async function act(repo: string, name: string, body: Body): Promise<ActionResult> {
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  const f = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined; // never a prototype key such as constructor
  if (!f) throw new BadRequest(`no action ${name}`);
  try {
    const ok = (await f(repo, body, out)) === 0;
    if (ok && WAKES.has(name) && !cmd.liveRunner(repo)) (starter ?? cmd.startRunner)(repo, out);
    return { ok, lines };
  } catch (e) {
    if (e instanceof BadRequest) throw e;
    return { ok: false, lines: [...lines, (e as Error).message] };
  }
}
