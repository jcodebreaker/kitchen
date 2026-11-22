// Feature drives hold no code (PLAN §2 "Toolkit: two layers", ADR 0005). A
// feature file (`.kitchen/toolkit/features/<x>.md`) written in a job is refused
// when it carries anything the engine or anyone else could run: a fenced code
// block in a programming language, a drive block outside the restricted format
// (unknown keys, multi-line values, anchors: drive-format.ts), or a step that
// names a code runner instead of a primitive. A step naming any other primitive
// the Toolkit lacks is a Toolkit gap, not a refusal. Pure.
import { DriveFormatError, extractDriveBlocks, parseDrive } from "../proof/drive-format.ts";

const CODE_FENCE =
  /^(```|~~~)\s*(js|javascript|mjs|cjs|jsx|ts|typescript|tsx|sh|bash|zsh|shell|console|python|py|ruby|rb|perl|php|sql|node|powershell|ps1|go|rust|java|lua|html)\b/i;
const CODE_STEP = /^(eval|exec|execute|js|javascript|script|run|sh|shell|bash|node|python|code|cmd|command|spawn|system)$/i;

export type FeatureLint = { ok: true; drives: string[]; gaps: string[] } | { ok: false; reason: string };

export function lintFeatureFile(md: string, primitives: string[]): FeatureLint {
  for (const [i, line] of md.split("\n").entries()) {
    if (CODE_FENCE.test(line.trim())) return { ok: false, reason: `line ${i + 1}: a feature drive file can't hold code (${line.trim()})` };
    if (/<script\b/i.test(line)) return { ok: false, reason: `line ${i + 1}: a feature drive file can't hold a <script>` };
  }
  let blocks: ReturnType<typeof extractDriveBlocks>;
  try {
    blocks = extractDriveBlocks(md);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (!blocks.length) return { ok: false, reason: "no ```drive block" };
  const drives: string[] = [];
  const gaps: string[] = [];
  for (const b of blocks) {
    try {
      const d = parseDrive(b.body, b.line);
      for (const s of d.steps) {
        if (s.kind !== "prim") continue;
        if (CODE_STEP.test(s.name)) return { ok: false, reason: `${d.name} line ${s.line}: "${s.name}" would run code; a drive is primitive calls only` };
        if (!primitives.includes(s.name)) gaps.push(s.name);
      }
      drives.push(d.name);
    } catch (e) {
      if (e instanceof DriveFormatError) return { ok: false, reason: `drive block at line ${b.line}: ${e.message}` };
      throw e;
    }
  }
  return { ok: true, drives, gaps: [...new Set(gaps)] };
}
