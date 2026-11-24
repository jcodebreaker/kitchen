// ADR 0025 §2: a verb that gives the queue work (a ticket, an answer, an approval, a follow-up, a resume, a proposal
// run) wakes Kitchen wherever it is called, the CLI or the dashboard: `kitchen run --detach` when no orchestrator
// works the queue. Inside an orchestrator session (KITCHEN_ORCHESTRATOR) nothing starts: that session picks it up.
import { orchestrator } from "../dashboard/data.ts";
import { run } from "./orchestrator.ts";

type Out = (l: string) => void;
export type Starter = (repo: string, out: Out) => Promise<number> | number;

/**
 * Wake Kitchen after a verb that succeeded, and say what happened at the end of the verb's last line in `lines`
 * ("ticket 004 "…" → intake · Kitchen started"). `noRun`: file only (`--no-run`). `start`: what starts an
 * orchestrator (tests, the dashboard's stand-in); by default a detached `kitchen run`.
 */
export async function wake(repo: string, lines: string[], o: { noRun?: boolean; start?: Starter; cli?: string } = {}): Promise<void> {
  const say = (tail: string) => {
    if (lines.length) lines[lines.length - 1] += ` · ${tail}`;
    else lines.push(tail);
  };
  if (o.noRun) return say("Kitchen not started (--no-run): kitchen run works the queue");
  if (process.env.KITCHEN_ORCHESTRATOR || orchestrator(repo).running) return say("Kitchen is already working the queue");
  const more: string[] = [];
  const code = await (o.start ?? ((r, out) => run(r, { detach: true, cli: o.cli }, out)))(repo, (l) => more.push(l));
  if (more.some((l) => l.startsWith("orchestrator: already running"))) return say("Kitchen is already working the queue");
  say(code === 0 ? "Kitchen started" : "Kitchen not started");
  // The detach line repeats "started"; what else run said (a refusal, a refreshed skill) follows.
  lines.push(...more.filter((l) => !l.startsWith("orchestrator detached:")));
}
