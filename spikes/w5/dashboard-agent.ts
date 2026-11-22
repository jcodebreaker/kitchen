// Scripted agent for the W5 dashboard spike (dashboard.ts). Its own copy, frozen at the W4
// script of 828a05d, so the W4 spike's script can change without breaking this one (it did
// at the W5 merge: W4's round 3 became "VERDICT: BLOCKING" with no finding, and these jobs
// ended review-unparseable). Every role up to review is W3a's honest scripted agent on the
// planted dark-mode bug (spikes/w3a/fake-agent.ts); the review lenses and the report role:
//   reviewer-code  round 1: a demonstrable blocking finding (the theme UPDATE's line), a
//                  "blocking" one with no anchor, a low-confidence one with a line;
//                  later rounds: a "blocking" one past the end of server.js, and a note.
//   reviewer-ux    first pass: a VIEW line; second pass (the engine ran it): a note citing
//                  the view's evidence, on R2.
//   reviewer-ui    a note on R2 citing a Verify screenshot (merged with ux's: same requirement).
//   report         attempt 1 plants {{e99999}} (refused); attempt 2 cites what the engine listed.
//   builder        records whether its prompt carried a PR comment (done → build).
// Calls are counted in $KITCHEN_FAKE_STATE like W3a's.
import fs from "node:fs";
import type { AgentRequest } from "../../src/agents/adapter.ts";
import type { FakeStep } from "../../src/agents/fake.ts";
import w3a from "../w3a/fake-agent.ts";

const stateFile = () => process.env.KITCHEN_FAKE_STATE ?? "";
const load = (): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};
const note = (k: string, v: unknown) => {
  const s = load();
  s[k] = v;
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
};

export default async function script(req: AgentRequest): Promise<FakeStep> {
  const round = Number(/Round: (\d+)/.exec(req.prompt)?.[1] ?? 1);
  const job = /^Job: (\S+)/m.exec(req.prompt)?.[1] ?? "?";
  if (stateFile()) {
    // Every prompt, for reading what a real role would be told.
    const d = `${stateFile()}.prompts`;
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(`${d}/${req.role}-r${round}-${req.outFile}-${Date.now()}.txt`, req.prompt);
  }
  if (req.role === "builder") {
    const fb = /# Feedback from a human\n([\s\S]*?)(\n# |$)/.exec(req.prompt)?.[1];
    if (fb) note(`${job}/builder-feedback-r${round}`, fb.trim());
    const review = /## Round \d+: Review BLOCKING[\s\S]*?(?=\n## |\n# |$)/.exec(req.prompt)?.[0];
    if (review) note(`${job}/builder-review-r${round}`, review);
  }
  if (req.role === "reviewer-code") {
    if (round === 1) {
      const server = fs.readFileSync(`${req.cwd}/server.js`, "utf8").split("\n");
      const line = server.findIndex((l) => l.includes("UPDATE users SET theme")) + 1;
      return {
        file: `VERDICT: BLOCKING

### F1: the theme update doesn't check the value it stores
- kind: blocking
- confidence: high
- at: server.js:${line}
- why: any string reaches the theme column

### F2: this feels fragile
- kind: blocking
- confidence: high
- why: no line, no requirement, no evidence

### F3: maybe a race on double click
- kind: blocking
- confidence: low
- at: server.js:${line}
`,
        line: `VERDICT: BLOCKING F1 server.js:${line}`,
      };
    }
    return {
      file: `VERDICT: BLOCKING

### F1: something past the end
- kind: blocking
- confidence: high
- at: server.js:99999

### F2: the handler could use a comment
- kind: note
- confidence: medium
- at: server.js:1
`,
      line: "VERDICT: BLOCKING (not demonstrable)",
    };
  }
  if (req.role === "reviewer-ux") {
    if (req.outFile === "review-ux.md")
      return { file: "VERDICT: PASS\nVIEW: /settings --as alice\n\nAsked for the settings page as alice.\n", line: "VIEW /settings" };
    const ids = [...(/# The views you asked for[\s\S]*?(?=\n# |$)/.exec(req.prompt)?.[0] ?? "").matchAll(/\b(e\d+): \//g)].map((m) => m[1]);
    note(`${job}/ux-view-ids-r${round}`, ids);
    return {
      file: `VERDICT: PASS\n\n### F1: the dark settings page has low contrast on the save status\n- kind: note\n- confidence: medium\n- requirement: R2\n- evidence: ${ids.join(" ")}\n- why: seen on the view\n`,
      line: "VERDICT: PASS (1 note)",
    };
  }
  if (req.role === "reviewer-ui") {
    const shot = /^- (e\d+) \(criterion C\d+\): \//m.exec(req.prompt)?.[1] ?? "";
    note(`${job}/ui-shot-r${round}`, shot);
    return {
      file: `VERDICT: PASS\n\n### F1: dark settings look fine; the status text is a bit faint\n- kind: note\n- confidence: high\n- requirement: R2\n- evidence: ${shot}\n`,
      line: "VERDICT: PASS (1 note)",
    };
  }
  if (req.role === "report") {
    const listed = [...(/# Evidence you may cite[\s\S]*?(?=\n# |$)/.exec(req.prompt)?.[0] ?? "").matchAll(/^- (e\d+):/gm)].map((m) => m[1]);
    const refused = /# Your last report\.src\.html was refused/.test(req.prompt);
    note(`${job}/report-attempt-${refused ? 2 : 1}`, { listed: listed.length, refused });
    const cite = [listed[0], listed.at(-1)].filter(Boolean).map((id) => `{{${id}}}`);
    return {
      file: `<section id="summary"><p>Dark mode now persists after a reload: the theme update had the wrong column. ${cite.join(" ")}${refused ? "" : " {{e99999}}"}</p></section>
<section id="changes"><h2>What changed</h2><ul><li>server.js: the theme UPDATE matches the user's id.</li></ul><script>alert(1)</script></section>
<section id="notes"><p onclick="steal()">Review notes are listed below.</p></section>`,
      line: `report: cites ${cite.join(" ")}`,
    };
  }
  return w3a(req);
}
