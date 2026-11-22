// The retro (PLAN §7 W5): a stage outside jobs that turns repeated lessons into muted
// review categories and proposed tickets. `kitchen run` starts it every
// `retro.every_jobs` finished jobs; `kitchen retro` starts it by hand.
//
// 1. Dismissals from the forge: a trusted person's "not useful" reply on a PR naming
//    finding ids (Forge.reviewComments) becomes a `finding-dismissed` ledger line, the
//    same line `kitchen dismiss` writes (same key, so never twice).
// 2. Mutes (engine only, signals.ts): written to .kitchen/retro/state.json and the
//    ledger; review reads them (mutedFinding). `kitchen retro unmute <lens>/<category>`.
// 3. Lessons: the engine picks the signals not proposed before (at most
//    `retro.max_tickets`); the `retro` role (read tier, cheap model) writes each one's
//    ticket text, choosing a lint rule over a check over a Toolkit fix, an AGENTS.md note
//    last. The engine files them through the TicketSource as drafts (never labelled,
//    never work until a person approves) and keeps their ids, so a signal is proposed once.
//    The role writes one file; it never edits anything, Kitchen's own prompts included.
// Idempotent: run twice, the second run mutes nothing and files nothing new.
import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter } from "../agents/adapter.ts";
import { buildAgentEnv } from "../agents/env.ts";
import { type Config, loadConfig, modelFor } from "../config.ts";
import { findingById, findingsOf } from "../engine/stages/context.ts";
import { ROLES_DIR, roleFile } from "../engine/stages/prompts.ts";
import { jobDirOf, kitchenDir, listJobs, writeAtomic } from "../engine/store.ts";
import { type Forge, isTrusted } from "../forge/forge.ts";
import { kitchenHome } from "../home.ts";
import { appendLedger, readLedger } from "../ledger/append.ts";
import { formatMeasures, measures } from "../ledger/measures.ts";
import { withFileLock } from "../lock.ts";
import type { TicketSource } from "../sources/source.ts";
import { type Category, needsReason } from "./categories.ts";
import {
  dismissalsIn,
  dismissalsOf,
  finishedCount,
  type Lesson,
  muteDecisions,
  parseLessons,
  pickSignals,
  type RetroState,
  type Signal,
  signalsOf,
} from "./signals.ts";
import { readRetroState, retroDir, stateFile } from "./state.ts";

export { mutedFinding, readRetroState, retroDir } from "./state.ts";
export const writeState = (repo: string, s: RetroState) => writeAtomic(stateFile(repo), `${JSON.stringify(s, null, 2)}\n`);

/** Whether the retro is due: `retro.every_jobs` jobs finished since the last one. */
export function retroDue(repo: string, cfg: Config): { due: boolean; finished: number; since: number } {
  const finished = finishedCount(readLedger(repo));
  const since = readRetroState(repo).finished;
  return { due: finished - since >= cfg.retro.every_jobs, finished, since };
}

export type RetroOutcome = { muted: string[]; filed: { signal: string; ref: string; title: string }[]; signals: number; refused: string[]; usd: number };

export async function runRetro(o: {
  repo: string;
  agent: AgentAdapter;
  forge: Forge;
  source: TicketSource;
  print: (l: string) => void;
  now?: () => Date;
}): Promise<RetroOutcome> {
  const repo = o.repo;
  const cfg = loadConfig(repo);
  const now = () => (o.now ?? (() => new Date()))().toISOString();
  const say = (l: string) => o.print(`retro: ${l}`);
  fs.mkdirSync(retroDir(repo), { recursive: true });
  return withFileLock(path.join(retroDir(repo), "lock"), async () => {
    const st = readRetroState(repo);
    const n = st.runs + 1;
    const out: RetroOutcome = { muted: [], filed: [], signals: 0, refused: [], usd: 0 };

    // 1. Dismissals people left on PRs, through the forge: done jobs of the last `lookback_days` only
    //    (one forge read per job per retro; an old PR's replies were read by an earlier retro).
    const cutoff = Date.parse(now()) - cfg.retro.lookback_days * 86_400_000;
    const recent = listJobs(repo).filter((j) => j.pr !== null && j.stage === "done" && Date.parse(j.doneAt ?? j.updatedAt) >= cutoff);
    for (const job of recent) {
      let comments: Awaited<ReturnType<Forge["reviewComments"]>> = [];
      try {
        comments = await o.forge.reviewComments(job.pr);
      } catch (e) {
        say(`${job.id}: PR comments unreadable (${(e as Error).message}); its dismissals wait for the next retro`);
        continue;
      }
      const jobDir = jobDirOf(repo, job.id);
      for (const c of comments.filter((x) => isTrusted(x, cfg.feedback)))
        for (const d of dismissalsIn(c.body).dismissed) {
          const f = findingById(jobDir, d.id);
          if (!f) continue;
          // A security finding is dismissed only with a reason a person wrote (recorded with it).
          if (needsReason(f) && !d.reason) {
            say(`${job.id}: ${d.id} (${f.lens}) not dismissed: a security finding needs a reason ("not useful because …") in ${c.author}'s comment`);
            continue;
          }
          recordDismissal(repo, job.id, {
            finding: d.id,
            lens: f.lens,
            round: f.round,
            blocked: f.blocks,
            title: f.title,
            why: f.why,
            category: f.category,
            reason: d.reason ? `${d.reason} (PR comment by ${c.author})` : `PR comment by ${c.author}`,
            source: "forge",
          });
        }
    }

    // 2. Mutes.
    const lines = readLedger(repo);
    const dismissed = dismissalsOf(lines);
    const mutes = muteDecisions(dismissed, st, { muteAfter: cfg.retro.mute_after, neverMute: cfg.retro.never_mute, now: now() });
    for (const m of mutes) {
      st.mutes.push(m);
      out.muted.push(`${m.lens}/${m.category}`);
      appendLedger(repo, {
        job: "-",
        stage: "retro",
        round: 0,
        event: "retro-mute",
        key: `retro/mute/${m.lens}/${m.category}/${m.dismissals}`,
        result: "muted",
        detail: { ...m },
      });
      say(
        `muted ${m.lens}/${m.category}: ${m.dismissals} findings dismissed (${m.findings.join(", ")}); kitchen retro unmute ${m.lens}/${m.category} lifts it`,
      );
    }

    // 3. Lessons.
    const m = measures(lines);
    // Every job folder's reviews (a job whose job.json is unreadable still taught something).
    const jobsRoot = path.join(kitchenDir(repo), "jobs");
    const ids = fs.existsSync(jobsRoot) ? fs.readdirSync(jobsRoot).filter((x) => /^\d{3,}-/.test(x)) : [];
    const blocked = ids.flatMap((id) =>
      findingsOf(jobDirOf(repo, id)).flatMap((r) =>
        r.findings.filter((f) => f.blocks).map((f) => ({ job: id, lens: f.lens, id: f.id, title: f.title, why: f.why, category: f.category })),
      ),
    );
    // Toolkit gaps: the primitive a Verify proof named (proof lines) or the job's last gap (spec, repro, drives).
    const gaps = [
      ...lines.filter((l) => l.event === "proof" && l.detail?.gap).map((l) => ({ job: l.job, primitive: String(l.detail?.gap) })),
      ...listJobs(repo)
        .filter((j) => j.gap)
        .map((j) => ({ job: j.id, primitive: String(j.gap) })),
    ];
    const signals = signalsOf({ m, blocked, dismissed, gaps, mutes: st.mutes });
    // At most max_tickets lessons per retro cycle: a cycle is the jobs finished since the last one, so the same
    // ledger never yields new tickets twice (the signals left over wait for the next cycle).
    const fresh = st.runs === 0 || finishedCount(lines) > st.finished;
    const picked = fresh ? pickSignals(signals, st, cfg.retro.max_tickets) : [];
    out.signals = signals.length;
    say(
      fresh
        ? `${signals.length} signal(s), ${picked.length} picked (at most ${cfg.retro.max_tickets}, none proposed before)${picked.length ? `: ${picked.map((s) => s.id).join(", ")}` : ""}`
        : `${signals.length} signal(s); no job finished since the last retro, so no new lessons`,
    );
    if (picked.length) {
      const { lessons, refused, usd } = await writeLessons({
        repo,
        cfg,
        agent: o.agent,
        n,
        signals: picked,
        summary: formatMeasures(m, { drivesShown: 8 }),
        say,
      });
      out.refused = refused;
      out.usd = usd;
      for (const l of lessons) {
        const s = picked.find((x) => x.id === l.signal) as Signal;
        const ref = await o.source.draft({ key: `retro/${l.signal}`, title: l.title, body: draftBody(l, s, o.source.kind) });
        st.filed.push({ signal: l.signal, ref, title: l.title, kind: l.kind, at: now() });
        out.filed.push({ signal: l.signal, ref, title: l.title });
        appendLedger(repo, {
          job: "-",
          stage: "retro",
          round: 0,
          event: "retro-ticket",
          key: `retro/ticket/${l.signal}`,
          result: l.kind,
          detail: { signal: l.signal, ref, title: l.title },
        });
        say(`filed ${ref} (${l.kind}, draft for a person to approve): ${l.title}`);
      }
      for (const r of refused) say(`refused: ${r}`);
    }

    st.finished = finishedCount(readLedger(repo));
    st.runs = n;
    writeState(repo, st);
    appendLedger(repo, {
      job: "-",
      stage: "retro",
      round: 0,
      event: "retro",
      key: `retro/run/${n}`,
      usd: out.usd,
      detail: { finished: st.finished, muted: out.muted, filed: out.filed.map((f) => f.ref), signals: out.signals, refused: out.refused.length },
    });
    say(`done: ${out.muted.length} muted, ${out.filed.length} lesson draft(s) filed${out.usd ? `, $${out.usd.toFixed(3)}` : ""}`);
    return out;
  });
}

/** A dismissal into the job's dismissed.jsonl and the ledger (the key `kitchen dismiss` uses, so once). */
export function recordDismissal(
  repo: string,
  job: string,
  d: {
    finding: string;
    lens: string;
    round: number;
    blocked: boolean;
    title: string;
    why?: string;
    category?: string;
    reason: string | null;
    source: string;
  },
): boolean {
  const file = path.join(jobDirOf(repo, job), "dismissed.jsonl");
  const had =
    fs.existsSync(file) &&
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .some((l) => l && (JSON.parse(l) as { finding: string }).finding === d.finding);
  if (had) return false;
  fs.appendFileSync(
    file,
    // `when`, not `at`: `at` is a finding's anchor in dismissed.jsonl (context.ts dismissalsOf).
    `${JSON.stringify({ finding: d.finding, lens: d.lens, round: d.round, blocked: d.blocked, reason: d.reason, title: d.title, source: d.source, when: new Date().toISOString() })}\n`,
  );
  appendLedger(repo, {
    job,
    stage: "done",
    round: d.round,
    event: "finding-dismissed",
    key: `${job}/dismiss/${d.finding}`,
    role: `reviewer-${d.lens}`,
    detail: {
      finding: d.finding,
      lens: d.lens,
      blocked: d.blocked,
      reason: d.reason,
      title: d.title,
      ...(d.why ? { why: d.why } : {}),
      ...(d.category ? { category: d.category } : {}),
      source: d.source,
    },
  });
  return true;
}

async function writeLessons(o: {
  repo: string;
  cfg: Config;
  agent: AgentAdapter;
  n: number;
  signals: Signal[];
  summary: string[];
  say: (l: string) => void;
}): Promise<{ lessons: Lesson[]; refused: string[]; usd: number }> {
  const role = roleFile("retro", o.repo) ?? fs.readFileSync(path.join(ROLES_DIR, "retro.md"), "utf8");
  const outDir = path.join(retroDir(o.repo), "out", String(o.n));
  fs.rmSync(outDir, { recursive: true, force: true });
  const model = modelFor(o.cfg, "retro");
  const t0 = Date.now();
  o.say(`writing ${o.signals.length} lesson(s): ${o.agent.name} ${model} (read) …`);
  const r = await o.agent.run({
    role: "retro",
    model,
    tier: "read",
    cwd: o.repo,
    outFile: "retro.md",
    outDir,
    timeoutSec: Math.min(o.cfg.agent.timeout_sec, 900),
    maxTurns: Math.min(o.cfg.agent.max_turns, 30),
    env: buildAgentEnv(path.join(kitchenHome(), "agent-scrub")),
    prompt: [
      role,
      "",
      "# This retro",
      `Repository (read only): ${o.repo}`,
      `At most ${o.signals.length} lesson(s), one per signal below. Write: retro.md`,
      "",
      "## Signals (the only ones you may use)",
      ...o.signals.flatMap((s) => [`- signal: ${s.id}`, `  what: ${s.what}`, `  suggested kind: ${s.hint}`, ...s.facts.map((f) => `  fact: ${f}`)]),
      "",
      "## The ledger's measures (context)",
      "```",
      ...o.summary,
      "```",
    ].join("\n"),
  });
  const usd = r.usage?.usd ?? 0;
  appendLedger(o.repo, {
    job: "-",
    stage: "retro",
    round: 0,
    event: "agent",
    key: `retro/run/${o.n}/agent`,
    result: r.ok ? "ok" : r.rateLimited ? "rate-limited" : "error",
    role: "retro",
    agent: o.agent.name,
    model,
    secs: (Date.now() - t0) / 1000,
    usd,
    detail: { line: r.line, error: r.error },
  });
  const text = r.outPath && fs.existsSync(r.outPath) ? fs.readFileSync(r.outPath, "utf8") : null;
  if (r.outPath) fs.rmSync(r.outPath, { force: true });
  if (!text) {
    o.say(`the retro role wrote no retro.md (${r.error ?? r.line}); no lessons this time, the signals stay for the next retro`);
    return { lessons: [], refused: [], usd };
  }
  writeAtomic(path.join(retroDir(o.repo), `retro-${o.n}.md`), text);
  return {
    ...parseLessons(
      text,
      o.signals.map((s) => s.id),
      o.signals.length,
    ),
    usd,
  };
}

/** The draft ticket's text: the role's lesson, then the engine's facts and how to approve it. */
export function draftBody(l: Lesson, s: Signal, source: string): string {
  const approve =
    source === "github"
      ? "add the source label (`kitchen` by default) to this issue"
      : "run `kitchen retro approve <n>` (n is the number in the draft's file name), or delete the draft";
  return [
    l.body,
    "",
    "---",
    `Proposed by \`kitchen retro\` (a ${l.kind.replace("-", " ")}) from the signal \`${s.id}\`: ${s.what}.`,
    ...s.facts.map((f) => `- ${f}`),
    "",
    `This is a draft. Kitchen does not work on it until a person approves it: ${approve}.`,
  ].join("\n");
}

/** `kitchen retro unmute <lens>/<category>`. */
export function unmute(repo: string, what: string): string {
  const [lens, category] = what.split("/") as [string, Category];
  const st = readRetroState(repo);
  const m = st.mutes.find((x) => x.lens === lens && x.category === category);
  if (!m) throw new Error(`${what} is not muted${st.mutes.length ? ` (muted: ${st.mutes.map((x) => `${x.lens}/${x.category}`).join(", ")})` : ""}`);
  st.mutes = st.mutes.filter((x) => x !== m);
  const at = new Date().toISOString();
  st.unmuted.push({ lens, category, at, dismissals: m.dismissals });
  writeState(repo, st);
  appendLedger(repo, {
    job: "-",
    stage: "retro",
    round: 0,
    event: "retro-unmute",
    key: `retro/unmute/${lens}/${category}/${at}`,
    result: "unmuted",
    detail: { lens, category },
  });
  return `unmuted ${lens}/${category}: its findings block again; it is muted again only after ${loadConfig(repo).retro.mute_after} new dismissals`;
}
