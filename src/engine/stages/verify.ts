// verify: step 1 (W3a) the engine runs every mechanical proof alone; step 2 the
// verifier judges the `judged` criteria from stamped evidence, citing it per
// criterion (`EVIDENCE C2: e5 e7`). The engine checks the manifest against
// job.json, that every `judged` criterion of the spec has at least one
// citation, and that every cited id is stamped for this HEAD, this round and
// the criterion it is cited for. INCONCLUSIVE gets one free retry, then a
// Toolkit ticket.
// W1: the verdict is read from verify.md; verdict.ts (W3a) decides it.
import fs from "node:fs";
import path from "node:path";
import { parseCriteria } from "../../checks/spec-lint.ts";
import { evidenceDir, sealOf } from "../../proof/job.ts";
import { type Entry, verifyManifest } from "../../proof/manifest.ts";
import { once, roundDir } from "../store.ts";
import { headOf } from "../worktree.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import { doctorOk } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

const VERDICTS = ["PASS", "FAIL", "INCONCLUSIVE", "TOOLKIT-GAP"] as const;

/** Pure: `EVIDENCE C<n>: e<N> …` lines of verify.md, as criterion → cited ids. */
export function citationsOf(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const m = /^\s*EVIDENCE\s+(C\d+)\s*:\s*(.*)$/.exec(line);
    if (m) out.set(m[1], [...(out.get(m[1]) ?? []), ...(m[2].match(/\be\d+\b/g) ?? [])]);
  }
  return out;
}

/**
 * Pure: why the citations don't hold, or null. Every `judged` criterion needs at
 * least one citation; every cited id must be an entry stamped for `head`,
 * `round` and the criterion it is cited for.
 */
export function citationProblem(
  judged: string[],
  cited: Map<string, string[]>,
  entries: Pick<Entry, "id" | "sha" | "round" | "criterion">[],
  head: string,
  round: number,
): string | null {
  for (const c of judged) if (!cited.get(c)?.length) return `${c} is judged and cites no evidence`;
  for (const [c, ids] of cited) {
    for (const id of ids) {
      const e = entries.find((x) => x.id === id);
      if (!e) return `${c} cites ${id}, which is not in the manifest`;
      if (e.sha !== head) return `${c} cites ${id}, stamped for ${e.sha.slice(0, 8)}, not HEAD ${head.slice(0, 8)}`;
      if (e.round !== round) return `${c} cites ${id}, stamped in round ${e.round}, not ${round}`;
      if (e.criterion !== c) return `${c} cites ${id}, stamped for ${e.criterion}`;
    }
  }
  return null;
}

/** The job's criteria: spec.md, or intake.md's inline criteria on the low-risk path. */
function judgedCriteria(jobDir: string): string[] {
  for (const f of ["spec.md", "intake.md"]) {
    const p = path.join(jobDir, f);
    if (fs.existsSync(p)) {
      const cs = parseCriteria(fs.readFileSync(p, "utf8"));
      if (cs.length) return cs.filter((c) => c.expect === "judged").map((c) => c.id);
    }
  }
  return [];
}

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
  const problem = citationProblem(judgedCriteria(ctx.jobDir), citationsOf(r.text), entries, head, job.round);
  const gapPrimitive = h.GAP || undefined;
  const facts = {
    verify: {
      verdict: verdict ?? ("FAIL" as const),
      mechanicalFirst: true,
      citationsOk: !problem,
      citationProblem: problem ?? undefined,
      manifestOk,
      doctorOk: await doctorOk(job, ctx.jobDir),
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
  if (job.attempts.inconclusive === 0) return { to: "verify", facts, note: "INCONCLUSIVE: free retry on a fresh instance" };
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
