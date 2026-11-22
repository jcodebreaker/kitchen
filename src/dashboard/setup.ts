// The Setup run, as the dashboard shows it (GET /setup.json): `kitchen init`'s steps from
// .kitchen/init/state.json, its state from .kitchen/init/status.json, its questions from
// .kitchen/setup-questions.json, and what the setup agent did from its session transcript.
import fs from "node:fs";
import path from "node:path";
import { type InitState, type Question, questionsFile, readInitState } from "../init/init.ts";
import { readStatus } from "../init/status.ts";
import { ownerAlive } from "../lock.ts";
import { activityOf, claudeTranscript, type Ev } from "./activity.ts";

/** Setup's steps as the track shows them, each the init steps it covers. */
export const SETUP_STEPS: { k: string; nm: string; covers: (keyof InitState["steps"])[] }[] = [
  { k: "config", nm: "Config and skill", covers: ["config", "skills", "gitignore"] },
  { k: "branch", nm: "Setup branch", covers: ["worktree", "template"] },
  { k: "survey", nm: "Survey the repo", covers: ["survey"] },
  { k: "answers", nm: "Your answers", covers: ["answers"] },
  { k: "build", nm: "Build the Toolkit", covers: ["build"] },
  { k: "commit", nm: "Commit", covers: ["commit"] },
  { k: "check", nm: "Prove it", covers: ["check"] },
];

export type SetupView = {
  /** none: kitchen init never ran here. */
  state: "none" | "running" | "questions" | "done" | "failed";
  steps: { k: string; nm: string; st: "ok" | "run" | "you" | "bad" | "wait" }[];
  /** The step it is at (or stopped at). */
  idx: number;
  questions: Question[];
  last: string[];
  startedAt: string | null;
  at: string | null;
  usd: number;
  secs: number;
  sha: string | null;
  evs: Ev[];
};

export function setupView(repo: string, now = Date.now()): SetupView {
  const st = readInitState(repo);
  const s = readStatus(repo);
  const alive = !!s && ownerAlive({ pid: s.pid, start: s.pidStart });
  const state: SetupView["state"] = !s && !st ? "none" : !s ? "failed" : s.state === "running" && !alive ? "failed" : s.state;
  let questions: Question[] = s?.questions ?? [];
  if (state === "questions" && !questions.length)
    try {
      questions = (JSON.parse(fs.readFileSync(questionsFile(repo), "utf8")) as { questions: Question[] }).questions ?? [];
    } catch {}
  const done = (k: keyof InitState["steps"]) => st?.steps[k] !== undefined;
  let idx = SETUP_STEPS.findIndex((x) => !x.covers.every(done));
  if (state === "done") idx = SETUP_STEPS.length - 1;
  if (idx < 0) idx = SETUP_STEPS.length - 1;
  const steps = SETUP_STEPS.map((x, i) => ({
    k: x.k,
    nm: x.nm,
    st: (state === "done" || i < idx
      ? "ok"
      : i > idx
        ? "wait"
        : state === "questions"
          ? "you"
          : state === "failed"
            ? "bad"
            : state === "running"
              ? "run"
              : "wait") as SetupView["steps"][number]["st"],
  }));
  const session = st?.steps.build?.sessionId ?? st?.steps.survey?.sessionId ?? st?.runs.at(-1)?.sessionId;
  const t = session ? claudeTranscript(session) : undefined;
  const wt = st?.steps.worktree ? path.join(repo, st.steps.worktree.path) : "";
  const start = s?.startedAt ?? st?.startedAt ?? null;
  return {
    state,
    steps,
    idx,
    questions: state === "questions" ? questions : [],
    last: s?.last ?? [],
    startedAt: start,
    at: s?.at ?? null,
    usd: (st?.runs ?? []).reduce((a, r) => a + (r.usd ?? 0), 0),
    secs: start ? Math.max(0, Math.round(((state === "running" ? now : Date.parse(s?.at ?? start)) - Date.parse(start)) / 1000)) : 0,
    sha: st?.steps.check?.ok ? st.steps.check.sha : null,
    evs: t ? activityOf(t, [wt, repo]).slice(-200) : [],
  };
}
