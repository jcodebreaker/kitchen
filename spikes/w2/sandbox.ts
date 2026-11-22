// W2 review fix (ADR 0008): bin/dev that the setup bridge runs is confined by
// macOS sandbox-exec. A planted bin/dev that tries `cat ~/.ssh/*`, the gh and
// agent auth dirs and `cat $KITCHEN_HOME/engine.key` is denied every one (the
// same reads succeed unsandboxed, so the test means something); a normal
// Toolkit (fixture A's) still passes the full `toolkit_check` through the bridge,
// Docker included. Nothing secret is printed: the planted script reports only
// whether each read worked.
//   node spikes/w2/sandbox.ts [scratch dir]          (macOS; Docker: one app stack, two at the parallel step)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish, fixtureRepo, HERE, ourContainers } from "./lib.ts";

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
