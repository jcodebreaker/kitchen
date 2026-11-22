// Scripted retro role for spikes/w5/retro.ts: one lesson per signal the engine listed
// (the suggested kind), plus one for a signal it was not given (must be refused).
// Any other role answers with nothing (the retro spike runs no job).
import type { FakeScript } from "../../src/agents/fake.ts";

const script: FakeScript = (req) => {
  if (req.role !== "retro") return { line: `no script for ${req.role}`, ok: false };
  const signals = [...req.prompt.matchAll(/^- signal: (\S+)\n {2}what: (.+)\n {2}suggested kind: (\S+)/gm)].map((m) => ({ id: m[1], what: m[2], kind: m[3] }));
  const blocks = signals.map(
    (s, i) => `### L${i + 1}: Stop ${s.id} from coming back
- signal: ${s.id}
- kind: ${s.kind}

${s.what}. The change: a concrete ${s.kind} in this repository. Check: the next five jobs show no ${s.id}.
`,
  );
  blocks.push(`### L${signals.length + 1}: Rewrite Kitchen's reviewer prompt
- signal: kitchen:prompts
- kind: agents-md

Not a signal this retro was given: the engine must refuse it.
`);
  return { file: blocks.join("\n"), line: `RETRO ${signals.length} lesson(s)` };
};
export default script;
