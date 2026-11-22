// The README's role → skill table, generated from skills/registry.json between two markers, so the
// two can't drift (a test fails when they do). `npm run skills:readme` rewrites it.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRegistry, type Registry, type Rule } from "./registry.ts";

export const START = "<!-- skills-registry:start (generated from skills/registry.json: npm run skills:readme) -->";
export const END = "<!-- skills-registry:end -->";

const when = (r: Rule) =>
  [r.kind && `kind ${r.kind.join("/")}`, r.surface && `${r.surface.join("/")} surface`, r.risk && `${r.risk.join("/")} risk`].filter(Boolean).join(", ");
const code = (n: string) => `\`${n}\``;

/** Pure: the markdown table, one row per role. */
export function registryTable(reg: Registry): string {
  const rows = Object.entries(reg.roles).map(([role, e]) => {
    const req = e.required.map((r) => `${code(r.skill)}${when(r) ? ` (${when(r)})` : ""}`);
    const picked = e.picked.map((r) => `${when(r)} → ${code(r.skill)}`);
    const opt = [...e.optional.map(code), ...(e.ticket ? ["the ticket's `Skills:` line (required)"] : [])];
    return `| ${role} | ${req.join("; ") || "—"} | ${picked.join("; ") || "—"} | ${opt.join(", ") || "—"} | ${e.fallback} |`;
  });
  return [
    "| Role | Required | Picked by kind / surface / risk | Optional | Fallback if missing |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `Never loaded (interactive): ${reg.forbidden.map(code).join(", ")}.`,
  ].join("\n");
}

/** Pure: `readme` with the text between the markers replaced by the table. Throws without the markers. */
export function syncReadme(readme: string, reg: Registry): string {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error(`README.md has no ${START} … ${END} block`);
  return `${readme.slice(0, a + START.length)}\n${registryTable(reg)}\n${readme.slice(b)}`;
}

export const README = path.resolve(import.meta.dirname, "..", "..", "README.md");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = fs.readFileSync(README, "utf8");
  const next = syncReadme(text, loadRegistry());
  if (next !== text) fs.writeFileSync(README, next);
  console.log(next === text ? "README.md: the skills table is current" : "README.md: the skills table was rewritten");
}
