#!/usr/bin/env node
// W0 spike B (+ review fixes): prove fixture A's Toolkit contract, the drive format,
// the manifest, slots and the untrusted env end to end. Every check is an
// expectation; the script exits 1 if any is missed.
//   node spikes/w0/run-toolkit-spike.mjs <workdir> [--cold]
// <workdir> gets fresh git copies of fixtures/a-web (standing in for job worktrees),
// job dirs, a throwaway bare remote, KITCHEN_HOME and Toolkit state. At most two
// Postgres containers run at once. Everything started is torn down in `finally`.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
if (!process.argv[2]) throw new Error("usage: run-toolkit-spike.mjs <workdir> [--cold]");
const work = path.resolve(process.argv[2]);
const cold = process.argv.includes("--cold");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// A fake token in the engine's own env: it must never reach app code.
const FAKE_TOKEN = "ghp_kitchenSpikeFakeToken0000000000000000";
const env = { ...process.env, KITCHEN_HOME: path.join(work, "kitchen-home"), KITCHEN_TOOLKIT_STATE: path.join(work, "toolkit-state"), GH_TOKEN: FAKE_TOKEN };
const kitchen = path.join(repo, "src/proof/cli.ts");
const neg = (f) => path.join(repo, "spikes/w0/negative", f);
const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "user.name=kitchen", "-c", "user.email=k@example.invalid", ...a], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const bare = path.join(work, "remote.git");
git(work, "init", "-q", "--bare", bare);
/** A fresh copy of fixture A as its own git repo with `origin` = the bare remote (a stand-in job worktree). */
function worktree(name) {
  const dir = path.join(work, name);
  fs.cpSync(path.join(repo, "fixtures/a-web"), dir, { recursive: true, filter: (p) => !p.includes("node_modules") });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture A");
  git(dir, "remote", "add", "origin", bare);
  return dir;
}
const src = worktree("src");
const srcHead = git(src, "rev-parse", "HEAD");
const dev = path.join(src, ".kitchen/toolkit/bin/dev");
const jobDir = (id) => path.join(work, "jobs", id);

// ---------- running things ----------
const rows = [];
const misses = [];
function expect(label, pass, detail = "") {
  const line = `${pass ? "PASS" : "MISS"} ${label}${detail ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  console.log(line.slice(0, 400));
  rows.push({ check: label, pass, detail });
  if (!pass) misses.push(label);
  return pass;
}
function exec(label, cmd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(cmd, args, { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      const secs = (Date.now() - t) / 1000;
      let json = null;
      try {
        json = JSON.parse(out.trim().split("\n").at(-1));
      } catch {}
      fs.appendFileSync(path.join(work, "spike.log"), `\n### ${label} (${secs}s, exit ${code})\n${err}\n${out}`);
      console.log(
        `  ${code === 0 ? "ok  " : "exit"}${code === 0 ? "" : code} ${secs.toFixed(2).padStart(6)}s  ${label}  ${JSON.stringify(json).slice(0, 200)}`,
      );
      resolve({ exit: code, json, out, err, secs });
    });
  });
}
const kc = (label, ...args) => exec(label, process.execPath, [kitchen, ...args]);
const tk = (label, s, ...argv) => exec(label, process.execPath, [kitchen, "toolkit", path.join(s, ".kitchen/toolkit/bin/dev"), s, ...argv]);
const drive = (label, id, ...args) => kc(label, "drive", jobDir(id), ...args);
const feature = (name, file) => ["--feature", name, ...(file ? ["--file", file] : [])];
const ports = (r) => r.json.slot.ports.slice(0, 3).join(",");
const manifest = (id) =>
  fs
    .readFileSync(path.join(jobDir(id), "evidence/manifest.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const head = (id) => JSON.parse(fs.readFileSync(path.join(jobDir(id), "job.json"), "utf8")).manifestHead;
const containers = () => execFileSync("docker", ["ps", "-a", "--filter", "label=kitchen.toolkit=a-web", "--format", "{{.Names}}"], { encoding: "utf8" }).trim();

const started = new Map(); // slot id → src
async function upSlot(id, s, pid = process.pid) {
  const a = await kc(
    `slot acquire ${id}`,
    "slot",
    "acquire",
    "--id",
    id,
    "--pid",
    String(pid),
    "--toolkit",
    path.join(s, ".kitchen/toolkit/bin/dev"),
    "--src",
    s,
  );
  started.set(id, s);
  const u = await tk(`up ${id}`, s, "up", `--id=${id}`, `--src=${s}`, `--ports=${ports(a)}`);
  return { a, u };
}
async function downSlot(id) {
  const s = started.get(id);
  const d = await tk(`down ${id}`, s, "down", `--id=${id}`);
  started.delete(id);
  await kc(`slot release ${id}`, "slot", "release", "--id", id);
  return d;
}

try {
  // ---------- prepare, describe ----------
  if (cold) {
    const tag = JSON.parse(execFileSync(dev, ["prepare", "--src", src], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).snapshot;
    execFileSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
  }
  const prep = await tk("prepare", src, "prepare", `--src=${src}`);
  expect("prepare", prep.exit === 0 && prep.json?.status === "ok", prep.json);
  const desc = await tk("describe", src, "describe", `--src=${src}`);
  expect(
    "describe lists feature files only, needs 3 ports, has open/reload",
    JSON.stringify(desc.json?.features) === JSON.stringify(["features/invites.md", "features/projects.md", "features/settings.md"]) &&
      desc.json?.ports?.needs === 3 &&
      ["open", "reload", "read"].every((p) => desc.json.primitives.some((x) => x.name === p)),
    { features: desc.json?.features, ports: desc.json?.ports },
  );

  // ---------- one slot: up, doctor, drives, reset, drives again ----------
  const s1 = await upSlot("s1", src);
  expect(
    "slot records its Toolkit, source and owner start time",
    s1.a.json.slot.toolkitBin === dev && s1.a.json.slot.src === src && !!s1.a.json.slot.pidStart,
    {
      toolkitBin: s1.a.json.slot.toolkitBin,
      pidStart: s1.a.json.slot.pidStart,
    },
  );
  expect("up s1", s1.u.json?.status === "ready", s1.u.json);
  const doc = await tk("doctor s1", src, "doctor", "--id=s1");
  expect("doctor s1", doc.json?.status === "ok", doc.json?.checks?.map((c) => `${c.name}:${c.ok}`).join(" "));
  await kc("job create s1", "job", "create", jobDir("s1"), "--worktree", src, "--toolkit", dev, "--slot-id", "s1");

  const three = async (round) => [
    await drive(`settings.toggle-dark r${round}`, "s1", ...feature("settings.toggle-dark"), "--arg", "user=alice", "--criterion", "C1"),
    await drive(`projects.create r${round}`, "s1", ...feature("projects.create"), "--arg", "user=alice", "--arg", "slug=launch-plan", "--criterion", "C2"),
    await drive(`invites.generate-and-join r${round}`, "s1", ...feature("invites.generate-and-join"), "--arg", "admin=bob-admin", "--criterion", "C3"),
  ];
  const r1 = await three(1);
  expect(
    "three feature drives green (round 1)",
    r1.every((r) => r.json?.ok === true),
    r1.map((r) => `${r.json?.drive}:${r.json?.ok}`),
  );
  const m1 = manifest("s1");
  expect(
    "every entry stamps the tested worktree's HEAD (not the kitchen repo), clean",
    m1.every((e) => e.sha === srcHead && e.dirty === false && /^[0-9a-f]{40}$/.test(e.tree)),
    { srcHead, kitchenHead: git(repo, "rev-parse", "HEAD"), stamped: [...new Set(m1.map((e) => e.sha))] },
  );
  expect(
    "ids are e1…eN, chained",
    m1.every((e, i) => e.id === `e${i + 1}` && /^[0-9a-f]{64}$/.test(e.prev)),
    `${m1.length} entries`,
  );
  const waits = m1.filter((e) => e.wait);
  expect(
    "each wait is one entry with its poll count",
    waits.length > 0 && waits.every((e) => e.wait.polls >= 1),
    waits.map((e) => `${e.id}:${e.wait.polls}`).join(" "),
  );
  const shots = m1.filter((e) => e.files.some((f) => f.path.endsWith(".png")));
  expect(
    "screenshots land in their own entry folder e<N>/, hashed",
    shots.length > 0 && shots.every((e) => e.files.every((f) => f.path.startsWith(`${e.id}/`) && /^[0-9a-f]{64}$/.test(f.sha256))),
    shots.map((e) => e.files.map((f) => f.path).join(",")),
  );

  const snapR1 = path.join(work, "snap-s1-r1"); // job.json + manifest after round 1, for the rollback tamper below
  fs.cpSync(jobDir("s1"), snapR1, { recursive: true });

  const rs = await tk("reset s1", src, "reset", "--id=s1");
  expect("reset", rs.json?.status === "ok", rs.json);
  const r2 = await three(2);
  expect(
    "three feature drives green again after reset",
    r2.every((r) => r.json?.ok === true),
    r2.map((r) => `${r.json?.drive}:${r.json?.ok}`),
  );

  // ---------- negatives ----------
  const n0 = manifest("s1").length;
  const gap = await drive("needs-sql (expect gap)", "s1", ...feature("negative.needs-sql", neg("needs-sql.md")), "--criterion", "N1");
  const gapEntry = manifest("s1").at(-1);
  expect(
    "missing primitive → TOOLKIT-GAP, stamped, nothing run",
    gap.json?.gap === "sql" && gapEntry.gap === "sql" && manifest("s1").length === n0 + 1,
    gapEntry,
  );
  const wt = await drive("wrong-text (expect FAIL)", "s1", ...feature("negative.wrong-text", neg("wrong-text.md")), "--criterion", "N2");
  expect("unmeetable wait + retry fails", wt.exit === 1 && wt.json?.ok === false && /Purple/.test(wt.json?.failedAt?.step ?? ""), wt.json?.failedAt?.step);
  const ew = await drive("empty-wait (expect FAIL)", "s1", ...feature("negative.empty-wait", neg("empty-wait.md")), "--criterion", "N3");
  expect("a wait whose text substitutes to empty fails", ew.exit === 1 && ew.json?.failedAt?.why === "empty wait text", ew.json?.failedAt);
  const ma = await drive("missing-attr (expect FAIL)", "s1", ...feature("negative.missing-attr", neg("missing-attr.md")), "--criterion", "N4");
  expect("read of a missing attribute is ok:false", ma.exit === 1 && /no attribute data-nope/.test(String(ma.json?.failedAt?.out)), ma.json?.failedAt?.out);

  const n1 = manifest("s1").length;
  const rf = await drive("reserved-flag drive (expect refused)", "s1", ...feature("negative.reserved-flag", neg("reserved-flag.md")), "--criterion", "N5");
  expect(
    "a drive step with id: is refused at parse, nothing stamped",
    rf.exit === 1 && /"id" is set by the engine/.test(rf.json?.why) && manifest("s1").length === n1,
    rf.json?.why,
  );
  const lp = await drive("primitive login id=p2 (expect refused)", "s1", "--primitive", "login", "--pargs", JSON.stringify({ as: "bob-admin", id: "p2" }));
  expect("a primitive call with id: is refused", lp.exit === 1 && /"id" is set by the engine/.test(lp.json?.why), lp.json?.why);
  const outside = path.join(work, "outside-evidence");
  const so = await drive(
    "primitive screenshot out=<abs> (expect refused)",
    "s1",
    "--primitive",
    "screenshot",
    "--pargs",
    JSON.stringify({ name: "e12", out: outside }),
  );
  expect(
    "a screenshot with out: is refused, nothing written outside evidence",
    so.exit === 1 && /"out" is set by the engine/.test(so.json?.why) && !fs.existsSync(outside) && manifest("s1").length === n1,
    so.json?.why,
  );
  const dup = await tk(
    "bin/dev read with a second --id (expect refused)",
    src,
    "read",
    "--id=s1",
    `--src=${src}`,
    `--out=${outside}`,
    "--target=body",
    "--id=p2",
  );
  expect("bin/dev refuses a flag given twice", dup.exit !== 0 && /given twice/.test(String(dup.json?.out)), dup.json);

  const fa = await drive("http @evil.example/x", "s1", ...feature("negative.foreign-at", neg("foreign-origin.md")), "--criterion", "N6");
  expect("`@evil.example/x` stays on the app (a 404 on /@evil.example/x)", fa.exit === 1 && fa.json?.failedAt?.out?.status === 404, fa.json?.failedAt?.out);
  const fb = await drive("http http://evil.example/x", "s1", ...feature("negative.foreign-abs", neg("foreign-origin.md")), "--criterion", "N6");
  expect("an absolute foreign URL is refused by the driver", fb.exit === 1 && /leaves the app/.test(String(fb.json?.failedAt?.out)), fb.json?.failedAt?.out);
  const fo = await drive("open //evil.example/x", "s1", ...feature("negative.foreign-open", neg("foreign-origin.md")), "--criterion", "N6");
  expect("open of a protocol-relative URL is refused", fo.exit === 1 && /leaves the app/.test(String(fo.json?.failedAt?.out)), fo.json?.failedAt?.out);

  // ---------- one drive at a time per job ----------
  const before = manifest("s1").length;
  const conc = await Promise.all([
    drive("concurrent A", "s1", "--primitive", "read", "--pargs", JSON.stringify({ target: "body" }), "--criterion", "C9"),
    drive("concurrent B", "s1", "--primitive", "screenshot", "--pargs", JSON.stringify({ name: "same" }), "--criterion", "C9"),
    drive("concurrent C", "s1", "--primitive", "screenshot", "--pargs", JSON.stringify({ name: "same" }), "--criterion", "C9"),
  ]);
  const after = manifest("s1");
  const ver = await kc("verify s1", "verify", jobDir("s1"));
  expect(
    "three concurrent drives on one job: distinct contiguous ids, own folders, manifest verifies",
    conc.every((r) => r.json?.ok) &&
      after.length === before + 3 &&
      new Set(conc.flatMap((r) => r.json.evidence)).size === 3 &&
      ver.json?.ok === true &&
      ver.json.entries === head("s1").n,
    { evidence: conc.map((r) => r.json?.evidence), verify: ver.json },
  );

  // ---------- source stamp: dirty tree, no git ----------
  fs.writeFileSync(path.join(src, "UNCOMMITTED.txt"), "x");
  const dirty = await drive("drive on a dirty tree", "s1", "--primitive", "read", "--pargs", JSON.stringify({ target: "body" }));
  const de = manifest("s1").at(-1);
  expect("a dirty worktree is stamped dirty with its own tree hash", dirty.json?.ok && de.dirty === true && de.sha === srcHead && de.tree !== m1[0].tree, {
    dirty: de.dirty,
    tree: de.tree,
  });
  fs.rmSync(path.join(src, "UNCOMMITTED.txt"));
  const nogit = path.join(work, "nogit");
  fs.mkdirSync(nogit);
  const ng = await kc("job create nogit (expect refused)", "job", "create", jobDir("nogit"), "--worktree", nogit, "--toolkit", dev, "--slot-id", "s1");
  expect(
    'no git → no job, so no proof (never sha "unknown")',
    ng.exit === 1 && /not a git checkout/.test(ng.json?.why) && !fs.existsSync(jobDir("nogit")),
    ng.json?.why,
  );

  // ---------- engine git: a linked worktree, gitdir resolved from the main repo ----------
  const linked = path.join(work, "src-linked");
  git(src, "worktree", "add", "-q", "--detach", linked, "HEAD");
  const lf = await kc(
    "job create linked, no --repo (expect refused)",
    "job",
    "create",
    jobDir("linked-x"),
    "--worktree",
    linked,
    "--toolkit",
    dev,
    "--slot-id",
    "s1",
  );
  expect("a linked worktree without its main repo is refused (its .git file is never read)", lf.exit === 1 && /is a file/.test(lf.json?.why), lf.json?.why);
  const lj = await kc(
    "job create linked",
    "job",
    "create",
    jobDir("linked"),
    "--worktree",
    linked,
    "--repo",
    src,
    "--worktree-id",
    "src-linked",
    "--toolkit",
    dev,
    "--slot-id",
    "s1",
  );
  expect(
    "a linked worktree's gitdir is <main>/.git/worktrees/<id>",
    lj.json?.job?.gitDir === fs.realpathSync(path.join(src, ".git/worktrees/src-linked")),
    lj.json?.job?.gitDir,
  );
  fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(work, "nowhere")}\n`); // the worktree redirects itself
  const ld = await drive(
    "drive on the linked worktree after its .git was redirected",
    "linked",
    "--primitive",
    "read",
    "--pargs",
    JSON.stringify({ target: "body" }),
  );
  const le = manifest("linked").at(-1);
  expect("stamped through the recorded gitdir: the real HEAD, the redirect ignored", ld.json?.ok === true && le.sha === srcHead && le.dirty === false, {
    sha: le?.sha,
    dirty: le?.dirty,
  });

  const dn = await downSlot("s1");
  expect("down s1", dn.json?.status === "ok", dn.json);
  const v2 = await kc("verify s1 after down", "verify", jobDir("s1"));
  const pngs = fs.readdirSync(path.join(jobDir("s1"), "evidence"), { recursive: true }).filter((f) => String(f).endsWith(".png"));
  expect("evidence survives down and verifies", v2.json?.ok === true && pngs.length >= 2, `${v2.json?.entries} entries, ${pngs.length} PNGs`);

  // ---------- integrity: tampering ----------
  const tamper = async (name, edit, re) => {
    fs.cpSync(jobDir("s1"), jobDir(name), { recursive: true });
    const ok = await kc(`verify ${name} before edit`, "verify", jobDir(name));
    edit(jobDir(name));
    const r = await kc(`verify ${name} after edit`, "verify", jobDir(name));
    expect(`tamper: ${name}`, ok.json?.ok === true && r.exit === 1 && re.test(r.json?.refused ?? ""), r.json?.refused);
  };
  const mf = (d) => path.join(d, "evidence/manifest.jsonl");
  await tamper("edited-line", (d) => fs.writeFileSync(mf(d), fs.readFileSync(mf(d), "utf8").replace('"ok":false', '"ok":true')), /chain|head/);
  await tamper("deleted-manifest", (d) => fs.rmSync(mf(d)), /missing or empty/);
  await tamper(
    "dropped-last-line",
    (d) => fs.writeFileSync(mf(d), `${fs.readFileSync(mf(d), "utf8").trim().split("\n").slice(0, -1).join("\n")}\n`),
    /entries/,
  );
  await tamper(
    "replaced-screenshot",
    (d) => fs.writeFileSync(path.join(d, "evidence", shots[0].files.find((f) => f.path.endsWith(".png")).path), "not the screenshot"),
    /content changed/,
  );
  await tamper(
    "job.json head edited",
    (d) => {
      const j = JSON.parse(fs.readFileSync(path.join(d, "job.json"), "utf8"));
      j.manifestHead.n -= 1;
      fs.writeFileSync(path.join(d, "job.json"), JSON.stringify(j));
    },
    /signature/,
  );
  await tamper(
    "job.json head removed",
    (d) => {
      const j = JSON.parse(fs.readFileSync(path.join(d, "job.json"), "utf8"));
      delete j.manifestHead;
      fs.writeFileSync(path.join(d, "job.json"), JSON.stringify(j));
    },
    /no expected manifest head/,
  );

  await tamper(
    "rolled back to round 1 (older job.json + its manifest, both validly signed)",
    (d) => {
      fs.rmSync(path.join(d, "evidence"), { recursive: true });
      fs.cpSync(path.join(snapR1, "evidence"), path.join(d, "evidence"), { recursive: true });
      fs.copyFileSync(path.join(snapR1, "job.json"), path.join(d, "job.json"));
    },
    /rolled back/,
  );

  // ---------- two slots at once ----------
  const [p1, p2] = await Promise.all([upSlot("p1", src), upSlot("p2", src)]);
  expect("two slots up in parallel", p1.u.json?.status === "ready" && p2.u.json?.status === "ready" && p1.a.json.slot.n !== p2.a.json.slot.n, [
    p1.u.json?.secs,
    p2.u.json?.secs,
  ]);
  const ps = execFileSync("docker", ["ps", "--filter", "label=kitchen.toolkit=a-web", "--format", "{{.Names}} {{.Ports}}"], { encoding: "utf8" }).trim();
  expect("two Postgres containers, one per slot", ps.split("\n").length === 2, ps);
  await kc("job create p1", "job", "create", jobDir("p1"), "--worktree", src, "--toolkit", dev, "--slot-id", "p1");
  await kc("job create p2", "job", "create", jobDir("p2"), "--worktree", src, "--toolkit", dev, "--slot-id", "p2");
  const par = await Promise.all([
    drive("settings p1 (concurrent)", "p1", ...feature("settings.toggle-dark"), "--arg", "user=alice", "--criterion", "C1"),
    drive("settings p2 (concurrent)", "p2", ...feature("settings.toggle-dark"), "--arg", "user=alice", "--criterion", "C1"),
  ]);
  expect(
    "drives on both slots at once",
    par.every((r) => r.json?.ok),
    par.map((r) => r.json?.ok),
  );
  await Promise.all([downSlot("p1"), downSlot("p2")]);

  // ---------- stale slots: dead owner, reused pid ----------
  const deadPid = spawn("true").pid;
  await new Promise((r) => setTimeout(r, 300));
  const o = await upSlot("orphan", src, deadPid);
  expect("orphan up (owner pid already dead)", o.u.json?.status === "ready");
  const reg = path.join(env.KITCHEN_HOME, "slots.json");
  const fresh = await kc(
    "slot acquire fresh (reclaims orphan)",
    "slot",
    "acquire",
    "--id",
    "fresh",
    "--pid",
    String(process.pid),
    "--toolkit",
    dev,
    "--src",
    src,
  );
  const orphanLeft = execFileSync("docker", ["ps", "-a", "--filter", "label=kitchen.id=orphan", "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
  expect("stale slot reclaimed after its own Toolkit's down", fresh.json?.reclaimed?.includes("orphan") && !orphanLeft, {
    reclaimed: fresh.json?.reclaimed,
    orphanLeft,
  });
  if (!orphanLeft) started.delete("orphan");
  // the live owner's pid, but a different start time: a reused pid
  const r0 = JSON.parse(fs.readFileSync(reg, "utf8"));
  r0.slots.find((s) => s.id === "fresh").pidStart = "Thu Jan  1 00:00:00 1970";
  fs.writeFileSync(reg, JSON.stringify(r0));
  const again = await kc("slot acquire next (pid reused)", "slot", "acquire", "--id", "next", "--pid", String(process.pid), "--toolkit", dev, "--src", src);
  expect("a slot whose owner pid was reused is stale", again.json?.reclaimed?.includes("fresh"), again.json?.reclaimed);
  await kc("slot release next", "slot", "release", "--id", "next");

  // ---------- untrusted env: the app can't push or use gh, and never sees the engine's token ----------
  const probe = worktree("src-probe");
  fs.renameSync(path.join(probe, "server.js"), path.join(probe, "server-real.js"));
  fs.copyFileSync(path.join(repo, "spikes/w0/app-startup-probe.mjs"), path.join(probe, "app-startup-probe.mjs"));
  fs.writeFileSync(path.join(probe, "server.js"), 'import "./app-startup-probe.mjs";\nimport "./server-real.js";\n');
  // control: the same probe with the engine's own env, no Kitchen in between
  execFileSync(process.execPath, ["app-startup-probe.mjs"], { cwd: probe, env: { ...env, PROBE_BRANCH: "control-push", PROBE_SUFFIX: "-control" } });
  const ctl = JSON.parse(fs.readFileSync(path.join(probe, "startup-probe-control.json"), "utf8"));
  expect(
    "control (engine env, no scrub): push to the local bare remote works and gh sees GH_TOKEN",
    ctl.push.exit === 0 && git(bare, "branch", "--list", "control-push") !== "" && ctl.env.GH_TOKEN === "set" && ctl.gh.mentionsGhToken,
    ctl,
  );
  const pp = await tk("prepare src-probe", probe, "prepare", `--src=${probe}`);
  expect("prepare src-probe", pp.json?.status === "ok");
  const pu = await upSlot("probe", probe);
  expect("up probe app", pu.u.json?.status === "ready", pu.u.json);
  const state = JSON.parse(fs.readFileSync(path.join(env.KITCHEN_TOOLKIT_STATE, "probe/state.json"), "utf8"));
  const psEnv = execFileSync("ps", ["eww", String(state.appPid)], { encoding: "utf8" });
  expect(
    "ps eww <appPid>: no GH_TOKEN, no fake token, no agent keys, no Docker/control vars",
    psEnv.includes("server.js") &&
      !/GH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|DOCKER_HOST|KITCHEN_CONTROL_ENV|KITCHEN_HOME/.test(psEnv) &&
      !psEnv.includes(FAKE_TOKEN),
    { pid: state.appPid, hasKitchenUntrusted: psEnv.includes("KITCHEN_UNTRUSTED=1") },
  );
  const got = JSON.parse(fs.readFileSync(path.join(probe, "startup-probe.json"), "utf8"));
  expect(
    "app startup: git push to the local bare remote fails, no branch created",
    got.push.exit !== 0 && git(bare, "branch", "--list", "app-push") === "" && got.pid === state.appPid,
    got.push,
  );
  expect("app startup: gh auth status shows no login", got.gh.exit !== 0 && got.gh.notLoggedIn && !got.gh.mentionsGhToken, got.gh);
  expect(
    "app startup: env had no GH_TOKEN/agent keys, KITCHEN_UNTRUSTED set",
    got.env.GH_TOKEN === "unset" && got.env.ANTHROPIC_API_KEY === "unset" && got.env.KITCHEN_UNTRUSTED === "set",
    got.env,
  );
  await downSlot("probe");
} catch (e) {
  expect("spike ran to the end", false, e.stack);
} finally {
  for (const id of [...started.keys()]) await downSlot(id);
  const left = containers();
  expect("cleanup: no kitchen containers left", !left, left || "none");
  fs.writeFileSync(path.join(work, "results.json"), JSON.stringify(rows, null, 2));
  console.log(`\n${rows.length - misses.length}/${rows.length} expectations met${misses.length ? `; MISSED: ${misses.join(" | ")}` : ""}`);
  process.exitCode = misses.length ? 1 : 0;
}
