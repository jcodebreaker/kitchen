// GitHub issues as tickets (PLAN §1 sources/github.ts), through the engine's `gh`.
//
// - Only open issues carrying the configured label (default `kitchen`) are taken
//   in. **The label is the trust boundary**: on GitHub only people with triage
//   rights can label, so an issue anyone can open is never work until someone
//   trusted labels it. What the labeller saw is what is taken in: an issue whose
//   body or title was edited after its latest label event is not taken in; it gets
//   one comment asking for the label to be applied again (a new label event
//   vouches for the edited text). The issue's text is quoted data (prompts.ts fences it).
// - needs-info: the question is a comment with a hidden key marker (idempotent);
//   an answer is a later comment by the issue's author or a configured operator,
//   never Kitchen's own comments. "Later" is by position after Kitchen's last
//   question in the thread (GitHub's order), not by the local clock.
import type { Config } from "../config.ts";
import type { Job } from "../engine/machine.ts";
import { listJobs } from "../engine/store.ts";
import { gh, marker, numberOf } from "../forge/github.ts";
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

/**
 * Pure: the replies that count: by the author or an operator, not Kitchen's own, and after
 * Kitchen's last question in the thread (by position: GitHub's order). With no question in the
 * thread (asked elsewhere), after `since`.
 */
export function repliesOf(comments: Comment[], o: { since: string; author?: string; operators: string[] }): string[] {
  const who = new Set([...(o.author ? [o.author] : []), ...o.operators].map((x) => x.toLowerCase()));
  const lastAsk = comments.map((c) => c.body.includes("<!-- kitchen:ask/")).lastIndexOf(true);
  return comments
    .filter((c, i) => (lastAsk >= 0 ? i > lastAsk : Date.parse(c.createdAt) > Date.parse(o.since)))
    .filter((c) => who.has((c.author?.login ?? "").toLowerCase()))
    .filter((c) => !c.body.includes("<!-- kitchen:"))
    .map((c) => c.body);
}

/** The issue's edit and label history, as GitHub's GraphQL API gives it. */
export type LabelHistory = { lastEditedAt: string | null; events: { type: "labeled" | "renamed"; at: string; label?: string }[] };

/**
 * Pure: whether the issue's text changed after it was last labelled `label` (a body edit or a
 * title rename later than the latest label event), so the labeller never vouched for it.
 * Returns the edit time, or null when the text is as labelled. No label event at all: refused.
 */
export function editedAfterLabel(h: LabelHistory, label: string): string | null {
  const labelled = h.events
    .filter((e) => e.type === "labeled" && e.label === label)
    .map((e) => Date.parse(e.at))
    .sort((a, b) => b - a)[0];
  const edits = [...(h.lastEditedAt ? [h.lastEditedAt] : []), ...h.events.filter((e) => e.type === "renamed").map((e) => e.at)];
  const last = edits.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  if (labelled === undefined) return last ?? "never labelled";
  return last && Date.parse(last) > labelled ? last : null;
}

const HISTORY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){lastEditedAt timelineItems(last:50,itemTypes:[LABELED_EVENT,RENAMED_TITLE_EVENT]){nodes{__typename ... on LabeledEvent{createdAt label{name}} ... on RenamedTitleEvent{createdAt}}}}}}`;

export class GithubSource implements TicketSource {
  readonly kind = "github" as const;
  private readonly slug: string;
  private readonly label: string;
  private readonly operators: string[];
  private readonly repo: string | undefined;
  /** `repo`: issues already taken in there skip the label-history check (their text is in the job). */
  constructor(cfg: Config, repo?: string) {
    if (!cfg.forge.repo) throw new Error("kitchen.yaml: forge.repo (owner/name) is required for the github ticket source");
    this.slug = cfg.forge.repo;
    this.label = cfg.source.label;
    this.operators = cfg.source.operators;
    this.repo = repo;
  }
  private R = () => ["--repo", this.slug];

  async poll(): Promise<IncomingTicket[]> {
    const r = await gh(
      ["issue", "list", ...this.R(), "--label", this.label, "--state", "open", "--limit", "100", "--json", "number,title,body,url,author,labels"],
      {
        json: true,
      },
    );
    const labelled = ((r.data as Issue[]) ?? []).filter((i) => (i.labels ?? []).some((l) => l.name === this.label));
    const taken = new Set(this.repo ? listJobs(this.repo).flatMap((j) => (j.ticket.source === "github" ? [j.ticket.id] : [])) : []);
    const out: IncomingTicket[] = [];
    for (const i of labelled) {
      if (taken.has(String(i.number))) {
        out.push(ticketOf(i)); // already a job: createJob finds it; its text was checked when it was taken in
        continue;
      }
      const edited = editedAfterLabel(await this.history(i.number), this.label);
      if (!edited) {
        out.push(ticketOf(i));
        continue;
      }
      await this.note(
        i.number,
        `edited-after-label/${edited}`,
        `Kitchen did not take this issue in: its text was edited (${edited}) after it was labelled \`${this.label}\`, so nobody with triage rights has seen this version. Remove and add the \`${this.label}\` label again to take it in as it reads now.`,
      );
    }
    return out;
  }

  private async history(n: number): Promise<LabelHistory> {
    const [owner, name] = this.slug.split("/");
    const r = await gh(["api", "graphql", "-f", `query=${HISTORY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${n}`], { json: true });
    type Node = { __typename: string; createdAt: string; label?: { name: string } };
    const issue = (r.data as { data?: { repository?: { issue?: { lastEditedAt: string | null; timelineItems?: { nodes?: Node[] } } } } }).data?.repository
      ?.issue;
    return {
      lastEditedAt: issue?.lastEditedAt ?? null,
      events: (issue?.timelineItems?.nodes ?? []).map((x) =>
        x.__typename === "LabeledEvent" ? { type: "labeled", at: x.createdAt, label: x.label?.name } : { type: "renamed", at: x.createdAt },
      ),
    };
  }

  private async issue(id: string): Promise<{ author?: string; comments: Comment[] }> {
    const r = await gh(["issue", "view", id, ...this.R(), "--json", "author,comments"], { json: true });
    const d = r.data as { author?: { login?: string }; comments?: Comment[] };
    return { author: d.author?.login, comments: d.comments ?? [] };
  }

  /** One comment per key (found again by its hidden marker). */
  private async note(n: number, key: string, text: string) {
    const i = await this.issue(String(n));
    if (i.comments.some((c) => c.body.includes(marker(key)))) return;
    await gh(["issue", "comment", String(n), ...this.R(), "--body-file", "-"], { input: `${text}\n\n${marker(key)}\n` });
  }

  async ask(job: Job, o: { key: string; text: string }) {
    await this.note(
      Number(job.ticket.id),
      o.key,
      `Kitchen needs one answer before it can start on this:\n\n> ${o.text.trim().replace(/\n/g, "\n> ")}\n\nReply here; Kitchen picks the reply up on its next run.`,
    );
  }

  /**
   * A retro lesson as an issue **without** the source label: the label is the trust boundary, so Kitchen never
   * works on its own proposal until a person labels it. Found again by its hidden key marker.
   */
  async draft(o: { key: string; title: string; body: string }): Promise<string> {
    // Only issues Kitchen (this gh user) opened: anyone can paste the marker into an issue of their own.
    const r = await gh(
      ["issue", "list", ...this.R(), "--state", "all", "--author", "@me", "--search", `"kitchen:${o.key}" in:body`, "--limit", "20", "--json", "number,body"],
      {
        json: true,
      },
    );
    const had = ((r.data as { number: number; body: string }[]) ?? []).find((i) => i.body.includes(marker(o.key)));
    if (had) return `#${had.number}`;
    const c = await gh(["issue", "create", ...this.R(), "--title", o.title, "--body-file", "-"], { input: `${o.body}\n\n${marker(o.key)}\n` });
    return `#${numberOf(c.out.trim().split("\n").pop() ?? "")}`;
  }

  async replies(job: Job): Promise<string[]> {
    const i = await this.issue(job.ticket.id);
    return repliesOf(i.comments, { since: job.updatedAt, author: i.author, operators: this.operators });
  }
}
