// GitHub issues as tickets (PLAN §1 sources/github.ts), through the engine's `gh`.
//
// - Only open issues carrying the configured label (default `kitchen`) are taken
//   in. **The label is the trust boundary**: on GitHub only people with triage
//   rights can label, so an issue anyone can open is never work until someone
//   trusted labels it. The issue's text is quoted data (prompts.ts fences it).
// - needs-info: the question is a comment with a hidden key marker (idempotent);
//   an answer is a later comment by the issue's author or a configured operator,
//   never Kitchen's own comments.
import type { Config } from "../config.ts";
import type { Job } from "../engine/machine.ts";
import { gh, marker } from "../forge/github.ts";
import type { IncomingTicket, TicketSource } from "./source.ts";

type Issue = { number: number; title: string; body: string; url: string; author?: { login?: string }; labels?: { name: string }[] };
type Comment = { body: string; createdAt: string; author?: { login?: string } };

/** Pure: an issue as a ticket. */
export function ticketOf(i: Issue): IncomingTicket {
  return {
    ref: { source: "github", id: String(i.number), url: i.url },
    title: i.title.trim().slice(0, 72) || `issue ${i.number}`,
    body: `${i.title.trim()}\n\n${(i.body ?? "").trim()}`,
    author: i.author?.login,
  };
}

/** Pure: the replies that count: after `since`, by the author or an operator, not Kitchen's own. */
export function repliesOf(comments: Comment[], o: { since: string; author?: string; operators: string[] }): string[] {
  const who = new Set([...(o.author ? [o.author] : []), ...o.operators].map((x) => x.toLowerCase()));
  return comments
    .filter((c) => Date.parse(c.createdAt) > Date.parse(o.since))
    .filter((c) => who.has((c.author?.login ?? "").toLowerCase()))
    .filter((c) => !c.body.includes("<!-- kitchen:"))
    .map((c) => c.body);
}

export class GithubSource implements TicketSource {
  readonly kind = "github" as const;
  private readonly slug: string;
  private readonly label: string;
  private readonly operators: string[];
  constructor(cfg: Config) {
    if (!cfg.forge.repo) throw new Error("kitchen.yaml: forge.repo (owner/name) is required for the github ticket source");
    this.slug = cfg.forge.repo;
    this.label = cfg.source.label;
    this.operators = cfg.source.operators;
  }
  private R = () => ["--repo", this.slug];

  async poll(): Promise<IncomingTicket[]> {
    const r = await gh(
      ["issue", "list", ...this.R(), "--label", this.label, "--state", "open", "--limit", "100", "--json", "number,title,body,url,author,labels"],
      {
        json: true,
      },
    );
    return ((r.data as Issue[]) ?? []).filter((i) => (i.labels ?? []).some((l) => l.name === this.label)).map(ticketOf);
  }

  private async issue(job: Job): Promise<{ author?: string; comments: Comment[] }> {
    const r = await gh(["issue", "view", job.ticket.id, ...this.R(), "--json", "author,comments"], { json: true });
    const d = r.data as { author?: { login?: string }; comments?: Comment[] };
    return { author: d.author?.login, comments: d.comments ?? [] };
  }

  async ask(job: Job, o: { key: string; text: string }) {
    const i = await this.issue(job);
    if (i.comments.some((c) => c.body.includes(marker(o.key)))) return;
    await gh(["issue", "comment", job.ticket.id, ...this.R(), "--body-file", "-"], {
      input: `Kitchen needs one answer before it can start on this:\n\n> ${o.text.trim().replace(/\n/g, "\n> ")}\n\nReply here; Kitchen picks the reply up on its next run.\n\n${marker(o.key)}\n`,
    });
  }

  async replies(job: Job): Promise<string[]> {
    const i = await this.issue(job);
    return repliesOf(i.comments, { since: job.updatedAt, author: i.author, operators: this.operators });
  }
}
