// W3a engine spike, no model: the scripted agent (fake-agent.ts) on a copy of
// fixture A with the planted dark-mode bug, the real Toolkit, Docker and engine.
//   node spikes/w3a/engine.ts attacks <scratch>   repro, layer rules, code in a drive, forged/stale/self-check citations
//   node spikes/w3a/engine.ts kill <scratch>      kill -9 mid-Verify and resume: no proof re-run, verdict right
// Each part prints PASS/FAIL lines and exits 1 on any miss. One Docker stack at a time.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  check,
  finish,
  HERE,
  jobDir,
  jobOf,
  kitchenContainers,
  makeFixtureRepo,
  manifest,
  type Repo,
  ROOT,
  sleep,
  stagesOf,
  stepUntil,
  ticket,
} from "./lib.ts";

const part = process.argv[2];
const root = path.resolve(process.argv[3] ?? path.join(HERE, ".work"));
fs.mkdirSync(root, { recursive: true });
const STOP = ["review", "needs-human", "needs-info", "rejected", "done", "paused"];
const yaml = (roundLimit: number) => `concurrency: 1
round_limit: ${roundLimit}
agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-agent.ts"))} }
checks:
  - { name: syntax, run: "node --check server.js" }
`;
const TICKET = "Dark mode doesn't stick: I turn it on in Settings, it says Saved, but after a reload the app is light again.";
const git = (r: Repo, ...a: string[]) => execFileSync("git", ["-C", r.dir, ...a], { encoding: "utf8" });
const read = (r: Repo, id: string, rel: string) => {
  const f = path.join(jobDir(r, id), rel);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};
const verifyManifestCli = (r: Repo, id: string) =>
  JSON.parse(
    execFileSync(process.execPath, [path.join(ROOT, "src/proof/cli.ts"), "verify", jobDir(r, id)], { env: r.env, encoding: "utf8" })
      .trim()
      .split("\n")
      .pop() ?? "{}",
  ) as {
    ok: boolean;
    entries?: number;
  };

async function attacks() {
  const r = makeFixtureRepo(root, "attacks", { yaml: yaml(5), bug: true });
  const id = ticket(r, `${TICKET}\n\nscenario: attacks`);
  const log = path.join(root, "attacks.log");
  fs.writeFileSync(log, "");
  const out = stepUntil(r, id, STOP, { max: 60, log });
  const j = jobOf(r, id);
  console.log(`    stages: ${stagesOf(r, id).join(" → ")}`);
  const branch = `kitchen/${id}`;

  // Repro: the sneaked-in fix is kept off; only the drive is committed; it failed as expected on the base.
  const reproCommit = git(r, "log", "--format=%H", "--grep=regression test (repro)", branch).trim().split("\n")[0];
  const reproFiles = reproCommit ? git(r, "show", "--name-only", "--format=", reproCommit).trim() : "(no repro commit)";
  check("repro commit holds only the new feature drive (the fix it sneaked in was kept off)", reproFiles === ".kitchen/toolkit/features/theme.md", reproFiles);
  check("…and says why", /server\.js: the repro adds a regression test; it doesn't change existing files/.test(out));
  const repro = JSON.parse(read(r, id, "repro-1.json") || "{}") as { status?: string; why?: string; evidence?: string[]; head?: string };
  check("kitchen drive --repro failed as expected on the base", repro.status === "assert-fail", `${repro.status}: ${repro.why}`);
  const m = manifest(r, id);
  const reproEntries = m.filter((e) => e.phase === "repro");
  check(
    "repro evidence is stamped by the engine on the repro commit (base + the drive), clean tree",
    reproEntries.length > 0 && reproEntries.every((e) => e.role === "engine" && e.sha === reproCommit && e.dirty === false && e.criterion === "C1"),
    `${reproEntries.length} entries`,
  );
  check("job.reproFiles names the drive the builder may not edit", JSON.stringify(j.reproFiles) === JSON.stringify([".kitchen/toolkit/features/theme.md"]));

  // Builder round 1: Toolkit primitives, the repro drive and kitchen.yaml stripped.
  const refused = read(r, id, "rounds/1/build-refused.md");
  for (const f of [".kitchen/toolkit/bin/dev", ".kitchen/toolkit/lib/extra.mjs", ".kitchen/toolkit/features/theme.md", "kitchen.yaml"])
    check(`builder edit to ${f} refused`, refused.includes(`- ${f}: `), refused.split("\n").find((l) => l.includes(f)) ?? "");
  const touched = git(r, "diff", "--name-only", j.base, branch).trim().split("\n").sort();
  check(
    "the branch changes only server.js and the feature drives",
    JSON.stringify(touched) === JSON.stringify([".kitchen/toolkit/features/settings-dark.md", ".kitchen/toolkit/features/theme.md", "server.js"]),
    touched.join(", "),
  );
  check(
    "bin/dev on the branch is the base's",
    git(r, "diff", j.base, branch, "--", ".kitchen/toolkit/bin", ".kitchen/toolkit/lib", "kitchen.yaml").trim() === "",
  );
  check(
    "the builder's self-check through the bridge is stamped role builder",
    m.some((e) => e.role === "builder" && e.criterion === "C3"),
  );

  // Drives: the drive with code is refused and never committed; the second attempt passes the check.
  const d1 = read(r, id, "rounds/1/drives-check-1.md");
  check(
    "drives attempt 1: the drive holding code is refused",
    /can't hold code|would run code/.test(d1),
    d1.split("\n").find((l) => /code/.test(l)) ?? d1.slice(0, 200),
  );
  check("drives attempt 1: the drives role's edit to server.js is kept off", /server\.js: in the drives stage only/.test(out));
  const everDrive = git(r, "log", "-p", "--format=", branch, "--", ".kitchen/toolkit/features/settings-dark.md");
  check("no commit ever carried the code drive", !/eval:|```js/.test(everDrive) && everDrive.includes("settings.dark-screenshot"));
  const checkEntries = m.filter((e) => String(e.phase ?? "").startsWith("toolkit-check"));
  check(
    "toolkit check --feature ran each new drive twice (reset between), stamped role engine",
    checkEntries.length > 0 && checkEntries.every((e) => e.role === "engine" && e.criterion === "drives"),
  );

  // Verify: forged, stale and self-check citations each refused (a round each), then PASS.
  const verdicts = [1, 2, 3, 4].map((n) => {
    const dir = path.join(jobDir(r, id), "rounds", String(n));
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^verdict-m\d+\.md$/.test(x)) : [];
    return f.length ? fs.readFileSync(path.join(dir, f[0]), "utf8") : "";
  });
  check(
    "round 1: a forged id is refused (FAIL)",
    /^VERDICT: FAIL/m.test(verdicts[0]) && /not in the manifest/.test(verdicts[0]),
    verdicts[0].split("\n").find((l) => l.startsWith("| C3")) ?? "",
  );
  check(
    "round 2: a stale id (round 1's evidence) is refused",
    /^VERDICT: FAIL/m.test(verdicts[1]) && /round 1, not 2/.test(verdicts[1]),
    verdicts[1].split("\n").find((l) => l.startsWith("| C3")) ?? "",
  );
  check(
    "round 3: the builder's self-check is refused",
    /^VERDICT: FAIL/m.test(verdicts[2]) && /(self-check|not HEAD|dirty|round 1)/.test(verdicts[2]),
    verdicts[2].split("\n").find((l) => l.startsWith("| C3")) ?? "",
  );
  check(
    "round 4: right citations, mechanical C1 C2 by the engine → PASS",
    /^VERDICT: PASS/m.test(verdicts[3]) && /\| C1 \| engine \| PASS/.test(verdicts[3]) && /\| C3 \| verifier \| PASS/.test(verdicts[3]),
  );
  check("the job reached review", j.stage === "review", `${j.stage} ${j.pausedReason ?? ""}`);
  const v = verifyManifestCli(r, id);
  check("the manifest verifies against the signed head", v.ok === true && v.entries === j.manifestHead.n, JSON.stringify(v));
  check("no kitchen container left running", kitchenContainers().length === 0, kitchenContainers().join(" "));
}

async function kill() {
  const r = makeFixtureRepo(root, "kill", { yaml: yaml(3), bug: true });
  const id = ticket(r, `${TICKET}\n\nscenario: honest`);
  const log = path.join(root, "kill.log");
  fs.writeFileSync(log, "");
  stepUntil(r, id, ["verify", ...STOP], { log });
  check("the job reached verify", jobOf(r, id).stage === "verify", jobOf(r, id).stage);
  const before = jobOf(r, id);
  const progress = path.join(jobDir(r, id), "rounds", String(before.round), `proofs-m${before.moves}.json`);
  const p = spawn(process.execPath, [path.join(ROOT, "src/cli.ts"), "run", "--once", id, "--repo", r.dir], { env: r.env, stdio: ["ignore", "pipe", "pipe"] });
  let runOut = "";
  p.stdout.on("data", (d) => {
    runOut += d;
  });
  p.stderr.on("data", (d) => {
    runOut += d;
  });
  // Kill when one proof is recorded and the next one has stamped at least two steps.
  let killedAt = "";
  for (let i = 0; i < 1200 && !killedAt; i++) {
    await sleep(50);
    if (!fs.existsSync(progress)) continue;
    const done = (JSON.parse(fs.readFileSync(progress, "utf8")) as { proofs: { criterion: string; evidence: string[] }[] }).proofs;
    if (!done.length) continue;
    const last = Math.max(...done.flatMap((x) => x.evidence.map((e) => Number(e.slice(1)))));
    const n = manifest(r, id).length;
    if (n >= last + 2) {
      process.kill(p.pid as number, "SIGKILL");
      killedAt = `after ${done.map((x) => x.criterion).join(",")} recorded, manifest at ${n} (last recorded e${last})`;
    }
  }
  await new Promise((res) => p.once("exit", res));
  fs.appendFileSync(log, `${runOut}\n--- SIGKILL ${killedAt}\n`);
  check("kill -9 landed mid-Verify, between two proofs", !!killedAt && jobOf(r, id).stage === "verify", killedAt);
  const recorded = (JSON.parse(fs.readFileSync(progress, "utf8")) as { proofs: { criterion: string }[] }).proofs.map((x) => x.criterion);
  const resumed = stepUntil(r, id, STOP, { log });
  const j = jobOf(r, id);
  check(
    "resume reuses the recorded proofs",
    resumed.includes(`proofs already decided before a restart, not run again: ${recorded[0]}`),
    resumed.split("\n").find((l) => l.includes("already decided")) ?? "",
  );
  // Count drive runs per criterion in this Verify (round, role engine, no phase): one `login` step per run.
  const m = manifest(r, id).filter((e) => e.role === "engine" && e.round === before.round && !e.phase && /^C\d$/.test(e.criterion));
  const runs = (c: string) => m.filter((e) => e.criterion === c && e.step === "login").length;
  for (const c of recorded) check(`${c} (decided before the kill) ran once, not again`, runs(c) === 1, `${runs(c)} run(s)`);
  const all = ["C1", "C2", "C3"].map((c) => `${c}:${runs(c)}`).join(" ");
  check(
    "the proof cut by the kill ran again once; nothing else repeated",
    ["C1", "C2", "C3"].every((c) => runs(c) >= 1 && runs(c) <= (recorded.includes(c) ? 1 : 2)),
    all,
  );
  check("no entry past the signed head survived (manifest verifies)", verifyManifestCli(r, id).ok === true);
  const verdict = fs.readdirSync(path.join(jobDir(r, id), "rounds", String(before.round))).filter((f) => f.startsWith("verdict-"));
  const vt = verdict.length ? fs.readFileSync(path.join(jobDir(r, id), "rounds", String(before.round), verdict[0]), "utf8") : "";
  check("verdict PASS after the resume, job at review", /^VERDICT: PASS/m.test(vt) && j.stage === "review", `${j.stage}; ${vt.split("\n")[0]}`);
  check("no kitchen container left running", kitchenContainers().length === 0, kitchenContainers().join(" "));
}

if (part === "attacks") await attacks();
else if (part === "kill") await kill();
else throw new Error("usage: engine.ts attacks|kill <scratch>");
finish(`w3a engine ${part}`);
