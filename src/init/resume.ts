// Resume for `kitchen init` and `kitchen toolkit build` (ADR 0011). Every answer is written
// atomically to .kitchen/init/answers.json the moment it is given, with the step each command
// has reached, so a run that stopped (a missing tool, a failed check, Ctrl-C at a question)
// picks up where it was: answered questions aren't asked again. "Start over" moves the old
// state to `.bak` (one generation) and begins again.
//
//   { version: 1, init?: { step, at, answers }, toolkit?: { step, at, answers } }
//
// The Toolkit build keeps its own per-step record in state.json (ADR 0010); answers.json only
// adds the answers as they come and the step to show.
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "../engine/store.ts";

export type Scope = "init" | "toolkit";
export type ScopeLog = { step: string; at: string; answers: Record<string, string> };
export type ResumeLog = { version: 1; init?: ScopeLog; toolkit?: ScopeLog };

export const answersFile = (repo: string) => path.join(repo, ".kitchen", "init", "answers.json");

export function readResume(repo: string): ResumeLog {
  try {
    const j = JSON.parse(fs.readFileSync(answersFile(repo), "utf8")) as ResumeLog;
    if (j && j.version === 1) return j;
  } catch {}
  return { version: 1 };
}

function write(repo: string, log: ResumeLog) {
  fs.mkdirSync(path.dirname(answersFile(repo)), { recursive: true });
  writeAtomic(answersFile(repo), `${JSON.stringify(log, null, 2)}\n`);
}

function update(repo: string, scope: Scope, fn: (s: ScopeLog) => void) {
  const log = readResume(repo);
  const s = log[scope] ?? { step: "", at: "", answers: {} };
  fn(s);
  s.at = new Date().toISOString();
  log[scope] = s;
  write(repo, log);
}

/** One answer, on disk the moment it is given. */
export function saveAnswer(repo: string, scope: Scope, key: string, value: string) {
  update(repo, scope, (s) => {
    s.answers[key] = value;
  });
}

/** The step this command has reached (`done` when it finished). */
export function markStep(repo: string, scope: Scope, step: string) {
  update(repo, scope, (s) => {
    s.step = step;
  });
}

/** Where the last run of this command stopped, if it didn't finish. */
export function stoppedAt(repo: string, scope: Scope): string | null {
  const s = readResume(repo)[scope];
  return s?.step && s.step !== "done" ? s.step : null;
}

const toBak = (f: string) => {
  if (!fs.existsSync(f)) return false;
  fs.rmSync(`${f}.bak`, { recursive: true, force: true });
  fs.renameSync(f, `${f}.bak`);
  return true;
};

/**
 * Start over: answers.json goes to answers.json.bak (the other command's answers are kept in the new
 * one), and each of `files` (this command's own state) goes to `<file>.bak`. Returns what was moved.
 */
export function startOver(repo: string, scope: Scope, files: string[]): string[] {
  const log = readResume(repo);
  const moved: string[] = [];
  if (fs.existsSync(answersFile(repo))) {
    fs.copyFileSync(answersFile(repo), `${answersFile(repo)}.bak`);
    moved.push(answersFile(repo));
    delete log[scope];
    write(repo, log);
  }
  for (const f of files) if (toBak(f)) moved.push(f);
  return moved.map((f) => path.relative(repo, f));
}
