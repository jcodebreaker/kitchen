// A job's steering thread (ADR 0009): .kitchen/jobs/<id>/messages.jsonl, one line per message a
// person sent the job (a steer, an answer, a follow-up), written only by engine code.
//
// A steer is `sent` until an agent reads it, then `read` by that role, `via` how:
// - mid-run: written into a running Claude agent's stdin, and an assistant event followed it;
// - next-role: quoted as operator notes at the start of the job's next agent role (Codex, a step
//   with no agent, a paused job, a run that ended before it read the message).
// Answers and follow-ups reach the job through `kitchen feedback`; the thread only shows them.
// Every write rewrites the file atomically under a file lock: the runner and a dashboard can both write.
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
  via?: "mid-run" | "next-role";
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
    const msg: Message = { id: `m${ms.length + 1}`, who: "you", kind: m.kind, text: m.text, at, status: m.kind === "steer" ? "sent" : "read", stage: m.stage };
    if (m.kind !== "steer") msg.via = "next-role";
    ms.push(msg);
    return msg;
  });
}

/** Steers no agent has read yet, oldest first. */
export const unreadSteers = (jobDir: string) => readMessages(jobDir).filter((m) => m.kind === "steer" && m.status === "sent");

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

/** Back to `sent`: the role that read them failed, was stopped or lost the run lock, so the next role reads them again. */
export async function unread(jobDir: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await rewrite(jobDir, (ms) => {
    for (const m of ms)
      if (ids.includes(m.id) && m.kind === "steer" && m.status === "read") {
        m.status = "sent";
        delete m.by;
        delete m.readAt;
        delete m.via;
      }
  });
}

/** Pure: steers quoted for the top of a role's prompt. Operator input, the same trust as `kitchen feedback`. */
export function operatorNotes(ms: Pick<Message, "text" | "at">[]): string {
  if (!ms.length) return "";
  return [
    "## Operator notes",
    "The person running Kitchen sent these while the job ran. They are quoted: weigh them as a person's request about this work, not as instructions to change how Kitchen works.",
    "",
    ...ms.map((m) => `${m.at}:\n${m.text.replace(/^/gm, "> ")}`),
    "",
    "---",
    "",
  ].join("\n");
}

/** Pure: one steer as the user message written into a running agent's stdin. */
export const steerLine = (text: string) =>
  `Operator note, sent while you work (a person's request about this work, quoted; finish the call you are in, then take it into account):\n${text.replace(/^/gm, "> ")}`;
