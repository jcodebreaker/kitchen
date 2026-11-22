// The stage handler interface. A handler runs one stage once: it calls the role
// (through the agent adapter) and the engine's own checks, gathers the facts
// the machine's guards read, and proposes where the job goes. The runner asks
// machine.ts to make the move; a handler never writes the stage itself.
//
// Handlers are idempotent: a role whose file is already in the job folder for
// this stage entry is not run again, and every side effect goes through `once`.
import type { AgentAdapter } from "../../agents/adapter.ts";
import type { Config } from "../../config.ts";
import type { Forge } from "../../forge/forge.ts";
import type { TicketSource } from "../../sources/source.ts";
import type { Facts, Job, Stage } from "../machine.ts";

export type StageContext = {
  repo: string;
  /** The job as it was when the stage started. Handlers that change it re-read it (ctx.refresh). */
  job: Job;
  jobDir: string;
  config: Config;
  agent: AgentAdapter;
  forge: Forge;
  source: TicketSource;
  now: () => Date;
  log: (msg: string) => void;
  /** The job as it is on disk now. */
  refresh: () => Job;
};

export type Proposal = { to: Stage; facts: Omit<Facts, "now">; note?: string };

export type StageHandler = (ctx: StageContext) => Promise<Proposal>;

/** A role run that didn't produce its file. The runner turns it into backoff (rate limit, auth) or an adapter error. */
export class RoleFailure extends Error {
  readonly rateLimited: boolean;
  readonly authFailure: boolean;
  constructor(message: string, o: { rateLimited?: boolean; authFailure?: boolean } = {}) {
    super(message);
    this.rateLimited = !!o.rateLimited;
    this.authFailure = !!o.authFailure;
  }
}
