// review: one read-tier reviewer per lens, run in parallel (up to `concurrency`).
// Lenses come from the risk path (the stricter of intake's rating and the diff
// floor) plus the job's surfaces; `code-if-diff>N` adds the code lens when the
// diff is over N lines or touches a feature drive. A `human: always` path labels
// the PR `kitchen:review-required`.
//
// Every lens sees the same packet: the ticket's requirements, the contract,
// Verify's verdict (with NON-DISCRIMINATING flags), verify.md, seed-diff.md and
// the diff. The UX and UI lenses also get Verify's stamped screenshots and may
// ask for more views (`VIEW:` lines): the engine runs them (views.ts) and runs the
// lens once more with the new evidence.
//
// The engine decides what blocks (checks/findings.ts): a finding blocks only when
// it is demonstrable (a line at HEAD, a requirement in scope, evidence in the
// manifest) and not low confidence; the rest are notes. Findings about the same
// line or requirement are merged across lenses. Per-lens counts go to the ledger.
import fs from "node:fs";
import path from "node:path";
import { type Anchors, dedupe, judge, type LensStats, lensStats, parseFindings, renderReview, verdictOf, viewsOf } from "../../checks/findings.ts";
import { seedTouched } from "../../checks/risk-floor.ts";
import { parseRequirements } from "../../checks/spec-lint.ts";
import type { Config } from "../../config.ts";
import { appendLedger } from "../../ledger/append.ts";
import { evidenceDir, sealOf } from "../../proof/job.ts";
import { type Entry, verifyManifest } from "../../proof/manifest.ts";
import { mutedFinding } from "../../retro/state.ts";
import { contractOf } from "../contract.ts";
import { effectiveRisk, type Job } from "../machine.ts";
import { once, roundDir, writeAtomic } from "../store.ts";
import { MAX_VIEWS, runView, type ViewResult } from "../views.ts";
import { commitLog, diffPatch, diffStat, fileAtHead, headOf } from "../worktree.ts";
import { nonDiscriminating } from "./base-check.ts";
import { contractBlock, fileBlock, toolkitBlock } from "./context.ts";
import { type PromptBlock, prompt } from "./prompts.ts";
import { runRole } from "./role.ts";
import { hasToolkit } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

export const REVIEW_REQUIRED = "kitchen:review-required";
/** Lenses that look at the running app's screenshots and may ask for views. */
const VISUAL = new Set(["ux", "ui"]);
const INLINE_DIFF = 40_000;
const MAX_SHOTS = 16;

/** Pure. */
export function lensesFor(cfg: Config, job: Pick<Job, "risk" | "riskFloor" | "surfaces">, diff: { file: string; lines: number }[]): string[] {
  const out = new Set<string>();
  const lines = diff.reduce((n, d) => n + d.lines, 0);
  const touchesDrive = diff.some((d) => d.file.startsWith(".kitchen/toolkit/features/"));
  for (const l of cfg.paths[effectiveRisk(job)].review) {
    const m = /^code-if-diff>(\d+)$/.exec(l);
    if (!m) out.add(l);
    else if (lines > Number(m[1]) || touchesDrive) out.add("code");
  }
  for (const s of job.surfaces) for (const l of cfg.surfaces[s] ?? []) out.add(l);
  return [...out];
}

/** Run `fn` over `items`, at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
    }),
  );
}

/** Screenshots the engine or the verifier stamped for this HEAD (Verify's evidence), newest last. Pure. */
export function screenshotsOf(entries: Entry[], head: string): { id: string; criterion: string; file: string }[] {
  const all = entries
    .filter((e) => e.sha === head && ["engine", "verifier"].includes(String(e.role)) && e.phase !== "base")
    .flatMap((e) => e.files.filter((f) => f.path.endsWith(".png")).map((f) => ({ id: e.id, criterion: e.criterion, file: f.path })));
  // A criterion's own screenshots when there are any; the drives stage's check runs only otherwise.
  const proofs = all.filter((s) => /^C\d+$/.test(s.criterion));
  return (proofs.length ? proofs : all).slice(-MAX_SHOTS);
}

/** The newest verdict file of a round (verdict-m<N>.md, highest N), or null. */
export function lastVerdictFile(jobDir: string, round: number): string | null {
  const dir = roundDir(jobDir, round);
  if (!fs.existsSync(dir)) return null;
  const v = fs
    .readdirSync(dir)
    .filter((f) => /^verdict-m\d+\.md$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .at(-1);
  return v ? path.join(dir, v) : null;
}

function newest(jobDir: string, round: number, re: RegExp): string | null {
  const dir = roundDir(jobDir, round);
  if (!fs.existsSync(dir)) return null;
  const f = fs
    .readdirSync(dir)
    .filter((x) => re.test(x))
    .sort()
    .at(-1);
  return f ? path.join(dir, f) : null;
}

/** Copy evidence entries' files into the packet, where a read-tier agent can open them; returns file → packet path. */
function copyEvidence(jobDir: string, packet: string, shots: { id: string; file: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of shots) {
    const from = path.join(evidenceDir(jobDir), s.file);
    if (!fs.existsSync(from)) continue;
    const to = path.join(packet, "evidence", s.file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    out.set(s.file, to);
  }
  return out;
}

export const review: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const head = await headOf(job);
  const diff = await diffStat(job);
  const lenses = lensesFor(ctx.config, job, diff);
  const riskPath = ctx.config.paths[effectiveRisk(job)];
  if (riskPath.human === "always") {
    const l = await once(ctx.repo, job.id, "label/review-required", () =>
      ctx.forge.label({ key: `${job.id}/label/review-required`, pr: job.pr, label: REVIEW_REQUIRED }),
    );
    if (l.did) ctx.log(`${effectiveRisk(job)} risk (human: always): PR labelled ${REVIEW_REQUIRED}`);
  }
  const seeds = seedTouched(diff, ctx.config);
  // Criteria that already held on the base (before the change, or with only the new drives): their PASS proves nothing.
  const contract = contractOf(ctx.jobDir);
  const weak = contract && job.kind !== "bug" ? nonDiscriminating(ctx.jobDir, contract.criteria) : [];
  let entries: Entry[] = [];
  try {
    entries = verifyManifest(evidenceDir(ctx.jobDir), job.manifestHead, sealOf(job));
  } catch (e) {
    ctx.log(`manifest refused: no evidence id can anchor a finding (${(e as Error).message})`);
  }
  const round = roundDir(ctx.jobDir, job.round);
  const packet = path.join(job.worktree, ".kitchen-out", "review");
  fs.rmSync(packet, { recursive: true, force: true });
  fs.mkdirSync(packet, { recursive: true });
  try {
    // The packet every lens reads (inside the worktree: read-tier file tools open it there).
    const patch = await diffPatch(job);
    fs.writeFileSync(path.join(packet, "diff.patch"), patch);
    const intakeText = fs.existsSync(path.join(ctx.jobDir, "intake.md")) ? fs.readFileSync(path.join(ctx.jobDir, "intake.md"), "utf8") : "";
    const reqs = parseRequirements(intakeText);
    const verdictFile = lastVerdictFile(ctx.jobDir, job.round);
    const verifyFile = newest(ctx.jobDir, job.round, /^verify-m\d+\.md$/);
    const shots = screenshotsOf(entries, head);
    const shotPaths = copyEvidence(ctx.jobDir, packet, shots);
    const common: PromptBlock[] = [
      {
        title: "The ticket's requirements (intake.md)",
        body: reqs.length
          ? reqs.map((r) => `- ${r.id}${r.negative ? " (negative)" : ""}${r.outOfScope ? " (out of scope)" : ""}: ${r.text}`).join("\n")
          : "none listed",
      },
      contractBlock(ctx.jobDir),
      ...(verdictFile ? [{ title: "Verify's verdict (the engine's, for this HEAD)", body: fs.readFileSync(verdictFile, "utf8") }] : []),
      ...(verifyFile ? [{ title: "verify.md (the verifier's judgement of the judged criteria)", body: fs.readFileSync(verifyFile, "utf8") }] : []),
      ...fileBlock(round, "seed-diff.md", "seed-diff.md (the diff touches seed data or migrations)"),
      {
        title: "The change",
        body: [
          `HEAD: ${head}  Base: ${job.base}`,
          "",
          "Commits:",
          await commitLog(job),
          "",
          "Files (lines added + removed):",
          ...diff.map((d) => `- ${d.file} (${d.lines})`),
          "",
          patch.length <= INLINE_DIFF ? `\`\`\`diff\n${patch}\`\`\`` : `The full diff is ${patch.length} characters: read ${path.join(packet, "diff.patch")}.`,
        ].join("\n"),
      },
    ];
    const visualBlocks = async (): Promise<PromptBlock[]> => [
      {
        title: "Screenshots Verify took (stamped for this HEAD; open them)",
        body: shots.length
          ? shots.map((s) => `- ${s.id} (criterion ${s.criterion}): ${shotPaths.get(s.file) ?? "(missing)"}`).join("\n")
          : "none: Verify took no screenshot. Ask for the views you need with VIEW: lines.",
      },
      ...(hasToolkit(job) ? [await toolkitBlock(job, job.worktree)] : []),
    ];
    const extra = [
      `Lens worktree (read only): ${job.worktree}`,
      ...(seeds.length ? [`Seed data or migrations changed (check nothing seeds the answer a proof reads): ${seeds.join(", ")}`] : []),
      ...(weak.length
        ? [
            `NON-DISCRIMINATING criteria (they already pass on the base, so their PASS proves nothing about this change; check the code does what they claim): ${weak.join(", ")}`,
          ]
        : []),
    ];
    const runLens = async (lens: string, more: PromptBlock[] = [], file = `review-${lens}.md`) =>
      runRole(ctx, {
        role: `reviewer-${lens}`,
        file,
        tier: "read",
        prompt: prompt({
          role: `reviewer-${lens}`,
          job,
          jobDir: ctx.jobDir,
          blocks: [...common, ...(VISUAL.has(lens) ? await visualBlocks() : []), ...more],
          extra: [`Lens: ${lens}`, `Write: ${file}`, ...extra],
        }),
        dest: path.join(round, file),
      });

    const texts = new Map<string, string>();
    await pool(lenses, ctx.config.concurrency, async (lens) => {
      texts.set(lens, (await runLens(lens)).text);
    });

    // VIEW requests: the engine runs them (one app, one at a time) and re-runs that lens once with the new evidence.
    const rerun: { lens: string; views: ViewResult[] }[] = [];
    for (const lens of lenses.filter((l) => VISUAL.has(l))) {
      const asked = viewsOf(texts.get(lens) ?? "").slice(0, MAX_VIEWS);
      if (!asked.length) continue;
      const rec = path.join(round, `views-${lens}-m${job.moves}.json`);
      let views: ViewResult[];
      if (fs.existsSync(rec)) views = JSON.parse(fs.readFileSync(rec, "utf8")) as ViewResult[];
      else {
        views = [];
        for (const [i, v] of asked.entries()) {
          if (!hasToolkit(job)) {
            views.push({ view: v, ok: false, why: "no Toolkit", evidence: [] });
            continue;
          }
          const r = await runView({
            job: ctx.refresh(),
            jobDir: ctx.jobDir,
            view: v,
            lens,
            n: i + 1,
            testCmd: ctx.config.test_cmd,
            log: (m) => ctx.log(`[view] ${m}`),
          }).catch((e) => ({ view: v, ok: false, why: (e as Error).message, evidence: [] }) as ViewResult);
          ctx.log(`VIEW for ${lens}: ${v} → ${r.ok ? "ok" : `failed: ${r.why}`} (${r.evidence.join(" ") || "no evidence"})`);
          views.push(r);
        }
        writeAtomic(rec, `${JSON.stringify(views, null, 2)}\n`);
      }
      rerun.push({ lens, views });
    }
    if (rerun.length) {
      const fresh = verifyManifest(evidenceDir(ctx.jobDir), ctx.refresh().manifestHead, sealOf(ctx.refresh()));
      entries = fresh;
      await pool(rerun, ctx.config.concurrency, async ({ lens, views }) => {
        const files = fresh.filter((e) => views.some((v) => v.evidence.includes(e.id))).flatMap((e) => e.files.map((f) => ({ id: e.id, file: f.path })));
        const shown = copyEvidence(
          ctx.jobDir,
          packet,
          files.filter((f) => f.file.endsWith(".png")),
        );
        const body = views
          .map(
            (v) =>
              `- VIEW: ${v.view} → ${v.ok ? "ran" : `failed (${v.why})`}${v.evidence.length ? `, evidence ${v.evidence.join(" ")}` : ""}\n${files
                .filter((f) => v.evidence.includes(f.id) && shown.has(f.file))
                .map((f) => `  - ${f.id}: ${shown.get(f.file)}`)
                .join("\n")}`,
          )
          .join("\n");
        const r = await runLens(
          lens,
          [
            {
              title: "The views you asked for (the engine ran them; this is your last pass, so no new VIEW lines)",
              body: `${body}\n\nYour first review, for reference:\n\n${texts.get(lens) ?? ""}`,
            },
          ],
          `review-${lens}-views.md`,
        );
        texts.set(lens, r.text);
      });
    }

    // The engine's call: what blocks, merged across lenses.
    const files = new Map<string, number | null>();
    const all = lenses.flatMap((l) => parseFindings(texts.get(l) ?? "", l, job.round));
    for (const f of all)
      if (f.at && !files.has(f.at.file)) {
        const t = await fileAtHead(job, f.at.file);
        files.set(f.at.file, t === null ? null : t.split("\n").length - (t.endsWith("\n") ? 1 : 0));
      }
    const anchors: Anchors = {
      lines: (f) => files.get(f) ?? null,
      requirements: reqs.filter((r) => !r.outOfScope).map((r) => r.id),
      evidence: entries.map((e) => e.id),
    };
    // A category the retro muted for this lens never blocks (src/retro/retro.ts); it stays a note with the reason.
    const judged = judge(all, anchors).map((f) => {
      const muted = f.blocks ? mutedFinding(ctx.repo, f) : null;
      return muted ? { ...f, blocks: false, downgraded: muted } : f;
    });
    const merged = dedupe(judged);
    const stats: LensStats[] = lenses.map((l) => lensStats(l, verdictOf(texts.get(l) ?? ""), judged, merged));
    writeAtomic(path.join(round, "review.md"), renderReview({ round: job.round, head, lenses, merged, stats }));
    writeAtomic(path.join(round, "review.json"), `${JSON.stringify({ head, round: job.round, lenses, findings: merged, stats }, null, 2)}\n`);
    for (const s of stats)
      appendLedger(ctx.repo, {
        job: job.id,
        stage: "review",
        round: job.round,
        event: "review-lens",
        key: `${job.id}/review/${job.round}/m${job.moves}/${s.lens}`,
        result: s.blocks ? "BLOCKING" : "PASS",
        role: `reviewer-${s.lens}`,
        detail: { ...s },
      });
    for (const f of judged.filter((x) => x.downgraded)) ctx.log(`${f.id} (${f.lens}) kept as a note: ${f.downgraded}`);
    const blocking = merged.filter((f) => f.blocks);
    const summary = blocking
      .map((f) => `${f.id} ${f.lenses.join("+")}: ${f.title}${f.at ? ` (${f.at.file}:${f.at.line})` : f.requirement ? ` (${f.requirement})` : ""}`)
      .join("; ");
    ctx.log(
      `review: ${lenses.length ? lenses.join(", ") : "no lenses on this path"} → ${blocking.length ? `BLOCKING ${summary}` : "PASS"} (${merged.length} finding(s) after merging ${all.length})`,
    );
    const facts = { nonDiscriminating: weak, findings: merged.length, notes: merged.length - blocking.length };
    return blocking.length
      ? { to: "build", facts: { review: { pass: false, blocking: summary, ...facts } } }
      : { to: "ready", facts: { review: { pass: true, ...facts } } };
  } finally {
    fs.rmSync(packet, { recursive: true, force: true });
  }
};

/** Exported for the CLI (`kitchen dismiss`): every finding id of a job's reviews, newest round last. */
export function findingsOf(jobDir: string): { round: number; findings: { id: string; lens: string; also: string[]; title: string; blocks: boolean }[] }[] {
  const d = path.join(jobDir, "rounds");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b)
    .flatMap((n) => {
      const f = path.join(d, String(n), "review.json");
      if (!fs.existsSync(f)) return [];
      return [
        {
          round: n,
          findings: (JSON.parse(fs.readFileSync(f, "utf8")) as { findings: { id: string; lens: string; also: string[]; title: string; blocks: boolean }[] })
            .findings,
        },
      ];
    });
}
