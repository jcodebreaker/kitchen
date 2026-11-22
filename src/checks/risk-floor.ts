// Risk floor (PLAN §6): recomputed from the diff after Gate. `high_paths`
// touched → high; otherwise by diff size. It only ever raises risk (machine.ts
// takes the max). Pure.
import path from "node:path";
import type { Config } from "../config.ts";
import type { Risk } from "../engine/machine.ts";

export function riskFloor(diff: { file: string; lines: number }[], cfg: Pick<Config, "high_paths" | "risk_floor">): Risk {
  if (diff.some((d) => cfg.high_paths.some((g) => path.matchesGlob(d.file, g)))) return "high";
  const lines = diff.reduce((n, d) => n + d.lines, 0);
  if (lines >= cfg.risk_floor.diff_lines_high) return "high";
  if (lines >= cfg.risk_floor.diff_lines_medium) return "medium";
  return "low";
}
