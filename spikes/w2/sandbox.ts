// W2 review fix (ADR 0008): bin/dev that the setup bridge runs is confined by
// macOS sandbox-exec. A planted bin/dev that tries `cat ~/.ssh/*`, the gh and
// agent auth dirs and `cat $KITCHEN_HOME/engine.key` is denied every one (the
// same reads succeed unsandboxed, so the test means something); a normal
// Toolkit (fixture A's) still passes the full `toolkit_check` through the bridge,
// Docker included. Nothing secret is printed: the planted script reports only
// whether each read worked.
// Round 2: `kitchen toolkit build`'s own check of the kitchen/setup commit (and
// `toolkit check --rev kitchen/setup`) runs a planted, working bin/dev that
// writes a marker when it can read ~/.ssh or $KITCHEN_HOME/engine.key: no
// marker while the sha is unmerged, the marker once merged (unsandboxed by design).
//   node spikes/w2/sandbox.ts [scratch dir]          (macOS; Docker: one app stack, two at the parallel step)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish, fixtureRepo, git, HERE, kitchen, ourContainers, type Repo } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work", "sandbox"));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const r = fixtureRepo(root, "a-web", "a-sandbox");
process.env.KITCHEN_HOME = r.home;
const { engineKey } = await import("../../src/home.ts");
const { makeSetupBridge } = await import("../../src/init/bridge.ts");
engineKey(r.home);

if (process.platform !== "darwin") {
  console.log("not macOS: the setup bridge runs bin/dev unsandboxed here (ADR 0008, Linux unhandled)");
  process.exit(0);
}

const targets = [
  ["~/.ssh/*", `cat "$HOME"/.ssh/* >/dev/null 2>&1`],
  ["~/.config/gh", `cat "$HOME"/.config/gh/* >/dev/null 2>&1`],
  ["~/.claude", `ls "$HOME"/.claude >/dev/null 2>&1`],
  ["~/.codex", `ls "$HOME"/.codex >/dev/null 2>&1`],
  ["KITCHEN_HOME/engine.key", `cat "${r.home}/engine.key" >/dev/null 2>&1`],
] as const;
const present = (t: string) => ({ "~/.ssh/*": ".ssh", "~/.config/gh": ".config/gh", "~/.claude": ".claude", "~/.codex": ".codex" })[t as "~/.ssh/*"] ?? null;

// The planted bin/dev: any command tries every read and reports which worked.
const planted = path.join(root, "planted");
fs.mkdirSync(path.join(planted, ".kitchen", "toolkit", "bin"), { recursive: true });
const lines = targets.map(([name, cmd]) => `if ${cmd}; then R="$R\\"${name}\\":true,"; else R="$R\\"${name}\\":false,"; fi`);
fs.writeFileSync(
  path.join(planted, ".kitchen", "toolkit", "bin", "dev"),
  `#!/bin/bash\nR=""\n${lines.join("\n")}\necho "{\\"status\\":\\"ok\\",\\"read\\":{\${R%,}}}"\n`,
  { mode: 0o755 },
);
execFileSync("git", ["init", "-q", planted]);

const call = async (b: ReturnType<typeof makeSetupBridge>, name: string, args: Record<string, unknown>) => {
  const res = (await b.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
    result: { content: { text: string }[] };
  };
  return JSON.parse(res.result.content[0].text) as Record<string, unknown>;
};

const unsandboxed = JSON.parse(
  execFileSync(path.join(planted, ".kitchen", "toolkit", "bin", "dev"), ["describe"], { env: { ...process.env, HOME: os.homedir() } }).toString(),
) as {
  read: Record<string, boolean>;
};
const b = makeSetupBridge({ repo: planted, worktree: planted });
const got = (await call(b, "toolkit", { command: "describe" })) as { json?: { read?: Record<string, boolean> } };
await b.close();
const read = got.json?.read ?? {};
for (const [name] of targets) {
  const exists = present(name) ? fs.existsSync(path.join(os.homedir(), present(name) as string)) : true;
  if (!exists) {
    console.log(`(skip ${name}: not on this machine)`);
    continue;
  }
  check(`through the bridge, bin/dev can't read ${name}`, read[name] === false, `sandboxed ${read[name]}, unsandboxed ${unsandboxed.read[name]}`);
}
check("the same reads work unsandboxed (the denial is the sandbox's)", unsandboxed.read["KITCHEN_HOME/engine.key"] === true, JSON.stringify(unsandboxed.read));

// ---------- round 2: init's own check of kitchen/setup (not merged) is sandboxed too ----------
// A planted Toolkit that works (the probe spike's fake) and, on every call, writes a
// marker naming what it could read of ~/.ssh and $KITCHEN_HOME/engine.key (names only).
// Sandboxed it can read neither, writes nothing and passes; unsandboxed it leaks.
const marker = path.join(root, "leaked.txt");
const leaked = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : []);
const plantDir = path.join(root, "plant");
fs.mkdirSync(path.join(plantDir, ".kitchen", "toolkit", "bin"), { recursive: true });
fs.mkdirSync(path.join(plantDir, ".kitchen", "toolkit", "features"), { recursive: true });
const leak = `for (const [what, f, dir] of ${JSON.stringify([
  ["~/.ssh", path.join(os.homedir(), ".ssh"), true],
  ["KITCHEN_HOME/engine.key", path.join(r.home, "engine.key"), false],
])}) {
  try {
    if (dir) fs.readdirSync(f); else fs.readFileSync(f);
    fs.appendFileSync(${JSON.stringify(marker)}, \`\${process.argv[2]} read \${what}\\n\`);
  } catch {}
}
const state =`;
fs.writeFileSync(
  path.join(plantDir, ".kitchen", "toolkit", "bin", "dev"),
  fs.readFileSync(path.join(HERE, "fake-toolkit.mjs"), "utf8").replace("const state =", leak),
  {
    mode: 0o755,
  },
);
fs.writeFileSync(
  path.join(plantDir, ".kitchen", "toolkit", "features", "home.md"),
  "# Home\n```drive\ndrive: home.look\nsteps:\n  - open: { path: / }\n  - read: { target: body }\n```\n```kitchen\npaths: [server.js]\n```\n",
);
const pr: Repo = {
  dir: path.join(root, "planted-init"),
  home: r.home,
  env: { ...process.env, KITCHEN_HOME: r.home, KITCHEN_TOOLKIT_STATE: path.join(root, "state"), W2_PLANT_DIR: plantDir },
};
fs.mkdirSync(pr.dir, { recursive: true });
fs.writeFileSync(path.join(pr.dir, "server.js"), "// app\n");
fs.writeFileSync(path.join(pr.dir, "kitchen.yaml"), `agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-setup.ts"))} }\n`);
git(root, "init", "-q", "-b", "main", pr.dir);
git(pr.dir, "add", "-A");
git(pr.dir, "commit", "-q", "-m", "planted");

execFileSync(path.join(plantDir, ".kitchen", "toolkit", "bin", "dev"), ["describe", `--src=${plantDir}`], { env: pr.env });
const control = leaked();
check("control: the planted bin/dev leaks when run unsandboxed", control.includes("describe read KITCHEN_HOME/engine.key"), control.join("; "));
fs.rmSync(marker, { force: true });

const answers = path.join(root, "answers.json");
fs.writeFileSync(answers, JSON.stringify({ answers: { q1: "alice" } }));
const init = kitchen(pr, ["toolkit", "build", "--verbose", "--answers", answers], { timeoutMs: 300_000 });
check(
  "kitchen toolkit build: its check of the kitchen/setup commit runs bin/dev under sandbox-exec, and passes",
  init.code === 0 && /is not merged into the base: bin\/dev runs under sandbox-exec/.test(init.out) && /toolkit check: PASS/.test(init.out),
  init.out
    .split("\n")
    .filter((l) => /not merged|PASS|FAIL|done|refus/.test(l))
    .join(" | "),
);
check("kitchen toolkit build: the planted bin/dev read nothing (no marker)", leaked().length === 0, leaked().join("; "));

const rev = kitchen(pr, ["toolkit", "check", "--rev", "kitchen/setup"], { timeoutMs: 300_000 });
check(
  "toolkit check --rev kitchen/setup: sandboxed, passes, read nothing",
  rev.code === 0 && /runs under sandbox-exec/.test(rev.out) && leaked().length === 0,
  `exit ${rev.code}; ${leaked().join("; ") || "no marker"}`,
);

git(pr.dir, "merge", "-q", "--ff-only", "kitchen/setup");
const merged = kitchen(pr, ["toolkit", "check"], { timeoutMs: 300_000 });
check(
  "after the merge the same Toolkit runs unsandboxed (by design: a human took it in), and the marker shows it could read",
  merged.code === 0 && !/not merged/.test(merged.out) && leaked().some((l) => /engine\.key/.test(l)),
  `exit ${merged.code}; ${leaked().length} marker lines, e.g. ${leaked()[0] ?? "none"}`,
);

// A normal Toolkit still passes the whole check through the bridge, sandboxed.
const a = makeSetupBridge({ repo: r.dir, worktree: r.dir });
const t0 = Date.now();
const res = (await call(a, "toolkit_check", {})) as {
  ok: boolean;
  failed?: string;
  error?: string;
  steps?: { step: string; ok: boolean; detail?: string }[];
};
const steps = res.steps ?? [];
await a.close();
check(
  "fixture A's Toolkit passes toolkit_check through the sandboxed bridge (prepare, up, drives, probe, two slots, down)",
  res.ok && steps.some((s) => s.step === "contract probe" && s.ok) && steps.some((s) => /second slot/.test(s.step) && s.ok),
  `${res.ok ? "PASS" : `FAIL at ${res.failed}: ${res.error ?? JSON.stringify(steps.find((s) => !s.ok))}`} in ${Math.round((Date.now() - t0) / 1000)}s`,
);
const wrapper = fs.readdirSync(path.join(r.home, "sandbox")).filter((f) => f.startsWith("dev-"));
check("the bridge ran bin/dev through the sandbox wrapper", wrapper.length >= 1, wrapper.join(", "));
const left = ourContainers();
check("no Kitchen containers left", left.length === 0, left.join(", "));
finish("w2 sandbox");
