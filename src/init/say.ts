// The quiet output of `kitchen init` and `kitchen toolkit build` (ADR 0010):
// one line per phase (what it did, its time, its cost), then a total and the
// next step. Pure formatting.

/** 0.4s, 31s, 2m 50s. */
export function dur(secs: number): string {
  if (secs < 10) return `${secs.toFixed(1)}s`;
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  return `${m}m ${Math.round(secs - m * 60)}s`;
}

export const usd = (n: number | undefined) => (n ? `$${n.toFixed(2)}` : "");

/** `  ✓ Read the repo          API on node server.js · 5 features      31s` */
export function phaseLine(ok: boolean, label: string, detail: string, secs?: number, cost?: number): string {
  const tail = [secs !== undefined ? dur(secs) : "", usd(cost)].filter(Boolean).join(" · ");
  const body = `  ${ok ? "✓" : "✗"} ${label.padEnd(22)} ${detail}`;
  return tail ? `${body.padEnd(76)} ${tail}` : body;
}
