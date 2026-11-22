// Progress during `kitchen toolkit build` (ADR 0011): an agenda strip at each phase, and
// heartbeat lines from the worker's live activity (the same agent stream the dashboard reads,
// ADR 0009), so the terminal is never silent for more than 10 seconds.
//
// The quiet-output rule (ADR 0010) holds: on a terminal the heartbeat is one status line that
// is rewritten in place and cleared before every real line; without one (a log, a pipe, CI)
// a heartbeat is appended at most once per 10 seconds, the latest activity or "still …".
import type { Ev } from "../dashboard/activity.ts";
import { dur } from "./say.ts";

export const QUIET_SECS = 10;

/** Pure: `✓ Read the repo · ▸ Writing the Toolkit · Prove it`. */
export function agendaLine(steps: string[], current: number): string {
  return steps.map((s, i) => (i < current ? `✓ ${s}` : i === current ? `▸ ${s}` : s)).join(" · ");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Pure: one agent event as a heartbeat (`writing features/loans.md`), or null for one not worth a line. */
export function beatOf(e: Ev): string | null {
  if (e.c === "think") return clip(e.t, 70);
  if (e.c === "bad") return `✗ ${clip(e.t, 60)}`;
  if (e.c !== "tool") return null;
  const tg = clip(e.tg ?? "", 60);
  switch (e.vb) {
    case "Write":
      return `writing ${tg}`;
    case "Edit":
      return `editing ${tg}`;
    case "Read":
      return `reading ${tg}`;
    case "Bash":
      return `running ${tg}`;
    case "Grep":
    case "Glob":
      return `searching ${tg}`;
    case "Plan":
      return "planning";
    case "Kitchen":
      return /^toolkit_check\b/.test(e.tg ?? "") ? "running toolkit check" : `kitchen ${tg.replace(/_/g, " ")}`;
    default:
      return e.vb ? `${e.vb} ${tg}`.trim() : null;
  }
}

export type StatusOpts = {
  tty: boolean;
  write: (s: string) => void;
  now?: () => number;
  /** Terminal width, to keep the status line on one row. */
  cols?: number;
  /** Seconds between appended heartbeats without a terminal. */
  every?: number;
};

/**
 * The one place a long command writes while it shows a heartbeat: real lines (`line`) and the heartbeat
 * (`beat`, `tick`). `tick` is called about once a second by the caller's timer.
 */
export class StatusLine {
  private text = "";
  private printed = "";
  private shown = false;
  private since: number;
  private lastOut: number;
  private lastDraw = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly every: number;
  private readonly o: StatusOpts;
  constructor(o: StatusOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.every = (o.every ?? QUIET_SECS) * 1000;
    this.since = this.now();
    this.lastOut = this.now();
  }

  private clear() {
    if (this.shown) this.o.write("\r\x1b[2K");
    this.shown = false;
  }

  private draw() {
    if (!this.text) return;
    const s = `  … ${this.text} · ${dur((this.now() - this.since) / 1000)}`;
    this.o.write(`\r\x1b[2K${clip(s, Math.max(20, (this.o.cols || 100) - 1))}`);
    this.shown = true;
    this.lastDraw = this.now();
  }

  /** A real line: the heartbeat steps aside for it. A new phase starts the clock again. */
  line(l: string) {
    this.clear();
    this.o.write(`${l}\n`);
    this.lastOut = this.now();
    if (this.o.tty) this.draw();
  }

  /** A new phase: the heartbeat and its clock start over. */
  restart() {
    this.clear();
    this.text = "";
    this.printed = "";
    this.since = this.now();
  }

  /** The worker's latest activity; empty: the worker stopped (the heartbeat goes away, e.g. before a question). */
  beat(text: string) {
    if (!text) {
      this.clear();
      this.text = "";
      return;
    }
    if (text === this.text) return;
    this.text = text;
    if (this.o.tty) {
      if (this.now() - this.lastDraw >= 200) this.draw();
    } else this.tick();
  }

  /** About once a second: redraw the clock, or append a heartbeat when it has been quiet too long. */
  tick() {
    if (this.o.tty) return this.draw();
    if (this.now() - this.lastOut < this.every) return;
    const t = (this.now() - this.since) / 1000;
    const what = this.text ? (this.text === this.printed ? `still ${this.text}` : this.text) : "working";
    this.o.write(`  … ${what} · ${dur(t)}\n`);
    this.printed = this.text;
    this.lastOut = this.now();
  }

  stop() {
    this.clear();
    this.text = "";
  }
}
