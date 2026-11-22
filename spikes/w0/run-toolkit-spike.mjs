#!/usr/bin/env node
// W0 spike B: prove fixture A's Toolkit contract and the drive format end to end.
//   node spikes/w0/run-toolkit-spike.mjs <workdir> [--cold]
// <workdir> gets a fresh copy of fixtures/a-web (standing in for a job worktree),
// the evidence folders, and KITCHEN_HOME / Toolkit state. Every command is timed;
// results go to <workdir>/results.json. Everything started is torn down in `finally`.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const work = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: run-toolkit-spike.mjs <workdir> [--cold]");
const cold = process.argv.includes("--cold");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const env = { ...process.env, KITCHEN_HOME: path.join(work, "kitchen-home"), KITCHEN_TOOLKIT_STATE: path.join(work, "toolkit-state") };
const src = path.join(work, "src");
fs.cpSync(path.join(repo, "fixtures/a-web"), src, { recursive: true, filter: (p) => !p.includes("node_modules") });
const dev = path.join(src, ".kitchen/toolkit/bin/dev");
const kitchen = path.join(repo, "src/proof/cli.ts");
const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const ev = (name) => path.join(work, "evidence", name);
const feature = (f) => path.join(src, ".kitchen/toolkit/features", f);

const rows = [];
function exec(label, cmd, args) {
  return new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      const secs = (Date.now() - t) / 1000;
      const lines = out.trim().split("\n");
      let json = null;
      try {
        json = JSON.parse(lines.at(-1));
      } catch {}
      const row = { label, cmd: [path.basename(cmd), ...args.map((a) => a.replace(work, "<work>").replace(repo, "<repo>"))].join(" "), exit: code, secs, stdoutLines: lines.length, json };
      rows.push(row);
      fs.appendFileSync(path.join(work, "spike.log"), `\n### ${label} (${secs}s, exit ${code})\n${err}\n${out}`);
      console.log(`${code === 0 ? "ok  " : "FAIL"} ${secs.toFixed(2).padStart(6)}s  ${label}  ${JSON.stringify(json).slice(0, 220)}`);
      resolve(row);
    });
  });
}
const tk = (label, ...args) => exec(label, dev, args);
const kc = (label, ...args) => exec(label, process.execPath, [kitchen, ...args]);
const drive = (label, id, file, evDir, round, criterion, ...args) =>
  kc(label, "drive", feature(file), "--id", id, "--src", src, "--evidence", evDir, "--sha", sha, "--round", String(round), "--criterion", criterion, ...args.flatMap((a) => ["--arg", a]));
const threeDrives = async (id, evDir, round) => [
  await drive(`drive settings.toggle-dark [${id} r${round}]`, id, "settings.md", evDir, round, "C1", "user=alice"),
  await drive(`drive projects.create [${id} r${round}]`, id, "projects.md", evDir, round, "C2", "user=alice", "slug=launch-plan"),
  await drive(`drive invites.generate-and-join [${id} r${round}]`, id, "invites.md", evDir, round, "C3", "admin=bob-admin"),
];
const portsOf = (row) => row.json.slot.ports.slice(0, 3).join(",");

const started = new Set();
try {
  if (cold) {
    const tag = JSON.parse(execFileSync(dev, ["prepare", "--src", path.join(repo, "fixtures/a-web")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).snapshot;
    execFileSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
  }
  await tk(`prepare${cold ? " (cold snapshot, fresh copy)" : " (fresh copy)"}`, "prepare", "--src", src);
  await tk("prepare (warm, again)", "prepare", "--src", src);
  await tk("describe", "describe", "--src", src);

  // --- one slot: up, doctor, drives, reset, drives again, down ---
  const s1 = await kc("slot acquire s1", "slot", "acquire", "--id", "s1", "--pid", String(process.pid), "--toolkit", dev);
  started.add("s1");
  await tk("up s1", "up", "--id", "s1", "--src", src, "--ports", portsOf(s1));
  await tk("doctor s1", "doctor", "--id", "s1");
  await threeDrives("s1", ev("s1"), 1);
  await tk("reset s1", "reset", "--id", "s1");
  await tk("doctor s1 (after reset)", "doctor", "--id", "s1");
  await threeDrives("s1", ev("s1"), 2);
  // negative controls: a missing primitive is a gap; an unmeetable wait fails after its retry
  const neg = (f) => path.join(repo, "spikes/w0/negative", f);
  await kc("drive negative.needs-sql [s1] (expect gap)", "drive", neg("needs-sql.md"), "--id", "s1", "--src", src, "--evidence", ev("s1-negative"), "--sha", sha, "--criterion", "N1");
  await kc("drive negative.wrong-text [s1] (expect FAIL)", "drive", neg("wrong-text.md"), "--id", "s1", "--src", src, "--evidence", ev("s1-negative"), "--sha", sha, "--criterion", "N2");
  await tk("down s1", "down", "--id", "s1");
  started.delete("s1");
  await kc("slot release s1", "slot", "release", "--id", "s1");
  await kc("verify manifest s1 (after down)", "verify", "--evidence", ev("s1"));
  const shots = fs.readdirSync(path.join(ev("s1"), "files"), { recursive: true }).filter((f) => f.endsWith(".png"));
  rows.push({ label: "evidence survives down", files: shots, entries: fs.readFileSync(path.join(ev("s1"), "manifest.jsonl"), "utf8").trim().split("\n").length });
  console.log(`evidence after down: ${shots.join(", ")}`);

  // --- two slots at once ---
  const a = await kc("slot acquire p1", "slot", "acquire", "--id", "p1", "--pid", String(process.pid), "--toolkit", dev);
  const b = await kc("slot acquire p2", "slot", "acquire", "--id", "p2", "--pid", String(process.pid), "--toolkit", dev);
  started.add("p1");
  started.add("p2");
  await Promise.all([tk("up p1 (parallel)", "up", "--id", "p1", "--src", src, "--ports", portsOf(a)), tk("up p2 (parallel)", "up", "--id", "p2", "--src", src, "--ports", portsOf(b))]);
  await tk("doctor p1", "doctor", "--id", "p1");
  await tk("doctor p2", "doctor", "--id", "p2");
  const ps = execFileSync("docker", ["ps", "--filter", "label=kitchen.toolkit=a-web", "--format", "{{.Names}} {{.Ports}}"], { encoding: "utf8" }).trim();
  rows.push({ label: "docker ps with two slots up", ps });
  console.log(ps);
  await Promise.all([
    drive("drive settings.toggle-dark [p1, concurrent]", "p1", "settings.md", ev("p1"), 1, "C1", "user=alice"),
    drive("drive settings.toggle-dark [p2, concurrent]", "p2", "settings.md", ev("p2"), 1, "C1", "user=alice"),
  ]);
  await Promise.all([
    drive("drive invites.generate-and-join [p1, concurrent]", "p1", "invites.md", ev("p1"), 1, "C3", "admin=bob-admin"),
    drive("drive projects.create [p2, concurrent]", "p2", "projects.md", ev("p2"), 1, "C2", "user=alice", "slug=launch-plan"),
  ]);
  await Promise.all([tk("down p1", "down", "--id", "p1"), tk("down p2", "down", "--id", "p2")]);
  started.delete("p1");
  started.delete("p2");
  await kc("slot release p1", "slot", "release", "--id", "p1");
  await kc("slot release p2", "slot", "release", "--id", "p2");

  // --- stale slot: owner pid is dead, its app is still up; the next acquire runs down, then reclaims ---
  const deadPid = spawn("true").pid;
  await new Promise((r) => setTimeout(r, 300));
  const o = await kc("slot acquire orphan (dead owner pid)", "slot", "acquire", "--id", "orphan", "--pid", String(deadPid), "--toolkit", dev);
  started.add("orphan");
  await tk("up orphan", "up", "--id", "orphan", "--src", src, "--ports", portsOf(o));
  await kc("slot acquire fresh (reclaims orphan)", "slot", "acquire", "--id", "fresh", "--pid", String(process.pid), "--toolkit", dev);
  const orphanLeft = execFileSync("docker", ["ps", "-a", "--filter", "label=kitchen.id=orphan", "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
  rows.push({ label: "orphan container after reclaim", left: orphanLeft || "none" });
  console.log(`orphan container after reclaim: ${orphanLeft || "none"}`);
  if (!orphanLeft) started.delete("orphan");
  await kc("slot release fresh", "slot", "release", "--id", "fresh");

  // --- integrity: hand-edit one manifest line ---
  const tamper = ev("tampered");
  fs.cpSync(ev("s1"), tamper, { recursive: true });
  await kc("verify copy before edit", "verify", "--evidence", tamper);
  const mf = path.join(tamper, "manifest.jsonl");
  const lines = fs.readFileSync(mf, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes('"ok":false'));
  const idx = i >= 0 ? i : 0;
  lines[idx] = i >= 0 ? lines[idx].replace('"ok":false', '"ok":true') : lines[idx].replace('"round":1', '"round":2');
  fs.writeFileSync(mf, lines.join("\n"));
  rows.push({ label: "hand edit", line: idx + 1, edit: i >= 0 ? 'ok:false → ok:true' : "round 1 → 2" });
  await kc("verify after hand edit", "verify", "--evidence", tamper);
} finally {
  for (const id of started) await tk(`cleanup down ${id}`, "down", "--id", id);
  const left = execFileSync("docker", ["ps", "-a", "--filter", "label=kitchen.toolkit=a-web", "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
  rows.push({ label: "containers left", left: left || "none" });
  console.log(`containers left: ${left || "none"}`);
  fs.writeFileSync(path.join(work, "results.json"), JSON.stringify(rows, null, 2));
}
