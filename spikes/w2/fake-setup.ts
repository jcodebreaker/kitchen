// Scripted setup role for the free W2 spikes (`agent: { tool: fake, script: … }`).
// survey: one question the repo "can't answer". build: copies fixture A's
// hand-made Toolkit into the setup worktree (a known-good Toolkit, so the flow
// around it is what's tested). intake: rejects, so a job ends without work.
// Every call is logged with its prompt to $W2_FAKE_LOG.
import fs from "node:fs";
import path from "node:path";
import type { FakeScript } from "../../src/agents/fake.ts";

const A = path.resolve(import.meta.dirname, "../../fixtures/a-web");

const script: FakeScript = (req) => {
  if (process.env.W2_FAKE_LOG)
    fs.appendFileSync(
      process.env.W2_FAKE_LOG,
      `${JSON.stringify({ role: req.role, file: req.outFile, resume: req.resumeSession ?? null, prompt: req.prompt })}\n`,
    );
  if (req.role === "setup" && req.outFile === "survey.md")
    return {
      line: "survey done, 1 question",
      file: [
        "# Survey (scripted)",
        "Surface: web. Plan: build.",
        "```json",
        JSON.stringify([{ id: "q1", question: "Which seed user should drives sign in as?", why: "two users in the seed", default: "alice" }]),
        "```",
        "",
      ].join("\n"),
    };
  if (req.role === "setup") {
    fs.rmSync(path.join(req.cwd, ".kitchen", "toolkit"), { recursive: true, force: true });
    fs.cpSync(path.join(A, ".kitchen", "toolkit"), path.join(req.cwd, ".kitchen", "toolkit"), {
      recursive: true,
      filter: (s) => !s.includes("node_modules"),
    });
    fs.copyFileSync(path.join(A, ".env.kitchen"), path.join(req.cwd, ".env.kitchen"));
    // flow.ts's secret-scan case: a live-looking key in .env.kitchen (built here so no file holds the literal)
    if (process.env.W2_FAKE_SECRET) fs.appendFileSync(path.join(req.cwd, ".env.kitchen"), `STRIPE_SECRET_KEY=${"sk_live_"}${"4eC39HqLyjWDarjtT1zdp7dc"}\n`);
    return { line: "Toolkit written", file: "STATUS: READY\nSURFACE: web\nPATH: build\nFEATURES: 3\nCHECK: NOT-RUN\n" };
  }
  if (req.role === "intake") return { line: "rejected", file: "DECISION: REJECT\nREASON: spike\n" };
  return { line: `no script for ${req.role}`, ok: false };
};
export default script;
