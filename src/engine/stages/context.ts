// Context blocks the stages hand their roles (prompts.ts `blocks`): the
// contract, the Toolkit, and why earlier rounds failed. All read from the job
// folder and the Toolkit, never from what an agent said about itself.
import fs from "node:fs";
import path from "node:path";
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

export async function toolkitBlock(job: Job, src: string): Promise<PromptBlock> {
  try {
    return { title: "The Toolkit", body: await toolkitBrief(job, src) };
  } catch (e) {
    return { title: "The Toolkit", body: `describe failed: ${(e as Error).message}` };
  }
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
    for (const d of files.filter((f) => /^drives-\d+\.md$/.test(f))) {
      const t = fs.readFileSync(path.join(dir, d), "utf8");
      if (/DRIVES:\s*UNREACHABLE/.test(t)) out.push(`## Round ${r}: the verifier could not reach the feature\n${t}`);
    }
  }
  return out.length ? [{ title: "Earlier rounds (fix these first)", body: out.join("\n\n") }] : [];
}
