// ADR 0020: a ticket refined with its author before it is built. Intake (unattended) only flags it: `DECISION: REFINE`
// moves the job to needs-info, marked `waits: refine`. `kitchen refine <id>` writes a brief for a session with the
// person in it (the /kitchen skill in Claude Code or Codex): grill the ticket one question at a time, agree a refined
// ticket, then `kitchen feedback` sends it back to intake as the author's own words. Lane agents never grill.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { mapAt } from "../verify/admit.ts";
import { intakeMapSection } from "../verify/brief.ts";
import { clarificationsSection, readRounds } from "./clarify.ts";
import { type Criterion, intakeFile, readIntake } from "./lanes.ts";
import type { Job, RefineReason } from "./machine.ts";
import { stagingTip } from "./staging.ts";
import { findJob, JOB_ID, jobDirOf, writeAtomic } from "./store.ts";

export type Out = (line: string) => void;

/** Why intake can't build the ticket as written, per reason: the end of "Kitchen can't build it as written: …". */
export const REFINE_WHY: Record<RefineReason, string> = {
  readings: "it can be read more than one way, and each reading builds something different",
  "too-big": "it is more than one job",
  "no-repro": "it is a bug with no way yet to see it happen",
  terms: "it uses words the code or the glossary mean differently",
};
const LIST_OF: Record<RefineReason, string> = {
  readings: "The readings intake found",
  "too-big": "The slices intake sketched",
  "no-repro": "What is missing to see the bug",
  terms: "The words in question",
};
const START_FROM: Record<RefineReason, string> = {
  readings: "Have the person pick one reading, or say what they meant instead. Ask what each reading would leave out.",
  "too-big":
    "Agree the slices and their order. Each slice is one job a reviewer can read in one sitting (Kitchen holds a change over {max} lines for a person), and each is useful on its own.",
  "no-repro": "Get the steps to see the bug: where, as whom, what they did, what they saw, what they expected instead.",
  terms: "Settle what each word means in this repo, against the code and GLOSSARY.md, and which one the ticket means.",
};

/** The job's number (`004`), as a person types it. */
export const numOf = (id: string) => JOB_ID.exec(id)?.[1] ?? id;

/** The question a refine job asks: in question.md (the dashboard) and in the clarification thread (intake). */
export function refineQuestion(job: Pick<Job, "id">, reason: RefineReason, items: string[]): string {
  return [
    `Refine with you (${reason}): ${REFINE_WHY[reason]}.`,
    ...items.map((x) => `- ${x}`),
    "",
    `Refine it in Claude Code or Codex: \`/kitchen refine ${numOf(job.id)}\`. Or answer here.`,
  ].join("\n");
}

/** The question a confirm job asks (`intake.confirm`): intake's criteria and what it left out. */
export function confirmQuestion(job: Pick<Job, "id">, criteria: Criterion[], leftOut: string): string {
  return [
    "Intake's reading, for you to approve before it is built:",
    ...criteria.map((c) => `- ${c.id} (${c.check}): ${c.text}`),
    `Left out: ${leftOut || "nothing"}`,
    "",
    `Approve it (\`kitchen approve ${numOf(job.id)}\`), or say what to change.`,
  ].join("\n");
}

/** `2026-11-23 21:26`, in this machine's time zone: the person reads it. */
const localTime = (iso: string) => {
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fence = (s: string) => {
  let f = "~~~~";
  while (s.includes(f)) f += "~";
  return f;
};

/** The refine brief: what the session reads before it grills the person. Pure apart from reading the repo. */
export async function refineBrief(repo: string, job: Job, file: string): Promise<string> {
  const cfg = loadConfig(repo);
  const dir = jobDirOf(repo, job.id);
  const n = numOf(job.id);
  const w = job.waits?.for === "refine" ? job.waits : null;
  const i = readIntake(dir);
  const reason = w?.reason ?? (i?.decision === "REFINE" ? i.reason : "readings");
  const items = i?.decision === "REFINE" ? i.items : [];
  let said = "";
  try {
    said = /^REASON:[ \t]*(.*)$/m.exec(fs.readFileSync(intakeFile(dir), "utf8"))?.[1].trim() ?? "";
  } catch {}
  const ticket = fs.readFileSync(path.join(dir, "ticket.md"), "utf8").trim();
  const answered = clarificationsSection(readRounds(dir).filter((r) => r.answers.length));
  const t = answered ? `${ticket}\n\n${answered}` : ticket;
  const map = intakeMapSection(
    await mapAt(repo, (await stagingTip(repo, cfg)) ?? "HEAD"),
    "Use these ids when a criterion is about a feature that already exists.",
  );
  const docs = [
    ["GLOSSARY.md", "the repo's terms"],
    ["GLOSSARY-MAP.md", "where each term lives in the code"],
    ["docs/adr", "decisions already made"],
  ]
    .filter(([p]) => fs.existsSync(path.join(repo, p)))
    .map(
      ([p, what]) =>
        `- \`${path.join(repo, p)}\`: ${what}${p === "docs/adr" ? ` (${fs.readdirSync(path.join(repo, p)).filter((f) => f.endsWith(".md")).length} files)` : ""}`,
    );
  return [
    `# Refine job ${n} with its author`,
    "",
    `Kitchen can't build this ticket as written: ${REFINE_WHY[reason]}. Kitchen's agents work unattended and only ask short questions, so the ticket is refined here, with the person, before anything is built. You lead that conversation; the person decides.`,
    "",
    `- Job: ${job.id} "${job.title}" · waiting for refinement since ${localTime(w?.at ?? job.updatedAt)}`,
    `- Repository: ${repo} (read the code; change no code)`,
    `- This brief: ${file}`,
    "",
    "## The ticket (the author's words, with their earlier answers)",
    "",
    fence(t),
    t,
    fence(t),
    "",
    `## Why intake sent it here: ${reason}`,
    "",
    ...(said ? [`Intake: ${said}`, ""] : []),
    `${LIST_OF[reason]}:`,
    ...(items.length ? items.map((x) => `- ${x}`) : ["- (intake listed none: read its intake.md in the job folder)"]),
    "",
    map,
    "## The repo's own words",
    "",
    ...(docs.length
      ? docs
      : ["The repo has no GLOSSARY.md, GLOSSARY-MAP.md or docs/adr/ yet: the domain-modeling skill starts them when a term or a decision is settled."]),
    "",
    "## Steps",
    "",
    "1. Read the ticket, the code it is about and the files above. Don't ask the person what the code or the docs already answer.",
    "2. Run the `grill-with-docs` skill with the person on this ticket. Without it, run `grilling` together with `domain-modeling`. Without those, do it by hand: one question per turn, each with your recommended answer and why, until nothing is left open.",
    `3. Start from intake's reason. ${START_FROM[reason].replace("{max}", String(cfg.staging.max_lines))}`,
    "4. One question at a time. Never answer for the person and never invent an answer: what they haven't said stays open.",
    "5. Write the terms you settle to GLOSSARY.md, and a decision that is hard to reverse to docs/adr/, as the skill says. Change nothing else in the repo.",
    "6. Write the refined ticket in this shape:",
    "",
    "   ```",
    "   Problem: <one or two sentences: who, and what is wrong or missing>",
    "   In:",
    "   - <what this job does>",
    "   Out:",
    "   - <what it doesn't do>",
    "   Criteria (agreed with you):",
    "   - <a behaviour someone can check on the running app: a page, a request, a test or a command>",
    "   Slices (only when too big, in order):",
    "   1. <this job>",
    "   2. <the next one>",
    "   ```",
    "",
    `7. Show it to the person and ask whether to send it to Kitchen. Change it until they say yes.`,
    `8. Send it: \`kitchen feedback ${n} "<the refined ticket>"\`. Intake reads it as the author's own words and writes the criteria from it.`,
    "",
    `${reason === "too-big" ? "Too big" : "If it turns out to be more than one job"}: job ${n} becomes slice 1. Its refined ticket says so and lists the later slices under Out. After the feedback, file each later slice as its own ticket, in order, naming the job it comes after: \`kitchen ticket "<slice 2>. Comes after job ${n}."\` (\`kitchen ticket\` prints the new job's number, for the next slice to name). Intake reads that as \`AFTER:\`.`,
    "",
  ].join("\n");
}

/** `kitchen refine <id>`: the brief for a job waiting for refinement, and what to do with it. */
export async function refine(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (job.stage !== "needs-info" || job.waits?.for !== "refine") {
    out(
      `${job.id}  isn't waiting for refinement (it is ${job.stage}${job.waits?.for === "confirm" ? ", waiting for your approval: kitchen approve" : ""}): kitchen refine is for a job intake sent to be refined with you`,
    );
    return 1;
  }
  const file = path.join(jobDirOf(repo, job.id), "refine", "brief.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, await refineBrief(repo, job, file));
  out(`${job.id}  refine brief: ${file}`);
  out(`Read it and follow its steps with the person, one question at a time; it ends with kitchen feedback ${numOf(job.id)} "<the refined ticket>".`);
  return 0;
}
