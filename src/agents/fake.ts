// Scripted adapter for engine runs without a model (W1, CI).

import { mkdirSync, writeFileSync } from "node:fs";
import { type AgentAdapter, type AgentRequest, type AgentResult, outDirOf, outPathOf } from "./adapter.ts";

/** What a scripted role does: the file it writes (omit for none) and its one line. */
export type FakeStep = { file?: string; line: string; ok?: boolean; rateLimited?: boolean };
export type FakeScript = (req: AgentRequest, call: number) => FakeStep;

export class FakeAdapter implements AgentAdapter {
  readonly name = "fake" as const;
  readonly calls: AgentRequest[] = [];
  constructor(private script: FakeScript) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const step = this.script(req, this.calls.length);
    let outPath: string | undefined;
    if (step.file !== undefined) {
      mkdirSync(outDirOf(req), { recursive: true });
      outPath = outPathOf(req);
      writeFileSync(outPath, step.file);
    }
    return {
      ok: step.ok ?? true,
      line: step.line,
      sessionId: req.resumeSession ?? `fake-${req.role}-${this.calls.length}`,
      rateLimited: step.rateLimited,
      usage: { usd: 0, inTok: 0, outTok: 0 },
      outPath,
    };
  }
}
