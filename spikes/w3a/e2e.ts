// W3a exit, real agents: one ticket end to end (intake → … → verify, stopping
// at review) on a copy of fixture A, with the real Toolkit, Docker and engine.
//   node spikes/w3a/e2e.ts claude|codex feature|bug|visual <scratch>
// feature: "show the signed-in user's display name in the header, editable on /settings"
// bug:     dark mode doesn't persist after a reload (lib.ts BUG is planted in the copy first)
// visual:  (extra) a styling ticket, so the spec has a judged criterion and the verifier judges screenshots
// admin:   the review's ticket: admins see every user's projects with owner, regular users only their own
//          (the spec needs a negative criterion backed by a step that makes another user's project;
//          `wrong.ts` then replays this spec against a builder that leaks every project)
// Claude: sonnet for strong roles, haiku for medium (verifier). Codex: the config's tier map
// (npx @openai/codex@0.171.0). Writes <scratch>/e2e-<tool>-<kind>.json (per-stage models,
// time, cost) and .log, prints PASS/FAIL lines.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseCriteria } from "../../src/checks/spec-lint.ts";
import { isJudged, negativeClauses, parseExpect } from "../../src/proof/assert.ts";
import { parseProof } from "../../src/proof/proof-line.ts";
import {
  CLAUDE_BIN,
  CODEX_CMD,
  check,
  finish,
  HERE,
  jobDir,
  jobOf,
  kitchenContainers,
  ledger,
  makeFixtureRepo,
  manifest,
  ROOT,
  stagesOf,
  stepUntil,
  ticket,
} from "./lib.ts";

const [tool, kind] = process.argv.slice(2);
if ((tool !== "claude" && tool !== "codex") || !["feature", "bug", "visual", "admin"].includes(kind))
  throw new Error("usage: e2e.ts claude|codex feature|bug|visual|admin <scratch>");
const root = path.resolve(process.argv[4] ?? path.join(HERE, ".work"));
fs.mkdirSync(root, { recursive: true });
const name = `e2e-${tool}-${kind}`;

const TICKETS: Record<string, string> = {
  visual:
    'Make the "Fixture A" brand name in the header stand out: larger, bold, in the accent colour, with a small dot before it. It must look right in both light and dark mode.',
  feature:
    "Show the signed-in user's display name in the header, and let them change it on /settings. Someone who never set a display name sees their username there instead.",
  bug: "Dark mode doesn't persist. I switch it on in Settings and it says Saved, but when I reload the page the app is light again.",
  // The W3a reviewer's ticket: the spec must create another user's project before asserting a regular user can't see it.
  admin: "Admins see every user's projects with owner; regular users still see only their own.",
};
const agent =
  tool === "claude"
    ? `{ tool: claude, command: [${JSON.stringify(CLAUDE_BIN)}], models: { strong: sonnet, medium: haiku }, timeout_sec: 1800, max_turns: 80 }`
    : `{ tool: codex, command: ${JSON.stringify(CODEX_CMD)}, timeout_sec: 1800, max_turns: 80 }`;
const yaml = `concurrency: 1
round_limit: 3
agent: ${agent}
checks:
  - { name: syntax, run: "node --check server.js" }
test_cmd: "node --test {file}"
`;

const r = makeFixtureRepo(root, name, { yaml, bug: kind === "bug" });
const id = ticket(r, TICKETS[kind]);
const log = path.join(root, `${name}.log`);
fs.writeFileSync(log, "");
const t0 = Date.now();
stepUntil(r, id, ["review", "needs-human", "needs-info", "rejected", "done", "paused"], { max: 30, log });
const wall = (Date.now() - t0) / 1000;
const j = jobOf(r, id);
const dir = jobDir(r, id);

// Per stage entry: from the move into it to the move out of it; agent runs inside it.
const lines = ledger(r).filter((l) => l.job === id);
const seen = new Set<string>();
const moves = lines.filter((l) => l.event === "move" && !seen.has(l.key) && seen.add(l.key));
const agents = lines.filter((l) => l.event === "agent");
const stages: {
  stage: string;
  round: number;
  to: string;
  secs: number;
  agents: { role: string; model?: string; secs?: number; usd?: number; inTok?: number; outTok?: number; result?: string }[];
}[] = [];
let start = Date.parse(j.startedAt);
for (const m of moves) {
  const end = Date.parse(m.t);
  const inStage = agents.filter((a) => a.stage === m.stage && Date.parse(a.t) >= start - 1000 && Date.parse(a.t) <= end + 1000);
  stages.push({
    stage: m.stage,
    round: m.round,
    to: String(m.result),
    secs: Math.round((end - start) / 100) / 10,
    agents: inStage.map((a) => ({
      role: String(a.role),
      model: a.model,
      secs: a.secs && Math.round(a.secs),
      usd: a.usd,
      inTok: a.detail?.inTok as number | undefined,
      outTok: a.detail?.outTok as number | undefined,
      result: a.result,
    })),
  });
  start = end;
}
const usd = agents.reduce((n, a) => n + (a.usd ?? 0), 0);
const tok = agents.reduce((n, a) => ({ in: n.in + Number(a.detail?.inTok ?? 0), out: n.out + Number(a.detail?.outTok ?? 0) }), { in: 0, out: 0 });
const verdicts = fs.existsSync(path.join(dir, "rounds"))
  ? fs.readdirSync(path.join(dir, "rounds")).flatMap((n) =>
      fs
        .readdirSync(path.join(dir, "rounds", n))
        .filter((f) => f.startsWith("verdict-"))
        .map((f) => path.join(dir, "rounds", n, f)),
    )
  : [];
const lastVerdict = verdicts.length ? fs.readFileSync(verdicts.sort().at(-1) as string, "utf8") : "";
let changed = "";
try {
  changed = execFileSync("git", ["-C", r.dir, "diff", "--stat", j.base, j.branch], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {} // no job branch: the job stopped before any worktree
const result = {
  tool,
  kind,
  job: id,
  stage: j.stage,
  pausedReason: j.pausedReason,
  path: stagesOf(r, id),
  rounds: j.round,
  risk: j.risk,
  riskFloor: j.riskFloor,
  wallSecs: Math.round(wall),
  usd: Math.round(usd * 10000) / 10000,
  tokens: tok,
  stages,
  verdict: lastVerdict,
  diff: changed,
};
fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(result, null, 2));
for (const f of ["intake.md", "spec.md"]) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(root, `${name}.${f}`));
console.log(`    path: ${result.path.join(" → ")}`);
for (const s of stages)
  console.log(
    `    ${s.stage.padEnd(8)} r${s.round} → ${s.to.padEnd(11)} ${String(s.secs).padStart(6)}s  ${s.agents.map((a) => `${a.role} ${a.model} ${a.secs}s${a.usd ? ` $${a.usd.toFixed(3)}` : ""}${a.inTok ? ` ${a.inTok}/${a.outTok} tok` : ""}${a.result !== "ok" ? ` (${a.result})` : ""}`).join("; ")}`,
  );
console.log(`    total ${Math.round(wall)}s, $${usd.toFixed(3)}, ${tok.in} in / ${tok.out} out tokens`);
console.log(lastVerdict.replace(/^/gm, "    | "));

check(`${tool} ${kind}: reached review (intake → … → verify PASS)`, j.stage === "review", `${j.stage}${j.pausedReason ? ` (${j.pausedReason})` : ""}`);
check(
  `${tool} ${kind}: the last verdict is PASS, decided by the engine${/\| verifier \|/.test(lastVerdict) ? " and the verifier" : ""}`,
  /^VERDICT: PASS/m.test(lastVerdict),
);
const v = JSON.parse(
  execFileSync(process.execPath, [path.join(ROOT, "src/proof/cli.ts"), "verify", dir], { env: r.env, encoding: "utf8" })
    .trim()
    .split("\n")
    .pop() ?? "{}",
) as { ok: boolean };
check(`${tool} ${kind}: the manifest verifies against the signed head`, v.ok === true, `${manifest(r, id).length} entries`);
if (kind === "bug") {
  const repro = fs.existsSync(path.join(dir, "repro-1.json"))
    ? (JSON.parse(fs.readFileSync(path.join(dir, "repro-1.json"), "utf8")) as { status: string; why: string })
    : null;
  const any = fs
    .readdirSync(dir)
    .filter((f) => /^repro-\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { status: string; failedAsExpected?: boolean });
  check(
    `${tool} bug: the repro failed as expected on the base (kitchen drive --repro)`,
    any.some((x) => x.failedAsExpected ?? x.status === "assert-fail"),
    repro ? `${repro.status}: ${repro.why}` : "no repro record",
  );
  const reproDrivesProtected =
    (j.reproFiles ?? []).length > 0 ||
    /proof: toolkit [a-z]+\./.test(fs.readFileSync(path.join(dir, fs.existsSync(path.join(dir, "spec.md")) ? "spec.md" : "intake.md"), "utf8"));
  check(
    `${tool} bug: the repro is committed and the builder may not edit it`,
    reproDrivesProtected,
    (j.reproFiles ?? []).join(", ") || "existing Toolkit drive (builder policy refuses .kitchen/toolkit)",
  );
}
if (kind === "visual")
  check(
    `${tool} visual: a judged criterion was judged by the verifier, citing evidence the engine accepted`,
    /\| C\d+ \| verifier \| PASS \| e\d+/.test(lastVerdict),
    lastVerdict.split("\n").find((l) => l.includes("| verifier |")) ?? "no judged criterion in the contract",
  );
if (kind === "admin") {
  // A negative criterion (not visible / not contains / !=) whose proof first makes another user's project.
  const specText = fs.existsSync(path.join(dir, "spec.md")) ? fs.readFileSync(path.join(dir, "spec.md"), "utf8") : "";
  const negatives = parseCriteria(specText).filter((c) => {
    try {
      return !!c.expect && !isJudged(c.expect) && negativeClauses(parseExpect(c.expect)).length > 0;
    } catch {
      return false;
    }
  });
  check(
    `${tool} admin: the spec has a negative criterion`,
    negatives.length > 0,
    negatives.map((c) => `${c.id}: ${c.proof} → ${c.expect}`).join(" | ") || "none",
  );
  const backed = negatives.filter((c) => {
    try {
      const segs = parseProof(c.proof ?? "");
      return segs.length > 1 && segs.slice(0, -1).some((s) => s.kind === "toolkit" && Object.keys(s.args).some((a) => /^(user|as|owner)$/.test(a)));
    } catch {
      return false;
    }
  });
  check(`${tool} admin: …made by an earlier step of its own proof (another user's project first)`, backed.length > 0, backed.map((c) => c.id).join(", "));
  const base = fs.existsSync(path.join(dir, "base-check.json")) ? fs.readFileSync(path.join(dir, "base-check.json"), "utf8") : "";
  console.log(`    base check: ${base.replace(/\s+/g, " ").slice(0, 400)}`);
  for (const c of negatives) {
    const line = lastVerdict.split("\n").find((l) => l.startsWith(`| ${c.id} |`)) ?? "";
    check(`${tool} admin: ${c.id} (negative) PASS by the engine on the right build`, /\| engine \| PASS/.test(line), line);
  }
}
check(`${tool} ${kind}: the branch changes app code`, /server\.js/.test(changed), changed.split("\n").at(-1) ?? "");
check(`${tool} ${kind}: no container of this job left running`, kitchenContainers(j.slotId).length === 0, kitchenContainers(j.slotId).join(" "));
finish(`w3a e2e ${tool} ${kind}`);
