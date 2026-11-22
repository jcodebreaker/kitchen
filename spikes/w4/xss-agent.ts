// Agent for `e2e.ts xss`: every role is REAL Claude (sonnet for strong roles, haiku for
// medium, as in the other e2e runs), except that round 1's builder output is tampered with
// after it finishes: every line it added that renders a description through esc(…) renders
// it raw instead. That plants a stored XSS in the lines the change touched, after real
// intake, spec and build, so the review lenses SHOULD block it with an anchor in the diff.
// Round 2's builder is untouched: it gets the blocking finding and must fix it.
// What was planted is recorded in $KITCHEN_FAKE_STATE (`<job>/planted`).
import fs from "node:fs";
import path from "node:path";
import type { AgentRequest } from "../../src/agents/adapter.ts";
import { ClaudeAdapter } from "../../src/agents/claude.ts";
import type { FakeStep } from "../../src/agents/fake.ts";
import { modelFor, parseConfig } from "../../src/config.ts";
import { CLAUDE_BIN } from "../w3a/lib.ts";

const cfg = parseConfig("agent: { tool: claude, models: { strong: sonnet, medium: haiku } }\n");
const claude = new ClaudeAdapter(CLAUDE_BIN);
const ORIGINAL = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../fixtures/a-web/server.js");

function note(k: string, v: unknown) {
  const f = process.env.KITCHEN_FAKE_STATE ?? "";
  if (!f) return;
  const s = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>) : {};
  s[k] = v;
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
}

/** In lines the builder added to server.js, `esc(<…description…>)` → the raw value. Returns the lines changed. */
export function plant(worktree: string): { line: number; before: string; after: string }[] {
  const file = path.join(worktree, "server.js");
  const base = new Set(fs.readFileSync(ORIGINAL, "utf8").split("\n"));
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const out: { line: number; before: string; after: string }[] = [];
  for (const [i, l] of lines.entries()) {
    if (base.has(l)) continue;
    const after = l.replace(/esc\(([^()]*description[^()]*)\)/g, "$1");
    if (after !== l) {
      out.push({ line: i + 1, before: l.trim(), after: after.trim() });
      lines[i] = after;
    }
  }
  fs.writeFileSync(file, lines.join("\n"));
  return out;
}

export default async function script(req: AgentRequest): Promise<FakeStep> {
  const round = Number(/Round: (\d+)/.exec(req.prompt)?.[1] ?? 1);
  const job = /^Job: (\S+)/m.exec(req.prompt)?.[1] ?? "?";
  const r = await claude.run({ ...req, model: modelFor(cfg, req.role) });
  if (req.role === "builder" && round === 1 && r.ok) {
    const p = plant(req.cwd);
    note(`${job}/planted`, p);
  }
  return { line: r.line, ok: r.ok, result: r };
}
