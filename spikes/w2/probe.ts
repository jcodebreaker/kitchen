// W2 review fixes, free (no model, no Docker): `kitchen toolkit check` refuses a
// broken Toolkit with a named reason, and still passes a correct one.
//  - the reviewer's fake bin/dev (ok to everything, logs on stdout, two describe
//    lines, an unimplemented `frobnicate`, url:"x", doctor checks:[]) fails;
//  - each of those faults alone fails at its step, with its reason;
//  - feature `paths` empty, or a glob that matches no tracked file, fails;
//  - the same fake without faults passes (the contract probe doesn't refuse a correct Toolkit).
//   node spikes/w2/probe.ts [scratch dir]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLI, check, finish, git, HERE, kitchen, type Repo } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work", "probe"));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const FAKE = fs.readFileSync(path.join(HERE, "fake-toolkit.mjs"), "utf8");

const FEATURE = (paths: string) => `# Home
\`\`\`drive
drive: home.look
steps:
  - open: { path: / }
  - read: { target: body }
\`\`\`
\`\`\`kitchen
paths: ${paths}
\`\`\`
`;

function repo(label: string, faults: string[], paths = '[server.js, "lib/**"]'): Repo {
  const dir = path.join(root, label);
  fs.mkdirSync(path.join(dir, ".kitchen", "toolkit", "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".kitchen", "toolkit", "features"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "server.js"), "// app\n");
  fs.writeFileSync(path.join(dir, "lib", "a.js"), "// lib\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".kitchen/checks/\n.kitchen/toolkit.proven\n.kitchen/toolkit-checkouts/\n.worktrees/\n");
  const bin = path.join(dir, ".kitchen", "toolkit", "bin", "dev");
  fs.writeFileSync(bin, FAKE.replace("const FAULTS = new Set([]);", `const FAULTS = new Set(${JSON.stringify(faults)});`));
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(path.join(dir, ".kitchen", "toolkit", "features", "home.md"), FEATURE(paths));
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", label);
  const home = path.join(root, "kitchen-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return { dir, home, env: { ...process.env, KITCHEN_HOME: home, KITCHEN_TOOLKIT_STATE: path.join(root, "state") } };
}

const run = (label: string, faults: string[], paths?: string) => {
  const r = repo(label, faults, paths);
  const x = kitchen(r, ["toolkit", "check"], { timeoutMs: 120_000 });
  const fail = /FAIL at (.+) in/.exec(x.out)?.[1] ?? null;
  const reason = x.out.split("\n").find((l) => / FAIL /.test(l)) ?? "";
  return { code: x.code, fail, reason: reason.trim(), out: x.out };
};

const clean = run("clean", []);
check(
  "the fake without faults passes (probe included)",
  clean.code === 0 && /contract probe ok/.test(clean.out),
  clean.out
    .split("\n")
    .filter((l) => /probe|PASS|FAIL/.test(l))
    .join(" | "),
);

const all = run("reviewer", ["okAll", "stdoutLogs", "twoDescribe", "frobnicate", "badUrl", "noChecks"]);
check("the reviewer's fake bin/dev fails", all.code === 1 && all.fail === "describe", all.reason);

const cases: [string, string[], string, RegExp, string?][] = [
  ["stdout-logs", ["stdoutLogs"], "describe", /describe printed 2 lines on stdout/],
  ["two-describe", ["twoDescribe"], "describe", /describe printed 2 lines on stdout/],
  ["bad-url", ["badUrl"], "up", /url "x" is not an absolute URL/],
  ["no-checks", ["noChecks"], "doctor", /doctor must run at least one check/],
  ["frobnicate", ["frobnicate"], "contract probe", /frobnicate \{\}: not a primitive answer.*is frobnicate implemented/],
  ["ok-to-everything", ["okAll"], "contract probe", /read of a missing target is ok:false, but .*answered ok:true/],
  ["empty-paths", [], "features", /no paths/, "[]"],
  ["typo-glob", [], "features", /paths "srver\.js" match no tracked file/, '[srver.js, "lib/**"]'],
];
for (const [label, faults, at, why, paths] of cases) {
  const r = run(label, faults, paths);
  check(`${label}: fails at ${at}, named`, r.code === 1 && r.fail === at && why.test(r.reason), `${r.fail}: ${r.reason.slice(0, 260)}`);
}
const ok = run("ok-to-everything-2", ["okAll"]);
check(
  "ok-to-everything: every refusal is named (missing read, both foreign origins on open and http, duplicated flag)",
  /missing target/.test(ok.reason) && (ok.reason.match(/another origin/g) ?? []).length === 4 && /flag given twice \(--id\) is refused/.test(ok.reason),
  ok.reason.slice(0, 400),
);

// `kitchen toolkit up` (foreground, Ctrl-C brings it down) and `toolkit down --id` (a slot left by kill -9).
const cleanRepo = repo("up-down", []);
const slots = () => (JSON.parse(fs.readFileSync(path.join(cleanRepo.home, "slots.json"), "utf8")) as { slots: { id: string }[] }).slots.map((s) => s.id);
const upUntilReady = () =>
  new Promise<{ p: ReturnType<typeof spawn>; id: string; out: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, "toolkit", "up", "--repo", cleanRepo.dir], { env: cleanRepo.env });
    let out = "";
    p.stdout?.on("data", (b) => {
      out += b;
      const m = /down --id (\S+)\)/.exec(out);
      if (m) resolve({ p, id: m[1], out });
    });
    p.on("exit", () => reject(new Error(out)));
  });
const a = await upUntilReady();
check(
  "toolkit up: one instance, its url printed, its slot held",
  /ready at http:\/\/127\.0\.0\.1:\d+/.test(a.out) && slots().includes(a.id),
  a.out.split("\n")[1],
);
a.p.kill("SIGINT");
const code = await new Promise((r) => a.p.once("exit", (c) => r(c)));
check("Ctrl-C: down ran, the slot is freed, exit 0", code === 0 && !slots().includes(a.id), `exit ${code}, slots ${slots().join(",") || "none"}`);
const b = await upUntilReady();
b.p.kill("SIGKILL");
await new Promise((r) => b.p.once("exit", r));
const d = kitchen(cleanRepo, ["toolkit", "down", "--id", b.id]);
check(
  "kill -9 leaves the slot; toolkit down --id stops it and frees it",
  d.code === 0 && /stopped and its slot freed/.test(d.out) && !slots().includes(b.id),
  d.out.trim(),
);
finish("w2 probe");
