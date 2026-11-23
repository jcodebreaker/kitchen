// The clarification thread: what intake asked the ticket's author (NEEDS-INFO) and what they answered,
// round by round, in .kitchen/jobs/<id>/clarifications.json. Written only by engine code: intake records
// the question it asks, and the answer is recorded where it arrives (`kitchen feedback` and the dashboard
// for a prompt ticket, the runner's needs-info check for an issue comment). Every role's prompt quotes
// the thread inside the ticket fence (prompts.ts): the answers are the ticket author's own words, the
// same trust as the ticket text, so a question answered once is never asked again.
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "./store.ts";

export type Round = { key: string; question: string; at: string; answers: string[] };

const fileOf = (jobDir: string) => path.join(jobDir, "clarifications.json");

/**
 * The rounds, oldest first. A job from before this file (a question.md and replies/ only) reads as one round:
 * its last question with every reply, so a job that looped on its question gets its answers now.
 */
export function readRounds(jobDir: string): Round[] {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(jobDir), "utf8")) as Round[];
    return Array.isArray(v) ? v : [];
  } catch {
    return legacyRounds(jobDir);
  }
}

function legacyRounds(jobDir: string): Round[] {
  let q: string;
  try {
    q = fs.readFileSync(path.join(jobDir, "question.md"), "utf8");
  } catch {
    return [];
  }
  const key = /<!--\s*(\S+)\s*-->/.exec(q)?.[1] ?? "ask";
  const d = path.join(jobDir, "replies");
  const answers = fs.existsSync(d)
    ? fs
        .readdirSync(d)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => fs.readFileSync(path.join(d, f), "utf8").trim())
        .filter(Boolean)
    : [];
  return [{ key, question: q.replace(/<!--[\s\S]*?-->/g, "").trim(), at: "", answers }];
}

const save = (jobDir: string, rounds: Round[]) => writeAtomic(fileOf(jobDir), `${JSON.stringify(rounds, null, 2)}\n`);

/** Intake asked a question. Idempotent by key: a re-run of the same intake entry rewrites its round, never adds one. */
export function recordQuestion(jobDir: string, o: { key: string; question: string; now?: Date }) {
  const rounds = readRounds(jobDir);
  const had = rounds.find((r) => r.key === o.key);
  if (had) had.question = o.question.trim();
  else rounds.push({ key: o.key, question: o.question.trim(), at: (o.now ?? new Date()).toISOString(), answers: [] });
  save(jobDir, rounds);
}

/**
 * The author's answers to the latest question. `replace`: the source's full list of replies since the question
 * (an issue's comments), so reading it twice records it once; otherwise one more answer (`kitchen feedback`).
 * Nothing is recorded when no question was asked.
 */
export function recordAnswers(jobDir: string, answers: string[], o: { replace?: boolean } = {}) {
  const rounds = readRounds(jobDir);
  const last = rounds.at(-1);
  const add = answers.map((a) => a.trim()).filter(Boolean);
  if (!last || !add.length) return;
  last.answers = o.replace ? add : [...last.answers, ...add];
  save(jobDir, rounds);
}

/** Pure: the thread as a section of the ticket, or "" when nothing was asked. */
export function clarificationsSection(rounds: Round[]): string {
  if (!rounds.length) return "";
  return [
    "## Clarifications",
    "",
    "Kitchen asked the ticket's author these questions; the answers are the author's own words and are part of the ticket. An answer settles its question.",
    ...rounds.flatMap((r, i) => [
      "",
      `### Question ${i + 1}`,
      r.question.replace(/^/gm, "> "),
      "",
      r.answers.length ? `The author answered:` : "Not answered yet.",
      ...r.answers.flatMap((a, k) => [...(k ? [""] : []), a.replace(/^/gm, "> ")]),
    ]),
  ].join("\n");
}
