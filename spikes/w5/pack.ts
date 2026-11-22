// W5 release check: the npm tarball is clean and works from nowhere near the repo.
//   node spikes/w5/pack.ts [scratch]
// - `npm pack --dry-run --json`: only dist/*.js, roles/, skills/, toolkit-template/,
//   dashboard/dashboard.html, README.md, LICENSE, package.json; no fixtures, spikes, bench,
//   src, tests, source maps, .env files, node_modules; no secret-shaped string in any file.
// - `npm pack` builds the tarball (prepack: a fresh tsc build into dist/).
// - From an empty temp dir: `npx <tarball> --help`, `--version`; then the same package
//   installed into a temp prefix (nothing global touched): `kitchen --help`, `kitchen migrate
//   --dry-run` and `kitchen report` in a fresh git repo, `kitchen dashboard` answering on
//   127.0.0.1, and the package's own files the code needs at run time (roles, template, skill).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, finish, sleep } from "../w1/lib.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"), "pack");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const npm = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => spawnSync("npm", args, { cwd, env, encoding: "utf8", timeout: 600_000 });

const dry = npm(["pack", "--dry-run", "--json"], ROOT);
const files = (JSON.parse(dry.stdout) as { files: { path: string }[] }[])[0].files.map((f) => f.path);
const allowed = (f: string) =>
  /^dist\/.+\.js$/.test(f) || /^(roles|skills|toolkit-template)\//.test(f) || ["dashboard/dashboard.html", "README.md", "LICENSE", "package.json"].includes(f);
const stray = files.filter((f) => !allowed(f));
check(
  "npm pack --dry-run lists only the package's files",
  stray.length === 0 && files.length > 50,
  `${files.length} files${stray.length ? `; stray: ${stray.join(", ")}` : ""}`,
);
check(
  "no fixtures, spikes, bench, src, tests, maps, env files or node_modules",
  !files.some((f) => /(^|\/)(fixtures|spikes|bench\/|src\/|node_modules)|\.test\.js$|\.map$|(^|\/)\.env/.test(f) && !f.startsWith("dist/bench/")),
);
for (const need of [
  "dist/cli.js",
  "roles/retro.md",
  "roles/setup.md",
  "skills/kitchen/SKILL.md",
  "toolkit-template/bin/dev",
  "dashboard/dashboard.html",
  "LICENSE",
])
  check(`the package has ${need}`, files.includes(need));

const tgzName = npm(["pack", "--pack-destination", root], ROOT).stdout.trim().split("\n").pop() ?? "";
const tgz = path.join(root, tgzName);
check("npm pack built the tarball", tgzName === "devkitchen-0.1.0.tgz" && fs.existsSync(tgz), tgz);
const unpacked = path.join(root, "unpacked");
fs.mkdirSync(unpacked);
execFileSync("tar", ["-xzf", tgz, "-C", unpacked]);
const SECRET =
  /(sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const hits: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (SECRET.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(unpacked, p));
  }
};
walk(unpacked);
check("no secret-shaped string in the tarball", hits.length === 0, hits.join(", "));
const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, "package", "package.json"), "utf8")) as Record<string, unknown>;
check(
  "package.json: MIT, bin kitchen → dist/cli.js, engines node",
  pkg.license === "MIT" && (pkg.bin as Record<string, string>).kitchen === "dist/cli.js" && !!(pkg.engines as Record<string, string>).node,
);

// From an empty temp dir, through npx.
const empty = path.join(root, "empty");
fs.mkdirSync(empty);
fs.copyFileSync(tgz, path.join(empty, tgzName)); // npx takes a tarball as `./x.tgz`; an absolute path is run as a command
const cache = path.join(root, "npm-cache");
const env = { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false" };
const help = spawnSync("npx", ["--yes", `./${tgzName}`, "--help"], { cwd: empty, env, encoding: "utf8", timeout: 300_000 });
check(
  "npx ./devkitchen-0.1.0.tgz --help works from an empty dir",
  help.status === 0 && help.stdout.includes("kitchen ticket"),
  (help.stdout + help.stderr).split("\n")[0],
);
const ver = spawnSync("npx", ["--yes", `./${tgzName}`, "--version"], { cwd: empty, env, encoding: "utf8", timeout: 300_000 });
check("npx … --version says 0.1.0", ver.stdout.trim() === "0.1.0", ver.stdout.trim());

// Installed into a temp prefix.
const prefix = path.join(root, "prefix");
const inst = npm(["install", "-g", tgz], empty, { ...env, npm_config_prefix: prefix });
const bin = path.join(prefix, "bin", "kitchen");
check("npm install -g (temp prefix) puts kitchen on PATH", inst.status === 0 && fs.existsSync(bin), inst.stderr.split("\n").slice(-2).join(" "));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
fs.writeFileSync(path.join(repo, "kitchen.yaml"), "# mine\nconcurrency: 1\n");
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A"], { cwd: repo });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"], { cwd: repo });
const k = (...a: string[]) => spawnSync(bin, a, { cwd: repo, env: { ...env, KITCHEN_HOME: path.join(root, "home") }, encoding: "utf8", timeout: 60_000 });
const mig = k("migrate", "--dry-run");
check("installed: kitchen migrate --dry-run shows the version stamp", mig.status === 0 && mig.stdout.includes("+version: 1"), mig.stdout.split("\n")[0]);
const rep = k("report");
check("installed: kitchen report runs on an empty ledger", rep.status === 0 && rep.stdout.includes("merge-ready rate"), rep.stdout.split("\n")[0]);
const sk = k("init", "--skill");
check(
  "installed: kitchen init --skill writes the skill from the package",
  sk.status === 0 && fs.existsSync(path.join(repo, ".claude", "skills", "kitchen", "SKILL.md")),
  sk.stdout.trim().split("\n")[0],
);
const tk = k("ticket", "show the open count");
check("installed: kitchen ticket makes a job", tk.status === 0 && /ticket 001-/.test(tk.stdout), tk.stdout.trim());
const dash = spawn(bin, ["dashboard", "--port", "7394"], { cwd: repo, env: { ...env, KITCHEN_HOME: path.join(root, "home") }, stdio: "ignore" });
await sleep(1500);
try {
  const page = await (await fetch("http://127.0.0.1:7394/")).text();
  const data = (await (await fetch("http://127.0.0.1:7394/data.json")).json()) as { jobs: unknown[] };
  check("installed: kitchen dashboard serves the page and the board", page.includes("<title>Kitchen</title>") && data.jobs.length === 1);
} finally {
  dash.kill();
}
finish("w5 pack");
