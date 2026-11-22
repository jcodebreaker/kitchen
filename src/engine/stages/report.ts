// report: the report role (read tier, medium model) writes report.src.html, citing
// evidence only as {{e<N>}}; the engine renders report.html (checks/report-render.ts):
// it refuses an unknown id, one not stamped for the final HEAD, or a human: always
// report that doesn't open with what a human must check; it inlines everything
// into one self-contained page and adds its own sections from the job's files
// (requirements → criteria → verdict → evidence, review findings, seed diff, cost
// and time). Then it publishes, once per HEAD each: the report and the evidence
// (redacted) to the job's folder on the `kitchen-evidence` branch, and a PR
// comment with the per-criterion table and the link (Forge.publishEvidence,
// Forge.comment). Two refused renders send the job to needs-human.
import fs from "node:fs";
import path from "node:path";
import { prComment, type ReportEntry, type ReportFacts, renderReport } from "../../checks/report-render.ts";
import { parseRequirements } from "../../checks/spec-lint.ts";
import { readLedger } from "../../ledger/append.ts";
import { stageCosts } from "../../ledger/report.ts";
import { evidenceDir, sealOf } from "../../proof/job.ts";
import { verifyManifest } from "../../proof/manifest.ts";
import { redact, redactTextFiles } from "../../proof/redact.ts";
import { contractOf } from "../contract.ts";
import { effectiveRisk, type Job } from "../machine.ts";
import { once, roundDir, writeAtomic } from "../store.ts";
import { commitLog, diffPatch, diffStat, headOf } from "../worktree.ts";
import { nonDiscriminating } from "./base-check.ts";
import { prompt } from "./prompts.ts";
import { lastVerdictFile } from "./review.ts";
import { runRole } from "./role.ts";
import type { StageHandler } from "./types.ts";
import { argsDeltasOf } from "./verify.ts";

/** Verdict table rows of verdict.md (`| C1 | engine | PASS | e1 e2 | why |`). Pure. */
export function verdictRows(md: string): { id: string; decidedBy: "engine" | "verifier"; result: string; evidence: string[]; why: string }[] {
  return [...md.matchAll(/^\|\s*(C\d+)\s*\|\s*(engine|verifier)\s*\|\s*([A-Z-]+)\s*\|([^|]*)\|(.*)\|\s*$/gm)].map((m) => ({
    id: m[1],
    decidedBy: m[2] as "engine" | "verifier",
    result: m[3],
    evidence: m[4].match(/\be\d+\b/g) ?? [],
    why: m[5].replace(/\\\|/g, "|").trim(),
  }));
}

/** The patch of only these files (seed data, migrations). Pure. */
export function patchOf(patch: string, files: string[]): string {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((p) => files.some((f) => p.startsWith(`diff --git a/${f} `)))
    .join("");
}

const rounds = (jobDir: string) => {
  const d = path.join(jobDir, "rounds");
  return fs.existsSync(d)
    ? fs
        .readdirSync(d)
        .map(Number)
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b)
    : [];
};

type ReviewJson = {
  findings: {
    id: string;
    lenses: string[];
    blocks: boolean;
    confidence: string;
    at?: { file: string; line: number };
    requirement?: string;
    evidence: string[];
    title: string;
    why: string;
    downgraded?: string;
  }[];
  lenses: string[];
};

/** Everything the engine says in the report, from the job's files and the ledger, never from the agent. */
async function factsOf(repoDir: string, jobDir: string, job: Job, head: string, humanMustCheck: boolean): Promise<ReportFacts> {
  const intake = fs.existsSync(path.join(jobDir, "intake.md")) ? fs.readFileSync(path.join(jobDir, "intake.md"), "utf8") : "";
  const contract = contractOf(jobDir);
  const weak = contract && job.kind !== "bug" ? nonDiscriminating(jobDir, contract.criteria) : [];
  const rs = rounds(jobDir);
  const vRound = [...rs].reverse().find((r) => lastVerdictFile(jobDir, r));
  const vText = vRound !== undefined ? fs.readFileSync(lastVerdictFile(jobDir, vRound) as string, "utf8") : "";
  const rows = verdictRows(vText);
  const rRound = [...rs].reverse().find((r) => fs.existsSync(path.join(roundDir(jobDir, r), "review.json")));
  const rev = rRound !== undefined ? (JSON.parse(fs.readFileSync(path.join(roundDir(jobDir, rRound), "review.json"), "utf8")) as ReviewJson) : null;
  const blockingRounds = rs.filter((r) =>
    /^REVIEW: BLOCKING/m.test(
      fs.existsSync(path.join(roundDir(jobDir, r), "review.md")) ? fs.readFileSync(path.join(roundDir(jobDir, r), "review.md"), "utf8") : "",
    ),
  ).length;
  const dismissed = new Map(
    (fs.existsSync(path.join(jobDir, "dismissed.jsonl")) ? fs.readFileSync(path.join(jobDir, "dismissed.jsonl"), "utf8").split("\n").filter(Boolean) : []).map(
      (l) => {
        const d = JSON.parse(l) as { finding: string; reason?: string };
        return [d.finding, d.reason ?? "dismissed"] as const;
      },
    ),
  );
  const seedRound = [...rs].reverse().find((r) => fs.existsSync(path.join(roundDir(jobDir, r), "seed-diff.md")));
  const seedFiles =
    seedRound !== undefined
      ? (/^SEED-DIFF:\s*(.*)$/m.exec(fs.readFileSync(path.join(roundDir(jobDir, seedRound), "seed-diff.md"), "utf8"))?.[1] ?? "").split(/,\s*/).filter(Boolean)
      : [];
  return {
    job: { id: job.id, title: job.title, kind: job.kind ?? "?", risk: effectiveRisk(job), round: job.round, pr: job.pr, branch: job.branch },
    head,
    verdict: /^VERDICT:\s*(\S+)/m.exec(vText)?.[1] ?? "none",
    humanMustCheck,
    requirements: parseRequirements(intake),
    criteria: (contract?.criteria ?? []).map((c) => {
      const r = rows.find((x) => x.id === c.id);
      return {
        id: c.id,
        text: c.text,
        covers: c.covers,
        decidedBy: r?.decidedBy ?? (c.expect?.trim() === "judged" ? "verifier" : "engine"),
        result: r?.result ?? "not run",
        ...(r?.why ? { why: r.why.replace(/NON-DISCRIMINATING \(held on the base too\);?\s*/, "") || undefined } : {}),
        evidence: r?.evidence ?? [],
        nonDiscriminating: weak.includes(c.id),
      };
    }),
    review: {
      lenses: rev?.lenses ?? [],
      blockingRounds,
      findings: (rev?.findings ?? []).map((x) => ({
        id: x.id,
        lenses: x.lenses,
        blocks: x.blocks,
        confidence: x.confidence,
        where: [x.at ? `${x.at.file}:${x.at.line}` : "", x.requirement ?? "", x.evidence.join(" ")].filter(Boolean).join(" · "),
        title: x.title,
        why: x.why,
        ...(x.downgraded ? { downgraded: x.downgraded } : {}),
        ...(dismissed.has(x.id) ? { dismissed: dismissed.get(x.id) } : {}),
      })),
    },
    seeds: seedFiles.length ? { files: seedFiles, patch: patchOf(await diffPatch(job), seedFiles) } : null,
    costs: stageCosts(readLedger(repoDir), job.id, job.startedAt),
    argsDeltas: argsDeltasOf(jobDir, job.round).map((d) => `${d.criterion} ${d.drive}: ${JSON.stringify(d.spec)} → ${JSON.stringify(d.used)} (${d.by})`),
  };
}

/** The facts as the report role reads them (it writes prose around them; the engine renders the tables). */
function factsText(f: ReportFacts, entries: ReportEntry[], shots: Map<string, string>): string {
  const ev = (id: string) => {
    const e = entries.find((x) => x.id === id);
    return e ? `${id} (${e.cmd}${shots.has(id) ? `, screenshot: ${shots.get(id)}` : ""})` : id;
  };
  return [
    `Verdict: ${f.verdict}. Risk: ${f.job.risk}. Round ${f.job.round}. HEAD ${f.head}.`,
    "",
    "Requirements:",
    ...f.requirements.map((r) => `- ${r.id}${r.negative ? " (negative)" : ""}${r.outOfScope ? " (out of scope)" : ""}: ${r.text}`),
    "",
    "Criteria (the engine's verdict, this HEAD):",
    ...f.criteria.map(
      (c) =>
        `- ${c.id} covers ${c.covers.join(", ") || "-"}: ${c.text} → ${c.result} (decided by ${c.decidedBy})${c.nonDiscriminating ? " NON-DISCRIMINATING: it already held on the base" : ""}${c.why ? `; ${c.why}` : ""}\n  evidence: ${c.evidence.map(ev).join("; ") || "none"}`,
    ),
    "",
    `Review lenses: ${f.review.lenses.join(", ") || "none"}; sent back to build ${f.review.blockingRounds} time(s).`,
    ...f.review.findings.map(
      (x) =>
        `- ${x.id} [${x.blocks ? "BLOCKS" : "note"}, ${x.confidence}, ${x.lenses.join("+")}] ${x.where}: ${x.title}${x.why ? ` — ${x.why}` : ""}${x.downgraded ? ` (kept as a note: ${x.downgraded})` : ""}`,
    ),
    ...(f.seeds ? ["", `Seed data / migrations changed: ${f.seeds.files.join(", ")}`] : []),
  ].join("\n");
}

const refusedBlock = (o: { prev?: string }) => (o.prev ? [{ title: "Your last report.src.html was refused (fix this)", body: o.prev }] : []);

export const report: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const head = await headOf(job);
  const attempt = job.attempts.render + 1;
  const riskPath = ctx.config.paths[effectiveRisk(job)];
  const humanMustCheck = riskPath.human === "always";
  const localForge = ctx.forge.kind === "local";
  const refused = (refusal: string) => {
    writeAtomic(path.join(ctx.jobDir, `report-refused-${attempt}.md`), `${refusal}\n`);
    ctx.log(`render refused (attempt ${attempt}): ${refusal}`);
    const facts = { report: { rendered: false, idsResolved: false, evidencePushed: false, commented: false, localForge, refusal } };
    return { to: attempt < 2 ? ("report" as const) : ("needs-human" as const), facts, note: `render refused: ${refusal}` };
  };
  let entries: ReportEntry[];
  try {
    entries = verifyManifest(evidenceDir(ctx.jobDir), job.manifestHead, sealOf(job)) as unknown as ReportEntry[];
  } catch (e) {
    return refused(`the manifest does not verify: ${(e as Error).message}`);
  }
  const facts = await factsOf(ctx.repo, ctx.jobDir, job, head, humanMustCheck);
  // Only entries stamped for this HEAD may be cited; the screenshots among them are copied where the role can open them.
  const citable = entries.filter((e) => e.sha === head && e.phase !== "base");
  const packet = path.join(job.worktree, ".kitchen-out", "report");
  fs.rmSync(packet, { recursive: true, force: true });
  const shots = new Map<string, string>();
  for (const e of citable)
    for (const f of e.files.filter((x) => x.path.endsWith(".png"))) {
      const to = path.join(packet, "evidence", f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(evidenceDir(ctx.jobDir), f.path), to);
      if (!shots.has(e.id)) shots.set(e.id, to);
    }
  const prev =
    attempt > 1 && fs.existsSync(path.join(ctx.jobDir, `report-refused-${attempt - 1}.md`))
      ? fs.readFileSync(path.join(ctx.jobDir, `report-refused-${attempt - 1}.md`), "utf8")
      : undefined;
  const diff = await diffStat(job);
  let src: string;
  try {
    const r = await runRole(ctx, {
      role: "report",
      file: "report.src.html",
      tier: "read",
      prompt: prompt({
        role: "report",
        job,
        jobDir: ctx.jobDir,
        blocks: [
          { title: "What the engine knows (it renders these as tables itself; you explain them)", body: factsText(facts, citable, shots) },
          {
            title: "Evidence you may cite (stamped for this HEAD), as {{e<N>}}",
            body:
              citable
                .map((e) => `- ${e.id}: ${e.criterion} · ${String(e.role)} · ${e.cmd} · exit ${e.exit}${shots.has(e.id) ? ` · ${shots.get(e.id)}` : ""}`)
                .join("\n") || "none",
          },
          {
            title: "The change",
            body: [`Commits:\n${await commitLog(job)}`, "", "Files (lines added + removed):", ...diff.map((d) => `- ${d.file} (${d.lines})`)].join("\n"),
          },
          ...refusedBlock({ prev }),
        ],
        extra: [
          `Path: ${effectiveRisk(job)} risk${humanMustCheck ? ' (human: always): open with <section id="human-check">, what a human must check before merging' : ""}`,
          `Write: report.src.html`,
        ],
      }),
      dest: path.join(ctx.jobDir, `report.src-${attempt}.html`),
    });
    src = r.text;
  } finally {
    fs.rmSync(packet, { recursive: true, force: true });
  }
  const out = renderReport({
    src,
    facts,
    entries,
    file: (rel) => {
      const p = path.join(evidenceDir(ctx.jobDir), rel);
      return p.startsWith(evidenceDir(ctx.jobDir) + path.sep) && fs.existsSync(p) ? fs.readFileSync(p) : null;
    },
  });
  if ("refusal" in out) return refused(out.refusal);
  const html = redact(out.html);
  writeAtomic(path.join(ctx.jobDir, "report.html"), html);
  writeAtomic(path.join(ctx.jobDir, "report.src.html"), src);
  ctx.log(`report.html rendered: ${out.cited.length} evidence entries inlined (${out.cited.join(" ")})`);

  // Publish, once per HEAD: the folder on the evidence branch, then the PR comment that links it.
  const bundle = path.join(ctx.jobDir, "publish", job.id);
  const pub = await once(ctx.repo, job.id, `evidence-branch/${head}`, async () => {
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.mkdirSync(bundle, { recursive: true });
    fs.copyFileSync(path.join(ctx.jobDir, "report.html"), path.join(bundle, "report.html"));
    fs.cpSync(evidenceDir(ctx.jobDir), path.join(bundle, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "published.json"), `${JSON.stringify({ job: job.id, head, pr: job.pr, at: ctx.now().toISOString() }, null, 2)}\n`);
    redactTextFiles(bundle);
    return ctx.forge.publishEvidence({ key: `${job.id}/evidence/${head}`, job: job.id, bundle, keepDays: ctx.config.evidence_keep_days });
  });
  fs.rmSync(path.join(ctx.jobDir, "publish"), { recursive: true, force: true });
  const url = pub.value?.url ?? "";
  if (pub.did)
    ctx.log(`evidence published: ${url} (${pub.value?.commit.slice(0, 10)})${pub.value?.pruned.length ? `, pruned ${pub.value.pruned.join(", ")}` : ""}`);
  const body = redact(prComment(facts, { url, entries }));
  const c = await once(ctx.repo, job.id, `report-comment/${head}`, async () => {
    await ctx.forge.comment({ key: `${job.id}/report-comment/${head}`, pr: job.pr, body });
    return true;
  });
  if (c.did) ctx.log(`PR comment posted${job.pr !== null ? ` on #${job.pr}` : " (local forge: recorded)"}`);
  return { to: "done", facts: { report: { rendered: true, idsResolved: true, evidencePushed: !!pub.value?.commit, commented: !!c.value, localForge } } };
};
