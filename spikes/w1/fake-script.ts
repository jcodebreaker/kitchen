// The fake agent for W1 spikes: a FakeScript (src/agents/fake.ts) loaded by the
// runner from kitchen.yaml `agent: { tool: fake, script: … }`.
//
// The ticket names a scenario (`scenario: <name>` in its text); the scenario
// lists, per role, what each successive call does. Calls are counted per job
// and role in $KITCHEN_FAKE_STATE (a JSON file), so the count survives a
// kill -9 and a restart. The last step repeats.
import fs from "node:fs";
import path from "node:path";
import type { AgentRequest } from "../../src/agents/adapter.ts";
import type { FakeStep } from "../../src/agents/fake.ts";
import { SCENARIOS, type Step } from "./scenarios.ts";

const stateFile = () => process.env.KITCHEN_FAKE_STATE ?? path.join(process.cwd(), "fake-state.json");

function bump(key: string): number {
  const f = stateFile();
  const s = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, number>) : {};
  s[key] = (s[key] ?? 0) + 1;
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  return s[key];
}

/** The user's repo, from the agent's cwd (a worktree at <repo>/.worktrees/<id>, or the repo itself). */
const repoOf = (cwd: string) => (cwd.includes(`${path.sep}.worktrees${path.sep}`) ? cwd.slice(0, cwd.indexOf(`${path.sep}.worktrees${path.sep}`)) : cwd);

function lastEvidence(repo: string, job: string): string {
  const j = JSON.parse(fs.readFileSync(path.join(repo, ".kitchen", "jobs", job, "job.json"), "utf8")) as { manifestHead: { n: number } };
  return `e${j.manifestHead.n}`;
}

export default async function script(req: AgentRequest): Promise<FakeStep> {
  const job = /^Job: (\S+)$/m.exec(req.prompt)?.[1] ?? "?";
  const round = Number(/Round: (\d+)/.exec(req.prompt)?.[1] ?? 1);
  const scenario = /scenario: ([a-z0-9-]+)/.exec(req.prompt)?.[1] ?? "";
  const roleKey = req.outFile === "drives.md" ? "verifier:drives" : req.role;
  const steps = SCENARIOS[scenario]?.[roleKey];
  if (!steps) return { line: `no scripted step for ${scenario}/${roleKey}`, ok: false };
  const n = bump(`${job}/${roleKey}`);
  const raw: Step = steps[Math.min(n, steps.length) - 1];
  const s = typeof raw === "string" ? { file: raw } : raw;
  const repo = repoOf(req.cwd);
  if (s.hang) {
    fs.writeFileSync(path.join(repo, `hang-${job}-${roleKey.replace(":", "-")}`), String(process.pid));
    await new Promise(() => {}); // until kill -9
  }
  if (s.sleepSec) {
    const ms = s.sleepSec * 1000;
    await new Promise((r) => setTimeout(r, ms));
  }
  if (s.rate) return { ok: false, rateLimited: true, line: "429 rate limit reached" };
  if (s.fail) return { ok: false, line: s.fail };
  if (req.role === "builder" && s.edit !== false) {
    fs.mkdirSync(path.join(req.cwd, "work"), { recursive: true });
    fs.writeFileSync(path.join(req.cwd, "work", `${job}-r${round}-${n}.txt`), `${scenario} ${roleKey} call ${n}\n`);
    const gf = path.join(req.cwd, "GATE_FAIL");
    if (s.gateFail) fs.writeFileSync(gf, "x\n");
    else fs.rmSync(gf, { force: true });
  }
  if (req.role === "repro" && s.file?.includes("FAILED-AS-EXPECTED")) {
    fs.mkdirSync(path.join(req.cwd, "test"), { recursive: true });
    fs.writeFileSync(path.join(req.cwd, "test", `${job}-repro.test.txt`), "regression test\n");
  }
  if (s.writeDrive) {
    fs.mkdirSync(path.join(req.cwd, ".kitchen/toolkit/features"), { recursive: true });
    fs.writeFileSync(path.join(req.cwd, ".kitchen/toolkit/features", `${job}.md`), "```drive\ndrive: x.open\nsteps:\n  - read: { target: body }\n```\n");
  }
  if (s.addPrimitive) fs.appendFileSync(path.join(repo, ".kitchen/toolkit/primitives.txt"), `${s.addPrimitive}\n`);
  const file = s.file?.replaceAll("eLAST", lastEvidence(repo, job));
  return { file, line: `${roleKey}: ${(file ?? "").split("\n")[0]}` };
}
