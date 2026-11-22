// A copy of the W3b benchmark ledger, for `kitchen report` (W5 exit).
//   node spikes/w5/ledger-copy.ts <bench out dir>… --to <repo dir>
// The W3b full benchmark ran each ticket × run in its own fixture repo (bench/.work/…/repos/<ticket>-<n>),
// each with its own `.kitchen/ledger.jsonl`. This joins them into one ledger:
// - job ids get the run dir as a prefix (`a-count-1/001-…`), since every repo numbers its first job 001;
//   keys get the same prefix, so nothing de-duplicates across repos;
// - `proof` lines did not exist then (Verify writes them from W5 on). They are backfilled from each job's
//   rounds/<N>/proofs-m<moves>.json (result per criterion, at that HEAD) and the drives its criteria name
//   (spec.md or intake.md), marked `backfilled: true`;
// - the bench result lines (event `bench`) from bench/results/2026-11-22-full-claude-*.json, so
//   `kitchen report --bench` has them.
import fs from "node:fs";
import path from "node:path";
import { contractOf } from "../../src/engine/contract.ts";
import { dedupe, type LedgerLine } from "../../src/ledger/append.ts";
import { drivesOf } from "../../src/ledger/measures.ts";

const args = process.argv.slice(2);
const to = args[args.indexOf("--to") + 1];
const outs = args.filter((a, i) => a !== "--to" && args[i - 1] !== "--to");
if (!to || !outs.length) throw new Error("usage: node spikes/w5/ledger-copy.ts <bench out dir>… --to <repo dir>");
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const lines: LedgerLine[] = [];
let backfilled = 0;
for (const out of outs) {
  const repos = path.join(out, "repos");
  for (const run of fs.readdirSync(repos).sort()) {
    const repo = path.join(repos, run);
    const f = path.join(repo, ".kitchen", "ledger.jsonl");
    if (!fs.existsSync(f)) continue;
    const prefix = `${path.basename(out)}/${run}`;
    for (const l of dedupe(fs.readFileSync(f, "utf8"))) lines.push({ ...l, job: l.job === "-" ? "-" : `${prefix}/${l.job}`, key: `${prefix}/${l.key}` });
    const jobs = path.join(repo, ".kitchen", "jobs");
    for (const id of fs.existsSync(jobs) ? fs.readdirSync(jobs).filter((x) => /^\d{3,}-/.test(x)) : []) {
      const jobDir = path.join(jobs, id);
      const contract = contractOf(jobDir);
      const rounds = path.join(jobDir, "rounds");
      if (!contract || !fs.existsSync(rounds)) continue;
      for (const r of fs.readdirSync(rounds).sort((a, b) => Number(a) - Number(b)))
        for (const pf of fs.readdirSync(path.join(rounds, r)).filter((x) => /^proofs-m\d+\.json$/.test(x))) {
          const p = JSON.parse(fs.readFileSync(path.join(rounds, r, pf), "utf8")) as {
            head: string;
            round: number;
            moves: number;
            proofs: { criterion: string; result: string }[];
          };
          const t = fs.statSync(path.join(rounds, r, pf)).mtime.toISOString();
          for (const x of p.proofs) {
            const c = contract.criteria.find((y) => y.id === x.criterion);
            lines.push({
              t,
              job: `${prefix}/${id}`,
              stage: "verify",
              round: p.round,
              event: "proof",
              key: `${prefix}/${id}/m${p.moves}/proof/${x.criterion}`,
              result: x.result,
              detail: { criterion: x.criterion, drives: drivesOf(c?.proof), head: p.head, backfilled: true },
            });
            backfilled++;
          }
        }
    }
  }
}
for (const res of ["2026-11-22-full-claude-pass1.json", "2026-11-22-full-claude-passes2-3.json"]) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "bench", "results", res), "utf8")) as {
    runId: string;
    tier: string;
    results: Record<string, unknown>[];
  };
  for (const r of j.results)
    lines.push({
      t: "2026-11-22T12:00:00.000Z",
      job: `bench:${r.ticket}`,
      stage: "bench",
      round: Number(r.run),
      event: "bench",
      key: `bench/${j.runId}/${r.ticket}/${r.run}`,
      result: r.correct ? "correct" : "wrong",
      agent: "claude",
      secs: Number(r.secs),
      usd: Number(r.usd),
      detail: { ...r, tier: j.tier, runId: j.runId },
    });
}
lines.sort((a, b) => a.t.localeCompare(b.t));
fs.mkdirSync(path.join(to, ".kitchen"), { recursive: true });
fs.writeFileSync(path.join(to, ".kitchen", "ledger.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
console.log(`${lines.length} ledger lines (${backfilled} proof lines backfilled) → ${path.join(to, ".kitchen", "ledger.jsonl")}`);
