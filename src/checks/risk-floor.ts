// Risk floor (PLAN §6): recomputed from the diff after Gate. `high_paths`
// touched → high; a seed or migration file touched (`seed_paths`) → high and
// listed for review, since the app every proof drives is built from them (a
// builder could seed the answer a proof reads); otherwise by diff size. It only
// ever raises risk (machine.ts takes the max). Pure.
import path from "node:path";
import type { Config } from "../config.ts";
import type { Risk } from "../engine/machine.ts";

/** Diff files under `seed_paths` (seed data, migrations, fixtures the app starts from). */
export function seedTouched(diff: { file: string }[], cfg: Partial<Pick<Config, "seed_paths">>): string[] {
  return diff.filter((d) => (cfg.seed_paths ?? []).some((g) => path.matchesGlob(d.file, g))).map((d) => d.file);
}

export function riskFloor(diff: { file: string; lines: number }[], cfg: Pick<Config, "high_paths" | "risk_floor"> & Partial<Pick<Config, "seed_paths">>): Risk {
  if (diff.some((d) => cfg.high_paths.some((g) => path.matchesGlob(d.file, g)))) return "high";
  if (seedTouched(diff, cfg).length) return "high";
  const lines = diff.reduce((n, d) => n + d.lines, 0);
  if (lines >= cfg.risk_floor.diff_lines_high) return "high";
  if (lines >= cfg.risk_floor.diff_lines_medium) return "medium";
  return "low";
}
