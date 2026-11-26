#!/usr/bin/env node
// The `--dry` stand-in for `claude` (KITCHEN_CLAUDE_BIN), as the scheduler tests use one: never a model, $0. Kitchen
// starts it once per lane exactly as it starts Claude Code (`-p <prompt> --model … --output-format stream-json`). It
// reads its lane, job, checkout and brief from the prompt, finds the bench ticket behind the job in $BENCH_DRY_MAP
// (job id → { key, intake }, written by bench/run.ts once the tickets are filed) and does that lane's work the right
// way: intake writes the right call, Build commits the reference change (dry/ref.mjs), QA, review and the merge check
// pass with plain evidence. Everything else (moving jobs, running the checks, merging into staging, catch-ups) is
// Kitchen's real code, so a dry run exercises the whole pipeline and the oracles.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REFS } from "./ref.mjs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
// `kitchen init`'s preflight: `claude auth status --json`.
if (argv[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "bench stand-in" }));
  process.exit(0);
}
const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const lane = /Kitchen's ([a-z-]+) agent for job /.exec(prompt)?.[1];
const id = /agent for job (\S+) /.exec(prompt)?.[1];
const cwd = /First run `cd ([^`]+)`/.exec(prompt)?.[1];
const brief = /read your brief, (.+?\.md), and follow/.exec(prompt)?.[1];
const say = (o) => console.log(JSON.stringify(o));
const finish = (text) => {
  say({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, result: text });
  process.exit(0);
};
if (!lane || !id || !cwd || !brief) {
  say({ type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0, result: "stand-in: a prompt it can't read" });
  process.exit(1);
}
say({ type: "assistant", message: { content: [{ type: "text", text: `stand-in ${lane} for ${id}` }] } });

const round = path.dirname(brief);
const jobDir = path.dirname(path.dirname(round));
const map = JSON.parse(fs.readFileSync(process.env.BENCH_DRY_MAP ?? "", "utf8"));
const t = map[id];
if (!t) finish(`stand-in: job ${id} is not a bench ticket; did nothing`);
const git = (...a) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=bench", "-c", "user.email=bench@example.test", "-c", "commit.gpgSign=false", ...a], { encoding: "utf8" });
const ids = (text) => [...new Set([...text.matchAll(/^\s*-\s*(C\d+)\s*\(/gm)].map((m) => m[1]))];
const write = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

switch (lane) {
  case "intake":
    write(path.join(jobDir, "intake.md"), t.intake);
    finish(`INTAKE ${t.intake.split("\n")[0]}`);
    break;
  case "build": {
    // A catch-up leaves staging merged in with conflicts: take staging's side, then make this ticket's change again.
    let merging = false;
    try {
      git("rev-parse", "-q", "--verify", "MERGE_HEAD");
      merging = true;
    } catch {}
    const conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    for (const f of conflicted) git("checkout", "--theirs", "--", f);
    REFS[t.key]?.(cwd);
    git("add", "-A");
    if (merging) git("commit", "--no-edit");
    else if (git("status", "--porcelain").trim()) git("commit", "-m", `${t.key}: the reference change`);
    finish(`BUILD done: ${t.key}${conflicted.length ? ` (resolved ${conflicted.join(", ")})` : ""}`);
    break;
  }
  case "qa": {
    const rows = ids(fs.readFileSync(path.join(jobDir, "intake.md"), "utf8")).map((c) => {
      write(path.join(round, "qa", `${c.toLowerCase()}.txt`), `stand-in: ${c} held\n`);
      return { id: c, result: "PASS", evidence: [`${c.toLowerCase()}.txt`], note: "stand-in" };
    });
    write(path.join(round, "qa", "verdict.json"), JSON.stringify({ verdict: "PASS", criteria: rows, findings: [] }));
    finish(`QA PASS: ${rows.map((r) => r.id).join(", ")}`);
    break;
  }
  case "review":
    write(path.join(round, "review.json"), JSON.stringify({ summary: "stand-in review: no findings", findings: [] }));
    finish("REVIEW PASS");
    break;
  case "regress": {
    const job = JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8"));
    const features = (job.drive?.features ?? []).map((f) => {
      write(path.join(round, "regress", `${f}.txt`), `stand-in: ${f} driven\n`);
      return { id: f, result: "PASS", evidence: [`${f}.txt`], note: "stand-in" };
    });
    write(path.join(round, "regress", "verdict.json"), JSON.stringify({ verdict: "PASS", features }));
    finish(`REGRESS PASS: ${features.map((f) => f.id).join(", ")}`);
    break;
  }
  case "second-look": {
    const v = JSON.parse(fs.readFileSync(path.join(round, "qa", "verdict.json"), "utf8"));
    const findings = (v.findings ?? []).map((_, i) => ({ finding: i + 1, confirmed: true, note: "stand-in" }));
    write(path.join(round, "second-look.json"), JSON.stringify({ findings }));
    finish("SECOND LOOK done");
    break;
  }
  default:
    finish(`stand-in: no work for lane ${lane}`);
}
