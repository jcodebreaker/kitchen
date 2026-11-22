// Where tickets come from (PLAN §1 sources/). One interface for prompt tickets
// (W1) and GitHub issues (W3b): take tickets in, ask the author a question,
// and tell the runner when an answer arrived (needs-info → intake).
import type { Job, TicketRef } from "../engine/machine.ts";

export type IncomingTicket = { ref: TicketRef; title: string; body: string; author?: string };

export interface TicketSource {
  readonly kind: TicketRef["source"];
  /** New tickets to take in. Prompt tickets come from `kitchen ticket`, so a prompt source lists none. */
  poll(): Promise<IncomingTicket[]>;
  /** Post a question to the author (needs-info). Idempotent by key. */
  ask(job: Job, o: { key: string; text: string }): Promise<void>;
  /** Replies since the job entered needs-info (job.updatedAt); empty while there are none. */
  replies(job: Job): Promise<string[]>;
}
