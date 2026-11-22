// W2 review fixes, free (no model, no Docker): `kitchen toolkit check` refuses a
// broken Toolkit with a named reason, and still passes a correct one.
//  - the reviewer's fake bin/dev (ok to everything, logs on stdout, two describe
//    lines, an unimplemented `frobnicate`, url:"x", doctor checks:[]) fails;
//  - each of those faults alone fails at its step, with its reason;
//  - feature `paths` empty, or a glob that matches no tracked file, fails;
//  - the same fake without faults passes (the contract probe doesn't refuse a correct Toolkit).
//   node spikes/w2/probe.ts [scratch dir]
import fs from "node:fs";
import path from "node:path";
import { check, finish, git, HERE, kitchen, type Repo } from "./lib.ts";

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
finish("w2 probe");
