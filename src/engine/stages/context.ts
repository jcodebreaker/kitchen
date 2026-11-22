// Context blocks the stages hand their roles (prompts.ts `blocks`): the
// contract, the Toolkit, and why earlier rounds failed. All read from the job
// folder and the Toolkit, never from what an agent said about itself.
import fs from "node:fs";
import path from "node:path";
import type { Dismissal, Member } from "../../checks/findings.ts";
import { parseRequirements, type Requirement, withSpecMarks } from "../../checks/spec-lint.ts";
import { inLayout, type TestLayout, testLayout } from "../../checks/test-layout.ts";
import { contractOf } from "../contract.ts";
import type { Job } from "../machine.ts";
import { roundDir } from "../store.ts";
import type { PromptBlock } from "./prompts.ts";
import { toolkitBrief } from "./toolkit-info.ts";

export function contractBlock(jobDir: string): PromptBlock {
  const c = contractOf(jobDir);
  return { title: `The contract (${c?.file ?? "none yet"})`, body: c ? c.text : "No criteria yet." };
}

export function fileBlock(jobDir: string, file: string, title = file): PromptBlock[] {
  const p = path.join(jobDir, file);
  return fs.existsSync(p) ? [{ title, body: fs.readFileSync(p, "utf8") }] : [];
}

/** The requirements the contract is held to: intake.md's, with the spec's re-marks (spec-lint withSpecMarks). */
export function jobRequirements(jobDir: string): Requirement[] {
  const read = (f: string) => (fs.existsSync(path.join(jobDir, f)) ? fs.readFileSync(path.join(jobDir, f), "utf8") : "");
  return withSpecMarks(parseRequirements(read("intake.md")), read("spec.md"));
}

export async function toolkitBlock(job: Job, src: string): Promise<PromptBlock> {
  try {
    return { title: "The Toolkit", body: await toolkitBrief(job, src) };
  } catch (e) {
    return { title: "The Toolkit", body: `describe failed: ${(e as Error).message}` };
  }
}

/** A few of the repo's existing files the layout matches, for the role to copy where tests go. */
function existingTests(dir: string, layout: TestLayout, max = 6): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", ".worktrees", ".kitchen", "dist", "build", ".venv", "venv", "__pycache__"]);
  let seen = 0;
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max || ++seen > 5000) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(p);
      } else if (inLayout(p, layout)) out.push(p);
    }
  };
  walk("");
  return out;
}

/** Where the repo's tests live (dogfood: test proofs in a new `tests/` and a widened vitest include). */
export function testLayoutBlock(dir: string, testCmd: string): PromptBlock[] {
  const layout = testLayout(dir, testCmd);
  if (!layout) return [];
  const have = existingTests(dir, layout);
  return [
    {
      title: "The repo's test layout",
      body: [
        `Runner: ${layout.runner} (from ${layout.source}). It runs files matching: ${layout.globs.map((g) => `\`${g}\``).join(", ")}.`,
        have.length ? `Existing tests: ${have.join(", ")}.` : "No test file matches yet.",
        "A new test file goes where these live, named like them. Never add a test folder the runner doesn't read, and never change the runner's config (its include or testMatch) to reach one: spec-lint refuses a `test` proof outside these globs, and the engine keeps test-runner config edits off the branch.",
      ].join("\n"),
    },
  ];
}

/** What went wrong in earlier rounds: the gate, the verdict, an unreachable drive. Newest round first. */
export function earlierRoundsBlock(jobDir: string, job: Job): PromptBlock[] {
  const out: string[] = [];
  for (let r = job.round - 1; r >= 1 && out.length < 6; r--) {
    const dir = roundDir(jobDir, r);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).sort();
    const gate = files.includes("gate.md") ? fs.readFileSync(path.join(dir, "gate.md"), "utf8") : "";
    if (/RESULT:\s*FAIL/.test(gate)) out.push(`## Round ${r}: Gate FAIL\n${gate}`);
    const verdicts = files.filter((f) => /^verdict-m\d+\.md$/.test(f));
    const last = verdicts.sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0])).at(-1);
    if (last) {
      const v = fs.readFileSync(path.join(dir, last), "utf8");
      if (!/^VERDICT:\s*PASS/m.test(v)) out.push(`## Round ${r}: Verify\n${v}`);
    }
    if (files.includes("review.md")) {
      const t = fs.readFileSync(path.join(dir, "review.md"), "utf8");
      // Only what blocked: notes are not the builder's to chase.
      if (/^REVIEW:\s*BLOCKING/m.test(t)) {
        const [head, table] = t.split("\n\n");
        const rows = (table ?? "").split("\n").filter((l, i) => i < 2 || / BLOCKS /.test(l));
        out.push(`## Round ${r}: Review BLOCKING (fix what blocks; the findings name the line, requirement or evidence)\n${head}\n\n${rows.join("\n")}`);
      }
    }
    for (const d of files.filter((f) => /^drives-\d+\.md$/.test(f))) {
      const t = fs.readFileSync(path.join(dir, d), "utf8");
      if (/DRIVES:\s*UNREACHABLE/.test(t)) out.push(`## Round ${r}: the verifier could not reach the feature\n${t}`);
    }
  }
  // A finding a person dismissed (`kitchen dismiss`) is not the builder's to fix, even when it blocked.
  const dismissed = dismissalsOf(jobDir);
  if (dismissed.length)
    out.push(
      `## Dismissed review findings (a person said these are not to be fixed)\n${dismissed
        .map(
          (d) =>
            `- ignore: ${d.finding}${d.title ? ` "${d.title}"` : ""}${d.at ? ` (${d.at.file}:${d.at.line})` : d.requirement ? ` (${d.requirement})` : ""}: dismissed by ${d.by}${d.reason ? `: ${d.reason}` : ""}`,
        )
        .join("\n")}`,
    );
  return out.length ? [{ title: "Earlier rounds (fix these first)", body: out.join("\n\n") }] : [];
}

/** Human feedback (`kitchen feedback`, a trusted PR comment), newest last: the builder addresses it, and so does the spec role when a person sends the job back to spec. */
export function humanFeedback(jobDir: string): string[] {
  const d = path.join(jobDir, "feedback");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .sort()
    .map((f) => fs.readFileSync(path.join(d, f), "utf8").trim());
}

/** A finding as review.json keeps it (older files have no members). */
export type StoredFinding = {
  id: string;
  lens: string;
  also: string[];
  title: string;
  why?: string;
  blocks: boolean;
  category?: string;
  at?: { file: string; line: number };
  requirement?: string;
  members?: Member[];
};

/** Exported for the CLI (`kitchen dismiss`): every finding of a job's reviews, newest round last. */
export function findingsOf(jobDir: string): { round: number; findings: StoredFinding[] }[] {
  const d = path.join(jobDir, "rounds");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b)
    .flatMap((n) => {
      const f = path.join(d, String(n), "review.json");
      if (!fs.existsSync(f)) return [];
      return [{ round: n, findings: (JSON.parse(fs.readFileSync(f, "utf8")) as { findings: StoredFinding[] }).findings }];
    });
}

/** The finding a dismissal names (a merged one, or a member of one), with its own lens and title and the merged row's anchor. */
export function findingById(jobDir: string, id: string): (StoredFinding & { round: number; blockedRow: boolean }) | null {
  for (const r of findingsOf(jobDir))
    for (const x of r.findings) {
      if (x.id === id) return { ...x, round: r.round, blockedRow: x.blocks };
      const m = x.members?.find((y) => y.id === id) ?? (x.also.includes(id) ? { id, lens: id.split("-")[0], title: x.title, why: "", blocks: false } : null);
      if (m) return { ...x, id: m.id, lens: m.lens, title: m.title, why: m.why, blocks: m.blocks, category: m.category, round: r.round, blockedRow: x.blocks };
    }
  return null;
}

/** A job's dismissals (`kitchen dismiss`, dismissed.jsonl), each with the lens and anchor of the finding it names. */
export function dismissalsOf(jobDir: string): Dismissal[] {
  const f = path.join(jobDir, "dismissed.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const d = JSON.parse(l) as Partial<Dismissal> & { finding: string };
      const k = d.at || d.requirement ? null : findingById(jobDir, d.finding);
      const at = d.at ?? k?.at;
      const requirement = d.requirement ?? k?.requirement;
      const title = d.title ?? k?.title;
      return {
        finding: d.finding,
        lens: d.lens ?? k?.lens ?? d.finding.split("-")[0],
        round: d.round ?? 0,
        by: d.by ?? "a person",
        reason: d.reason ?? null,
        ...(title ? { title } : {}),
        ...(at ? { at } : {}),
        ...(requirement ? { requirement } : {}),
      };
    });
}
