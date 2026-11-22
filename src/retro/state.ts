// The retro's state file (.kitchen/retro/state.json) and the one question review asks it:
// is this finding's category muted for its lens? Kept apart from retro.ts so review
// can import it without importing the retro.
import fs from "node:fs";
import path from "node:path";
import { categoryOf } from "./categories.ts";
import { emptyState, type RetroState } from "./signals.ts";

export const retroDir = (repo: string) => path.join(repo, ".kitchen", "retro");
export const stateFile = (repo: string) => path.join(retroDir(repo), "state.json");

export function readRetroState(repo: string): RetroState {
  try {
    return { ...emptyState(), ...(JSON.parse(fs.readFileSync(stateFile(repo), "utf8")) as RetroState) };
  } catch {
    return emptyState();
  }
}

/** Whether a finding of this lens and title is muted: the reason to show in its place, or null. */
export function mutedFinding(repo: string, f: { lens: string; title: string; why?: string }): string | null {
  const c = categoryOf(f.title, f.why ?? "");
  const m = readRetroState(repo).mutes.find((x) => x.lens === f.lens && x.category === c);
  return m ? `muted by the retro: ${m.lens}/${m.category} after ${m.dismissals} dismissals (kitchen retro unmute ${m.lens}/${m.category})` : null;
}
