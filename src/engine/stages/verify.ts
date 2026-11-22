// verify (PLAN §2, verify → review/build/verify/paused/toolkit):
// 0. The engine brings the app up fresh (down + up) from the worktree at HEAD,
//    so the builder's leftover state never reaches a proof and the running app
//    matches the tree every Verify stamp records.
// 1. The engine runs every criterion's proof alone, through `kitchen drive`
//    (prove.ts, role engine), each from seed state (`reset`), and decides every
//    mechanical expect. A judged criterion's proof runs too, so there is
//    evidence to judge. Each result is recorded as soon as it is known
//    (rounds/<N>/proofs-m<moves>.json): a restart after kill -9 re-runs only the
//    proofs that had not finished, never one that had.
// 2. Only if every mechanical proof passed and there are judged criteria, the
//    verifier agent judges those, citing stamped evidence per criterion.
// 3. verdict.ts decides: the manifest must verify against job.json, and a
//    citation not stamped for this HEAD, round and criterion (by the engine or
//    the verifier) counts as FAIL.
// INCONCLUSIVE (a step failed while doctor says the app is unwell, or the
// verifier says so) gets one free retry on a fresh instance, then a Toolkit ticket.
import fs from "node:fs";
import path from "node:path";
import { type ArgsDelta, decideVerdict, type ProofRecord, renderVerdict } from "../../checks/verdict.ts";
import { isJudged } from "../../proof/assert.ts";
import { evidenceDir, sealOf } from "../../proof/job.ts";
import { type Entry, verifyManifest } from "../../proof/manifest.ts";
import { prove } from "../../proof/prove.ts";
import { contractOf, nothingPolicy } from "../contract.ts";
import { doctorOk, freshUp, resetUp } from "../instance.ts";
import { once, roundDir, writeAtomic } from "../store.ts";
import { commitWith, headOf } from "../worktree.ts";
import { nonDiscriminating } from "./base-check.ts";
import { contractBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { headers, named, runRole } from "./role.ts";
import { hasToolkit, primitives } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

export { citationProblem, citationsOf } from "../../checks/verdict.ts";

type Progress = { head: string; round: number; moves: number; proofs: ProofRecord[] };
const progressFile = (jobDir: string, round: number, moves: number) => path.join(roundDir(jobDir, round), `proofs-m${moves}.json`);

function readProgress(f: string, head: string, round: number, moves: number, n: number): ProofRecord[] {
  try {
    const p = JSON.parse(fs.readFileSync(f, "utf8")) as Progress;
    if (p.head !== head || p.round !== round || p.moves !== moves) return [];
    // A record whose evidence is past the signed head (cut by repairManifest) is not trusted.
    return p.proofs.filter((r) => r.evidence.every((id) => Number(id.slice(1)) <= n));
  } catch {
    return [];
  }
}

export function argsDeltasOf(jobDir: string, round: number): ArgsDelta[] {
  const f = path.join(roundDir(jobDir, round), "args-deltas.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ArgsDelta];
      } catch {
        return [];
      }
    });
}

export const verify: StageHandler = async (ctx) => {
  let job = ctx.refresh();
  const contract = contractOf(ctx.jobDir);
  if (!contract) return { to: "verify", facts: { why: "no criteria (spec.md or intake.md) to verify" } };
  // Leftovers from an earlier role run never count: verify proves the committed HEAD.
  const stray = await commitWith(job, "unused", nothingPolicy);
  if (stray.refused.length) ctx.log(`uncommitted changes thrown away before Verify: ${stray.refused.map((x) => x.split(":")[0]).join(", ")}`);
  const head = await headOf(job);
  const moves = job.moves;
  const pf = progressFile(ctx.jobDir, job.round, moves);
  const proofs = readProgress(pf, head, job.round, moves, job.manifestHead.n);
  const save = () => writeAtomic(pf, `${JSON.stringify({ head, round: job.round, moves, proofs } satisfies Progress, null, 2)}\n`);
  const todo = contract.criteria.filter((c) => !proofs.some((p) => p.criterion === c.id));
  if (proofs.length) ctx.log(`proofs already decided before a restart, not run again: ${proofs.map((p) => `${p.criterion} ${p.result}`).join(", ")}`);

  // Step 0 + 1: fresh instance, then every proof, engine only.
  if (todo.length) {
    if (hasToolkit(job)) await freshUp(job, ctx.jobDir, ctx.log);
    for (const c of todo) {
      if (hasToolkit(job)) await resetUp(job, ctx.jobDir);
      const p = await prove({ jobDir: ctx.jobDir, criterion: c, role: "engine", testCmd: ctx.config.test_cmd, log: (m) => ctx.log(`[drive] ${m}`) });
      let result: ProofRecord["result"];
      if (p.status === "pass") result = "PASS";
      else if (p.status === "gap") result = "TOOLKIT-GAP";
      else if (p.status === "step-failed") result = hasToolkit(job) && !(await doctorOk(job, ctx.jobDir)) ? "INCONCLUSIVE" : "FAIL";
      else result = "FAIL";
      proofs.push({ criterion: c.id, result, ...(p.why ? { why: p.why } : {}), ...(p.gap ? { gap: p.gap } : {}), evidence: p.evidence });
      save();
      ctx.log(`${c.id} ${isJudged(c.expect) ? "(judged: evidence) " : ""}${result}${p.why ? `: ${p.why}` : ""}`);
      job = ctx.refresh();
    }
  }

  // Step 2: the verifier judges the judged criteria, only once every mechanical proof passed.
  const judged = contract.criteria.filter((c) => isJudged(c.expect));
  const mechanicalPass = proofs.every((p) => p.result === "PASS");
  let judgedText: string | null = null;
  if (judged.length && mechanicalPass) {
    const r = await runRole(ctx, {
      role: "verifier",
      file: "verify.md",
      tier: "write",
      prompt: prompt({
        role: "verifier",
        mode: "verify",
        job,
        jobDir: ctx.jobDir,
        blocks: [
          contractBlock(ctx.jobDir),
          {
            title: "Judge these, from this evidence",
            body: evidenceBlock(
              ctx.jobDir,
              job.worktree,
              judged.map((c) => c.id),
              proofs,
            ),
          },
        ],
      }),
      dest: path.join(roundDir(ctx.jobDir, job.round), `verify-m${moves}.md`),
    });
    judgedText = r.text;
    fs.rmSync(path.join(job.worktree, ".kitchen-out", "evidence"), { recursive: true, force: true });
    job = ctx.refresh();
    const left = await commitWith(job, "unused", nothingPolicy);
    if (left.refused.length) ctx.log(`the verifier's worktree edits were thrown away: ${left.refused.map((x) => x.split(":")[0]).join(", ")}`);
  }

  // Step 3: the engine's verdict.
  let entries: Entry[] | null = null;
  try {
    entries = verifyManifest(evidenceDir(ctx.jobDir), job.manifestHead, sealOf(job));
  } catch (e) {
    ctx.log(`manifest refused: ${(e as Error).message}`);
  }
  const prims = judgedText && hasToolkit(job) ? (await primitives(job)).list : [];
  const v = decideVerdict({
    criteria: contract.criteria,
    proofs,
    judgedText,
    entries,
    head,
    round: job.round,
    argsDeltas: argsDeltasOf(ctx.jobDir, job.round),
    primitives: prims,
    nonDiscriminating: job.kind === "bug" ? [] : nonDiscriminating(ctx.jobDir, contract.criteria),
  });
  writeAtomic(path.join(roundDir(ctx.jobDir, job.round), `verdict-m${moves}.md`), renderVerdict(v, head, job.round));
  ctx.log(
    `verdict ${v.verdict}: ${v.criteria.map((c) => `${c.id} ${c.result}`).join(", ")}${v.citationProblem ? ` (${v.citationProblem})` : ""}${v.nonDiscriminating.length ? `; non-discriminating (passed on the base too): ${v.nonDiscriminating.join(", ")}` : ""}`,
  );
  const agentGap = judgedText ? named(headers(judgedText).GAP, prims) : undefined;
  const facts = {
    verify: {
      verdict: v.verdict,
      mechanicalFirst: true,
      citationsOk: v.citationsOk,
      citationProblem: v.citationProblem,
      manifestOk: v.manifestOk,
      doctorOk: hasToolkit(job) ? await doctorOk(job, ctx.jobDir) : false,
      gapPrimitive: v.gap ?? agentGap,
      ticket: undefined as string | undefined,
    },
  };
  if (v.verdict === "PASS") return { to: "review", facts };
  if (v.verdict === "FAIL") return { to: "build", facts };
  if (v.verdict === "TOOLKIT-GAP") return { to: "toolkit", facts };
  // INCONCLUSIVE
  if (job.attempts.inconclusive === 0) return { to: "verify", facts, note: "INCONCLUSIVE: free retry on a fresh instance" };
  if (job.attempts.toolkitTicket > 0) return { to: "needs-human", facts };
  const n = job.attempts.toolkitTicket + 1;
  const t = await once(ctx.repo, job.id, `toolkit-ticket/${n}`, () =>
    ctx.forge.fileTicket({
      key: `${job.id}/toolkit-ticket/${n}`,
      title: `Toolkit: INCONCLUSIVE twice on ${job.id}`,
      body: `Verify came back INCONCLUSIVE twice for ${job.id} (${job.title}) in round ${job.round}.\n\n${renderVerdict(v, head, job.round)}`,
    }),
  );
  facts.verify.ticket = t.value;
  return { to: "paused", facts };
};

/**
 * For each judged criterion: the engine's evidence ids and their files. The files are
 * copied into the worktree's outbox (never committed), because a write-tier agent's
 * file tools may only open files under its working directory (Claude's Read tool
 * refuses the job folder). A copy proves nothing by itself: the Verdict checks the
 * cited ids against the signed manifest, not these files.
 */
function evidenceBlock(jobDir: string, worktree: string, ids: string[], proofs: ProofRecord[]): string {
  const ev = evidenceDir(jobDir);
  const view = path.join(worktree, ".kitchen-out", "evidence");
  fs.rmSync(view, { recursive: true, force: true });
  return ids
    .map((c) => {
      const p = proofs.find((x) => x.criterion === c);
      const lines = (p?.evidence ?? []).map((id) => {
        const d = path.join(ev, id);
        if (!fs.existsSync(d)) return `  - ${id}: (missing)`;
        fs.cpSync(d, path.join(view, id), { recursive: true });
        const files = fs.readdirSync(d).sort();
        return `  - ${id}: ${files.map((f) => path.join(view, id, f)).join(", ")}`;
      });
      return `- ${c} (stamped for ${c}, this HEAD and round):\n${lines.join("\n")}`;
    })
    .join("\n");
}
