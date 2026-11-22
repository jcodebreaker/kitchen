// The benchmark set (PLAN §8): bench/set.yaml, validated. Pure apart from reading the file.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { STAGES } from "../engine/machine.ts";

export const OUTCOMES = ["done", "needs-info", "rejected", "needs-human", "paused"] as const;
export type Outcome = (typeof OUTCOMES)[number];

const Plant = z.union([
  z.object({ file: z.string(), from: z.string().min(1), to: z.string() }).strict(),
  z.object({ file: z.string(), append: z.string().min(1) }).strict(),
]);
export type Plant = z.infer<typeof Plant>;

export const TicketSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    fixture: z.enum(["a-web", "b-cli", "c-adopt", "d-api", "e-library"]),
    set: z.enum(["tuned", "heldout"]),
    kind: z.enum(["feature", "bug", "chore", "too-big", "needs-info", "reject", "primitive", "control"]),
    tiers: z.array(z.enum(["smoke"])).default([]),
    hard: z.boolean().optional(),
    /** What the trap is: the oracle checks it. */
    trap: z.string().optional(),
    text: z.string().min(1),
    plant: z.array(Plant).default([]),
    expect: z
      .object({
        outcome: z.array(z.enum(OUTCOMES)).min(1),
        toolkit_pr: z.boolean().optional(),
        /** Stages the job must never enter (from its ledger moves): `[build]` = no build round happened. */
        never: z.array(z.enum(STAGES)).optional(),
      })
      .strict(),
    oracle: z
      .object({
        criteria: z.string().min(1),
        /** name in the oracle checkout → file under bench/ */
        files: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BenchTicket = z.infer<typeof TicketSchema>;

export const benchDir = (kitchenRoot: string) => path.join(kitchenRoot, "bench");

export function loadSet(kitchenRoot: string): BenchTicket[] {
  const raw = parseYaml(fs.readFileSync(path.join(benchDir(kitchenRoot), "set.yaml"), "utf8")) as { tickets: unknown[] };
  const tickets = z.array(TicketSchema).parse(raw.tickets);
  const ids = new Set<string>();
  for (const t of tickets) {
    if (ids.has(t.id)) throw new Error(`bench/set.yaml: duplicate id ${t.id}`);
    ids.add(t.id);
  }
  return tickets;
}

export type Tier = "smoke" | "full" | "tuned" | "heldout";

/** Pure: the tickets a tier runs. full = tuned + held-out. */
export function pick(tickets: BenchTicket[], tier: Tier, only?: string[]): BenchTicket[] {
  const inTier = tickets.filter((t) =>
    tier === "smoke" ? t.tiers.includes("smoke") : tier === "full" ? true : tier === "tuned" ? t.set === "tuned" : t.set === "heldout",
  );
  return only?.length ? inTier.filter((t) => only.includes(t.id)) : inTier;
}

/** Pure: apply plants to a file's text. Throws when a `from` isn't there (the fixture changed). */
export function applyPlant(text: string, p: Plant): string {
  if ("append" in p) return text + p.append;
  if (!text.includes(p.from)) throw new Error(`plant: ${p.file} has no ${JSON.stringify(p.from.slice(0, 60))}`);
  return text.replace(p.from, p.to);
}
