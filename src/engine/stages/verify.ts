// verify: step 1 (W3a) the engine runs every mechanical proof alone; step 2 the
// verifier judges the `judged` criteria from stamped evidence. The engine
// checks the manifest against job.json and that every cited id is stamped for
// this HEAD and round. INCONCLUSIVE gets one free retry, then a Toolkit ticket.
// W1: the verdict is read from verify.md; verdict.ts (W3a) decides it.
import path from "node:path";
import { evidenceDir, sealOf } from "../../proof/job.ts";
import { type Entry, verifyManifest } from "../../proof/manifest.ts";
import { once, roundDir } from "../store.ts";
import { headOf } from "../worktree.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import { doctorOk } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

const VERDICTS = ["PASS", "FAIL", "INCONCLUSIVE", "TOOLKIT-GAP"] as const;

export const verify: StageHandler = async (ctx) => {
  const r = await runRole(ctx, {
    role: "verifier",
    file: "verify.md",
    tier: "write",
    prompt: prompt({ role: "verifier", job: ctx.job, jobDir: ctx.jobDir }),
    dest: path.join(roundDir(ctx.jobDir, ctx.job.round), `verify-${ctx.job.moves}.md`),
  });
  const h = headers(r.text);
  const job = ctx.refresh();
  const verdict = VERDICTS.find((v) => v === h.VERDICT);
  let entries: Entry[] = [];
  let manifestOk = true;
  try {
    entries = verifyManifest(evidenceDir(ctx.jobDir), job.manifestHead, sealOf(job));
  } catch (e) {
    manifestOk = false;
    ctx.log(`manifest refused: ${(e as Error).message}`);
  }
  const head = await headOf(job);
  const cited = (h.EVIDENCE ?? "").match(/\be\d+\b/g) ?? [];
  const citationsOk = cited.every((id) => entries.some((e) => e.id === id && e.round === job.round && e.sha === head));
  const gapPrimitive = h.GAP || undefined;
  const facts = {
    verify: {
      verdict: verdict ?? ("FAIL" as const),
      mechanicalFirst: true,
      citationsOk,
      manifestOk,
      doctorOk: await doctorOk(job),
      gapPrimitive,
      ticket: undefined as string | undefined,
    },
  };
  // No verdict line: no facts, so the move is refused and the verifier runs again.
  if (!verdict) return { to: "review", facts: { why: `verify.md has no VERDICT (${h.VERDICT ?? "missing"})` } };
  if (verdict === "PASS") return { to: "review", facts };
  if (verdict === "FAIL") return { to: "build", facts };
  if (verdict === "TOOLKIT-GAP") return { to: "toolkit", facts };
  // INCONCLUSIVE
  if (job.attempts.inconclusive === 0) return { to: "verify", facts };
  if (job.attempts.toolkitTicket > 0) return { to: "needs-human", facts };
  const n = job.attempts.toolkitTicket + 1;
  const t = await once(ctx.repo, job.id, `toolkit-ticket/${n}`, () =>
    ctx.forge.fileTicket({
      key: `${job.id}/toolkit-ticket/${n}`,
      title: `Toolkit: INCONCLUSIVE twice on ${job.id}`,
      body: `Verify came back INCONCLUSIVE twice for ${job.id} (${job.title}) in round ${job.round}.\n\n${r.text}`,
    }),
  );
  facts.verify.ticket = t.value;
  return { to: "paused", facts };
};
