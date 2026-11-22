// Prompt tickets: `kitchen ticket "<text>"`. The author is the operator at the
// terminal, so a question lands in the job folder (question.md) and the answer
// comes from `kitchen feedback <id> "<text>"` (replies/<n>.md).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Job } from "../engine/machine.ts";
import { jobDirOf, titleOf, writeAtomic } from "../engine/store.ts";
import type { IncomingTicket, TicketSource } from "./source.ts";

export const draftsDir = (repo: string) => path.join(repo, ".kitchen", "retro", "drafts");
const slugOf = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "lesson";

export class PromptSource implements TicketSource {
  readonly kind = "prompt" as const;
  private readonly repo: string;
  constructor(repo: string) {
    this.repo = repo;
  }

  /** A ticket from text. The ref is random: typing the same text twice is two tickets. */
  static ticket(text: string): IncomingTicket {
    if (!text.trim()) throw new Error("a ticket needs some text");
    return { ref: { source: "prompt", id: randomUUID() }, title: titleOf(text), body: text };
  }

  async poll(): Promise<IncomingTicket[]> {
    return [];
  }

  async ask(job: Job, o: { key: string; text: string }) {
    const f = path.join(jobDirOf(this.repo, job.id), "question.md");
    writeAtomic(f, `<!-- ${o.key} -->\n${o.text.trim()}\n`);
  }

  async replies(job: Job): Promise<string[]> {
    const d = path.join(jobDirOf(this.repo, job.id), "replies");
    if (!fs.existsSync(d)) return [];
    const since = job.updatedAt.replace(/[:.]/g, "-"); // the job entered needs-info then
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".md") && f > since)
      .sort()
      .map((f) => fs.readFileSync(path.join(d, f), "utf8"));
  }

  /** A retro lesson as a draft: `.kitchen/retro/drafts/<n>-<slug>.md`, found again by its key. `kitchen retro approve <n>` makes it a ticket. */
  async draft(o: { key: string; title: string; body: string }): Promise<string> {
    const d = draftsDir(this.repo);
    fs.mkdirSync(d, { recursive: true });
    const head = `<!-- kitchen:${o.key} -->`;
    const files = fs.readdirSync(d).filter((f) => /^\d+-/.test(f)); // approved drafts too (renamed .approved)
    const had = files.find((f) => fs.readFileSync(path.join(d, f), "utf8").startsWith(head));
    if (had) return `draft:${had.split("-")[0]}`;
    const n = String(files.length + 1).padStart(3, "0");
    writeAtomic(path.join(d, `${n}-${slugOf(o.title)}.md`), `${head}\n# ${o.title.trim()}\n\n${o.body.trim()}\n`);
    return `draft:${n}`;
  }

  /** `kitchen feedback` on a needs-info job: store the operator's answer. */
  reply(job: Job, text: string, now = new Date()) {
    const d = path.join(jobDirOf(this.repo, job.id), "replies");
    fs.mkdirSync(d, { recursive: true });
    writeAtomic(path.join(d, `${now.toISOString().replace(/[:.]/g, "-")}.md`), `${text.trim()}\n`);
  }
}
