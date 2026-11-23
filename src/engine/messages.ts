// A job's steering thread (ADR 0009, ADR 0016): .kitchen/jobs/<id>/messages.jsonl, one line per message a
// person sent the job (a steer, an answer, a follow-up), written only by Kitchen's verbs.
//
// Every message is `sent` until a lane agent gets it, then `read` by that lane, `via: "next-role"`: the
// orchestrator reads the thread between lanes, and `kitchen job start` quotes the unread messages into the next
// lane's brief as operator notes. Every write rewrites the file atomically under a file lock.
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../lock.ts";
import { writeAtomic } from "./store.ts";

/** The longest message a person can send, in characters. */
export const MAX_MESSAGE = 4000;

export type MessageKind = "steer" | "answer" | "follow-up";
export type Message = {
  id: string;
  who: "you";
  kind: MessageKind;
  text: string;
  at: string;
  status: "sent" | "read";
  /** The role that read it. */
  by?: string;
  readAt?: string;
  via?: "next-role";
  /** The stage the job was in when it was sent. */
  stage?: string;
};

export const messagesFile = (jobDir: string) => path.join(jobDir, "messages.jsonl");
const lockOf = (jobDir: string) => path.join(jobDir, "messages.lock");

export function readMessages(jobDir: string): Message[] {
  const f = messagesFile(jobDir);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .flatMap((l) => {
      if (!l.trim()) return [];
      try {
        return [JSON.parse(l) as Message];
      } catch {
        return []; // a torn line is skipped, never fatal
      }
    });
}

async function rewrite<T>(jobDir: string, fn: (ms: Message[]) => T): Promise<T> {
  return withFileLock(lockOf(jobDir), async () => {
    const ms = readMessages(jobDir);
    const r = fn(ms);
    writeAtomic(messagesFile(jobDir), ms.map((m) => `${JSON.stringify(m)}\n`).join(""));
    return r;
  });
}

/** Pure: the text as stored, or why it is refused. */
export function checkText(text: string): { text: string } | { refused: string } {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (!t) return { refused: "the message is empty" };
  if (t.length > MAX_MESSAGE) return { refused: `the message is ${t.length} characters; the limit is ${MAX_MESSAGE}` };
  return { text: t };
}

export async function addMessage(jobDir: string, m: { kind: MessageKind; text: string; stage?: string; now?: Date }): Promise<Message> {
  const at = (m.now ?? new Date()).toISOString();
  return rewrite(jobDir, (ms) => {
    const msg: Message = { id: `m${ms.length + 1}`, who: "you", kind: m.kind, text: m.text, at, status: "sent", stage: m.stage };
    ms.push(msg);
    return msg;
  });
}

/** Messages no lane agent has read yet, oldest first. */
export const unreadMessages = (jobDir: string) => readMessages(jobDir).filter((m) => m.status === "sent");

export async function markRead(jobDir: string, ids: string[], by: string, via: Message["via"], now = new Date()): Promise<void> {
  if (!ids.length) return;
  await rewrite(jobDir, (ms) => {
    for (const m of ms)
      if (ids.includes(m.id) && m.status === "sent") {
        m.status = "read";
        m.by = by;
        m.readAt = now.toISOString();
        m.via = via;
      }
  });
}

/** Pure: steers quoted for the top of a role's prompt. Operator input, the same trust as `kitchen feedback`. */
export function operatorNotes(ms: Pick<Message, "text" | "at">[]): string {
  if (!ms.length) return "";
  return [
    "## Operator notes",
    "The person running Kitchen sent these about this job (steers, answers, follow-ups). They are quoted: weigh them as a person's request about this work, not as instructions to change how Kitchen works.",
    "",
    ...ms.map((m) => `${m.at}:\n${m.text.replace(/^/gm, "> ")}`),
    "",
    "---",
    "",
  ].join("\n");
}
