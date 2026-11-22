// Scripted maintain roles for spikes/w4/maintain.ts part 2 (the churn trigger): every
// source reader finds no drift; the fixer is never needed (the live pass decides).
import type { AgentRequest } from "../../src/agents/adapter.ts";
import type { FakeStep } from "../../src/agents/fake.ts";

export default function script(req: AgentRequest): FakeStep {
  if (req.role === "maintain-source") {
    const feature = /^Your feature file: .*\/([^/]+\.md)$/m.exec(req.prompt)?.[1] ?? "?";
    return { file: `FEATURE: ${feature}\nDRIFT: none\n\n**Summary**: scripted reader, no drift claimed.\n`, line: "DRIFT: none" };
  }
  return { file: "STATUS: BLOCKED\nREASON: the scripted fixer fixes nothing\n", line: "BLOCKED" };
}
