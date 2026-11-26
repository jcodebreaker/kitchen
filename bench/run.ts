// `npm run bench -- [--tickets a,b] [--models cheap|haiku|default] [--dry] [--max-usd n] [--out dir] [--paid]`
// `npm run bench -- --estimate [--models p] [--ledger <ledger.jsonl>]`
//
// Kitchen's benchmark: a fresh copy of fixtures/e-library in a temp dir (never inside this repo), `kitchen init --yes`,
// the model preset, the tickets filed with `kitchen ticket --no-run`, then `kitchen run --max-usd n` until the queue
// drains. Each ticket is then judged by its own oracle (bench/oracles/<key>.mjs) on the merged staging, never by
// Kitchen's QA. Results: bench/results/<date>-<sha>-<preset>[-dry].json and a row in bench/results/SUMMARY.md.
//
// --dry runs the same pipeline with a stand-in agent (bench/dry/agent.mjs as KITCHEN_CLAUDE_BIN): $0, no model. A real
// run spends money: it needs --paid, which only the owner adds, once per run.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BENCH_LANES, estimate, knownCosts, type LaneCost, ledgerCosts, PRESETS, presetModel, renderEstimate } from "./estimate.ts";
import { FIXTURE, TICKETS, type Ticket } from "./tickets.ts";

const BENCH = import.meta.dirname;
const ROOT = path.dirname(BENCH);
const CLI = path.join(ROOT, "src", "cli.ts");
const RESULTS = path.join(BENCH, "results");

type Args = {
  tickets: Ticket[];
  preset: string;
  dry: boolean;
  estimate: boolean;
  paid: boolean;
  maxUsd: number;
  out?: string;
  ledger?: string;
  timeoutMin: number;
  keep: boolean;
};

function parseArgs(argv: string[]): Args {
  const val = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const known = ["--tickets", "--models", "--dry", "--estimate", "--paid", "--max-usd", "--out", "--ledger", "--timeout-min", "--keep"];
  const odd = argv.filter(
    (a, i) =>
      a.startsWith("--") &&
      !known.includes(a) &&
      !(i > 0 && ["--tickets", "--models", "--max-usd", "--out", "--ledger", "--timeout-min"].includes(argv[i - 1])),
  );
  if (odd.length) throw new Error(`unknown ${odd.join(", ")} (it takes ${known.join(", ")})`);
  const keys = val("--tickets")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = keys?.filter((k) => !TICKETS.some((t) => t.key === k)) ?? [];
  if (unknown.length) throw new Error(`no ticket ${unknown.join(", ")}: the tickets are ${TICKETS.map((t) => t.key).join(", ")}`);
  const preset = val("--models") ?? "cheap";
  if (!(preset in PRESETS)) throw new Error(`--models is one of ${Object.keys(PRESETS).join(", ")}`);
  const maxUsd = Number(val("--max-usd") ?? 10);
  if (!(maxUsd > 0)) throw new Error("--max-usd is a positive number of dollars");
  const dry = argv.includes("--dry");
  return {
    tickets: keys ? TICKETS.filter((t) => keys.includes(t.key)) : TICKETS,
    preset,
    dry,
    estimate: argv.includes("--estimate"),
    paid: argv.includes("--paid"),
    maxUsd,
    out: val("--out"),
    ledger: val("--ledger"),
    timeoutMin: Number(val("--timeout-min") ?? (dry ? 10 : 120)),
    keep: argv.includes("--keep"),
  };
}

const log = (l: string) => console.log(l);
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=bench", "-c", "user.email=bench@example.test", "-c", "commit.gpgSign=false", ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Kitchen's commit, `-dirty` when the tree has changes (the results name what was measured). */
function kitchenSha(): string {
  const sha = git(ROOT, "rev-parse", "--short", "HEAD");
  return git(ROOT, "status", "--porcelain", "--", "src", "roles", "skills", "hooks") ? `${sha}-dirty` : sha;
}

/** `kitchen <args>` in the bench repo, its output to `logFile` and returned. Throws on a non-zero exit unless `ok`. */
function kitchen(repo: string, env: NodeJS.ProcessEnv, args: string[], logFile: string, o: { ok?: boolean } = {}): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, "--repo", repo], { cwd: repo, env, encoding: "utf8", timeout: 600_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  fs.appendFileSync(logFile, `$ kitchen ${args.join(" ")}\n${out}\n`);
  if (r.status !== 0 && !o.ok) throw new Error(`kitchen ${args[0]} failed (exit ${r.status}): ${out.trim().split("\n").slice(-3).join(" | ")}`);
  return { code: r.status ?? 1, out };
}

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

/** The fixture app from `src` on a free port and fresh seed data; null with why when it doesn't answer /healthz. */
async function startApp(src: string, dataDir: string, logFile: string): Promise<{ url: string; child: ChildProcess } | { why: string }> {
  const port = await freePort();
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: src,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", out, out],
  });
  fs.closeSync(out);
  const url = `http://127.0.0.1:${port}`;
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    if (child.exitCode !== null) break;
    try {
      await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      return { url, child };
    } catch {}
  }
  child.kill("SIGKILL");
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-2).join(" | ") : "";
  return { why: `the app didn't answer /healthz in 10 s${tail ? `: ${tail}` : ""}` };
}

type OracleResult = { pass: boolean; note: string };

/**
 * Every ticket's oracle against `branch` as it is: the tree extracted once, one app per oracle on fresh seed data.
 * `only`: the tickets to judge. Each oracle's output goes to <run>/oracles/<phase>-<key>.log.
 */
async function runOracles(
  run: string,
  repo: string,
  phase: string,
  tickets: Ticket[],
  env: (t: Ticket) => NodeJS.ProcessEnv,
): Promise<Record<string, OracleResult>> {
  const dir = path.join(run, "oracles");
  const src = path.join(dir, `${phase}-tree`);
  fs.mkdirSync(src, { recursive: true });
  const tar = path.join(dir, `${phase}.tar`);
  git(repo, "archive", "-o", tar, "staging");
  execFileSync("tar", ["-xf", tar, "-C", src]);
  const out: Record<string, OracleResult> = {};
  for (const t of tickets) {
    const logFile = path.join(dir, `${phase}-${t.key}.log`);
    let app: Awaited<ReturnType<typeof startApp>> | null = null;
    const e: NodeJS.ProcessEnv = { ...process.env, ...env(t) };
    if (t.app) {
      app = await startApp(src, fs.mkdtempSync(path.join(dir, `${phase}-${t.key}-data-`)), path.join(dir, `${phase}-${t.key}-app.log`));
      if ("why" in app) {
        fs.writeFileSync(logFile, `${app.why}\n`);
        out[t.key] = { pass: false, note: app.why };
        continue;
      }
      e.BENCH_URL = app.url;
    }
    const r = spawnSync(process.execPath, [path.join(BENCH, "oracles", `${t.key}.mjs`)], { env: e, encoding: "utf8", timeout: 60_000 });
    if (app && "child" in app) app.child.kill("SIGTERM");
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    fs.writeFileSync(logFile, text);
    const problems = text
      .split("\n")
      .filter((l) => l.startsWith("PROBLEM: "))
      .map((l) => l.slice(9));
    out[t.key] = {
      pass: r.status === 0,
      note: r.status === 0 ? "" : (problems.join("; ") || text.trim().split("\n").pop() || `exit ${r.status}`).slice(0, 300),
    };
  }
  return out;
}

type Job = {
  id: string;
  stage: string;
  kind: string | null;
  merged?: { sha: string };
  waits?: { for: string };
  check?: { result?: string; findings?: number };
  agentRuns?: { stage: string; round: number }[];
};
type Ledger = { event?: string; job?: string; key?: string; result?: string; usd?: number; detail?: { catchUp?: boolean } }[];

const NEEDS_YOU = ["needs-info", "needs-human", "ready", "paused"];

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const sha = kitchenSha();
  const est = () =>
    renderEstimate(
      estimate(
        a.preset,
        a.tickets.map((t) => t.kind),
        knownCosts(RESULTS, a.ledger),
      ),
      a.tickets.length,
      a.maxUsd,
    );
  if (a.estimate) {
    log(est());
    return 0;
  }
  if (!a.dry && !a.paid) {
    log(est());
    log("\nA real run spends money on model calls. The owner approves each one: add --paid to start it (or --dry for a $0 run).");
    return 2;
  }

  const t0 = Date.now();
  const base = a.out ? path.resolve(a.out) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const run = fs.realpathSync(fs.mkdtempSync(path.join(base, `kitchen-bench-${a.preset}${a.dry ? "-dry" : ""}-`)));
  if (!path.relative(ROOT, run).startsWith("..")) throw new Error(`the bench repo must be outside Kitchen's own repo (${run})`);
  const repo = path.join(run, "app");
  const logFile = path.join(run, "bench.log");
  log(
    `bench: ${a.dry ? "DRY (stand-in agent, $0)" : `REAL (preset ${a.preset}, --max-usd ${a.maxUsd})`} · Kitchen ${sha} · ${a.tickets.length} tickets · ${run}`,
  );

  // 1. The fixture, its planted bugs, one commit; Kitchen set up and committed; staging on that commit.
  fs.cpSync(path.join(ROOT, "fixtures", FIXTURE), repo, { recursive: true });
  for (const t of a.tickets.filter((x) => x.plant)) {
    const p = t.plant as NonNullable<Ticket["plant"]>;
    const f = path.join(repo, p.file);
    const text = fs.readFileSync(f, "utf8");
    if (!text.includes(p.from)) throw new Error(`${t.key}: the plant's text is not in ${p.file}`);
    fs.writeFileSync(f, text.replace(p.from, p.to));
  }
  git(repo, "init", "-q", "-b", "main");
  if (path.resolve(git(repo, "rev-parse", "--show-toplevel")) !== repo) throw new Error(`${repo} is not its own git repo`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  const env: NodeJS.ProcessEnv = { ...process.env, KITCHEN_HOME: path.join(run, "home") };
  for (const k of ["KITCHEN_ORCHESTRATOR", "KITCHEN_JOB", "KITCHEN_CLAUDE_BIN", "KITCHEN_CODEX_BIN"]) delete env[k];
  const dryMap = path.join(run, "dry-map.json");
  if (a.dry) Object.assign(env, { KITCHEN_CLAUDE_BIN: path.join(BENCH, "dry", "agent.mjs"), BENCH_DRY_MAP: dryMap });
  kitchen(repo, env, ["init", "--yes"], logFile);
  const preset = PRESETS[a.preset];
  if (preset) for (const [lane, model] of Object.entries(preset)) kitchen(repo, env, ["models", "set", lane, model], logFile);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Set up Kitchen");
  git(repo, "branch", "-f", "staging");
  const mainBefore = git(repo, "rev-parse", "main");
  log(
    `  set up: kitchen init --yes, models ${a.preset}${
      preset
        ? ` (${Object.entries(preset)
            .map(([l, m]) => `${l} ${m}`)
            .join(", ")})`
        : ""
    }, staging at ${mainBefore.slice(0, 7)}`,
  );

  // 2. Every code oracle must fail before any work, or it proves nothing.
  const codeTickets = a.tickets.filter((t) => t.app);
  const baseline = await runOracles(run, repo, "base", codeTickets, () => ({ BENCH_REPO: repo, BENCH_MAIN_BEFORE: mainBefore }));
  const vacuous = codeTickets.filter((t) => baseline[t.key].pass).map((t) => t.key);
  log(
    `  baseline: ${codeTickets.length - vacuous.length} of ${codeTickets.length} code oracles fail before any work${vacuous.length ? ` (PASS already: ${vacuous.join(", ")}: those oracles prove nothing)` : ""}`,
  );

  // 3. The tickets, filed only.
  const ids: Record<string, string> = {};
  for (const t of a.tickets) {
    const r = kitchen(repo, env, ["ticket", "--no-run", ...(t.check ? ["--check"] : []), t.text], logFile);
    const id = /^(?:ticket|check) (\S+)/m.exec(r.out)?.[1];
    if (!id) throw new Error(`${t.key}: no job id in: ${r.out.trim()}`);
    ids[t.key] = id;
  }
  fs.writeFileSync(dryMap, JSON.stringify(Object.fromEntries(a.tickets.map((t) => [ids[t.key], { key: t.key, intake: t.dryIntake }])), null, 2));
  log(`  filed: ${a.tickets.map((t) => `${t.key} ${ids[t.key].split("-")[0]}`).join(", ")}`);

  // 4. The queue, headless, until it drains (or the timeout stops it).
  const tRun = Date.now();
  const runLog = path.join(run, "run.log");
  const child = spawn(process.execPath, [CLI, "run", "--max-usd", String(a.maxUsd), "--repo", repo], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  const runOut = fs.createWriteStream(runLog);
  for (const s of [child.stdout, child.stderr])
    s.on("data", (d: Buffer) => {
      runOut.write(d);
      for (const l of d.toString().split("\n").filter(Boolean)) log(`  | ${l}`);
    });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log(`  timeout: ${a.timeoutMin} min; stopping the run`);
    kitchen(repo, env, ["run", "--stop"], logFile, { ok: true });
  }, a.timeoutMin * 60_000);
  const runCode = await new Promise<number>((res) => child.on("close", (c) => res(c ?? 1)));
  clearTimeout(timer);
  await new Promise((r) => runOut.end(r));
  const runSecs = Math.round((Date.now() - tRun) / 1000);

  // 5. Judge each ticket by its oracle on the merged staging, and read what Kitchen did from its job files and ledger.
  const jobFile = (key: string) => (ids[key] ? path.join(repo, ".kitchen", "jobs", ids[key], "job.json") : "");
  const oracles = await runOracles(run, repo, "final", a.tickets, (t) => ({ BENCH_REPO: repo, BENCH_MAIN_BEFORE: mainBefore, BENCH_JOB: jobFile(t.key) }));
  const ledgerPath = path.join(repo, ".kitchen", "ledger.jsonl");
  const ledgerText = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8") : "";
  const ledger: Ledger = ledgerText
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  const lanes: LaneCost[] = ledgerCosts(ledgerText);
  const perTicket = a.tickets.map((t) => {
    const j: Job | null = fs.existsSync(jobFile(t.key)) ? JSON.parse(fs.readFileSync(jobFile(t.key), "utf8")) : null;
    const moves = ledger.filter((l) => l.event === "move" && l.job === ids[t.key]);
    const usd = ledger.filter((l) => l.event === "session" && l.job === ids[t.key] && typeof l.usd === "number").reduce((s, l) => s + (l.usd ?? 0), 0);
    return {
      key: t.key,
      kind: t.kind,
      job: ids[t.key],
      expect: t.expect,
      oracle: oracles[t.key].pass ? "PASS" : "FAIL",
      note: oracles[t.key].note,
      baseline: t.app ? (baseline[t.key].pass ? "PASS (vacuous)" : "FAIL") : "n/a",
      stage: j?.stage ?? "missing",
      waits: j?.waits?.for,
      merged: !!j?.merged,
      rounds: moves.filter((m) => m.result === "build" && !m.detail?.catchUp).length,
      catchUps: moves.filter((m) => m.detail?.catchUp).length,
      lanes: [...new Set((j?.agentRuns ?? []).map((r) => r.stage))],
      usd: Number(usd.toFixed(4)),
    };
  });
  const spent = lanes.reduce((s, l) => s + l.usd, 0);
  const date = new Date().toISOString().slice(0, 10);
  const result = {
    date,
    mode: a.dry ? "dry" : "real",
    kitchen: sha,
    preset: a.preset,
    models: Object.fromEntries(BENCH_LANES.map((l) => [l, presetModel(a.preset, l)])),
    fixture: FIXTURE,
    maxUsd: a.maxUsd,
    summary: {
      tickets: a.tickets.length,
      oraclePass: perTicket.filter((p) => p.oracle === "PASS").length,
      merged: perTicket.filter((p) => p.merged).length,
      needsYou: perTicket.filter((p) => NEEDS_YOU.includes(p.stage)).length,
      rounds: perTicket.reduce((s, p) => s + p.rounds, 0),
      catchUps: perTicket.reduce((s, p) => s + p.catchUps, 0),
      wallSecs: Math.round((Date.now() - t0) / 1000),
      runSecs,
      usd: Number(spent.toFixed(4)),
      runExit: runCode,
      timedOut,
      vacuousOracles: vacuous,
    },
    tickets: perTicket,
    lanes,
    run: path.basename(run),
  };

  // 6. The results: one JSON per run, one row per run in SUMMARY.md.
  fs.mkdirSync(RESULTS, { recursive: true });
  const name = `${date}-${sha}-${a.preset}${a.dry ? "-dry" : ""}`;
  let file = path.join(RESULTS, `${name}.json`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(RESULTS, `${name}-${n}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  const row = summaryRow(result, path.basename(file));
  const summary = path.join(RESULTS, "SUMMARY.md");
  if (!fs.existsSync(summary)) fs.writeFileSync(summary, SUMMARY_HEAD);
  fs.appendFileSync(summary, `${row}\n`);
  log("");
  for (const p of perTicket)
    log(
      `  ${p.oracle === "PASS" ? "pass" : "FAIL"}  ${p.key.padEnd(16)} ${p.stage}${p.waits ? `(${p.waits})` : ""}${p.merged ? " merged" : ""} · rounds ${p.rounds}${p.catchUps ? ` · catch-ups ${p.catchUps}` : ""}${p.note ? ` · ${p.note}` : ""}`,
    );
  log("");
  log(SUMMARY_HEAD.trim().split("\n").slice(-2).join("\n"));
  log(row);
  log(
    `\nresults: ${path.relative(ROOT, file)} · row added to ${path.relative(ROOT, summary)} · run folder ${run}${a.keep ? "" : " (removed; --keep keeps it)"}`,
  );
  if (!a.keep) fs.rmSync(run, { recursive: true, force: true });
  return 0;
}

const SUMMARY_HEAD = `# Bench results

One row per run of \`npm run bench\` (bench/README.md says what each column means). \`dry\` rows ran the stand-in agent: they prove the pipeline and the oracles, never Kitchen's quality.

| date | mode | Kitchen | preset | oracle pass | merged | needs you | rounds | wall | $ | per ticket | file |
|---|---|---|---|---|---|---|---|---|---|---|---|
`;

function summaryRow(
  r: {
    date: string;
    mode: string;
    kitchen: string;
    preset: string;
    summary: { tickets: number; oraclePass: number; merged: number; needsYou: number; rounds: number; wallSecs: number; usd: number; timedOut: boolean };
    tickets: { key: string; oracle: string }[];
  },
  file: string,
): string {
  const s = r.summary;
  const wall = `${Math.floor(s.wallSecs / 60)}m ${String(s.wallSecs % 60).padStart(2, "0")}s${s.timedOut ? " (timed out)" : ""}`;
  const each = r.tickets.map((t) => `${t.key} ${t.oracle === "PASS" ? "ok" : "FAIL"}`).join(", ");
  return `| ${r.date} | ${r.mode} | ${r.kitchen} | ${r.preset} | ${s.oraclePass}/${s.tickets} | ${s.merged} | ${s.needsYou} | ${s.rounds} | ${wall} | $${s.usd.toFixed(2)} | ${each} | ${file} |`;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`bench: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
