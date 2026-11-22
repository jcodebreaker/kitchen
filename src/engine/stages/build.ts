// build: write tier. The builder edits the worktree (self-checking through the
// bridge); the engine commits what it left, pushes and opens the draft PR.
import fs from "node:fs";
import path from "node:path";
import { once, roundDir } from "../store.ts";
import { commitAll } from "../worktree.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import type { StageHandler } from "./types.ts";

/** Human feedback (`kitchen feedback`) the builder must address, newest last. */
function feedback(jobDir: string): string[] {
  const d = path.join(jobDir, "feedback");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .sort()
    .map((f) => fs.readFileSync(path.join(d, f), "utf8").trim());
}

export const build: StageHandler = async (ctx) => {
  const fb = feedback(ctx.jobDir);
  const r = await runRole(ctx, {
    role: "builder",
    file: "build.md",
    tier: "write",
    prompt: prompt({ role: "builder", job: ctx.job, jobDir: ctx.jobDir, extra: fb.length ? ["Feedback from a human:", ...fb] : [] }),
    dest: path.join(roundDir(ctx.jobDir, ctx.job.round), "build.md"),
  });
  const h = headers(r.text);
  const status = h.STATUS === "READY" ? "READY" : "BLOCKED";
  const job = ctx.refresh();
  const localForge = ctx.forge.kind === "local";
  if (status === "BLOCKED") return { to: "needs-human", facts: { build: { status, committed: false, pushed: false, pr: null, localForge }, why: h.REASON } };
  const c = await commitAll(job, `kitchen(${job.id}): round ${job.round}\n\n${job.title}`);
  let pushed = false;
  let pr: number | null = job.pr;
  if (c.ahead) {
    const pub = await once(ctx.repo, job.id, `publish/${c.head}`, () => ctx.forge.publish({ branch: job.branch, title: job.title, head: c.head }));
    pushed = !!pub.value?.pushed;
    pr = pub.value?.pr ?? pr;
  }
  return { to: "gate", facts: { build: { status, committed: c.ahead && c.clean, pushed, pr, localForge } } };
};
