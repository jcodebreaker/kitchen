// W4 exit: `kitchen toolkit maintain` on a copy of fixture A whose app renamed a
// selector the settings feature file still drives (`nav-settings` → `nav-preferences`).
//   node spikes/w4/maintain.ts <scratch>
// Part 1, REAL agents (Claude: haiku source readers, sonnet fixer): the source wave flags
//   settings.md, the live pass fails on its drive, the fixer edits only the Toolkit, the
//   engine's full check passes on the fix commit, and one PR is opened (local forge).
// Part 2, scripted agent (no model): the churn trigger. After the PR is merged, a commit
//   that changes feature-mapped paths by more than `maintain_churn_lines` makes
//   `kitchen run` start maintain by itself (outcome clean); below the threshold it doesn't.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readLocalForge } from "../../src/forge/forge.ts";
import { CLAUDE_BIN, check, finish, kitchen, kitchenContainers, ledger, makeFixtureRepo } from "../w3a/lib.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work"));
fs.mkdirSync(root, { recursive: true });
const yaml = (agent: string, churn = 300) => `concurrency: 3
agent: ${agent}
checks:
  - { name: syntax, run: "node --check server.js" }
maintain_churn_lines: ${churn}
`;
const CLAUDE = `{ tool: claude, command: [${JSON.stringify(CLAUDE_BIN)}], models: { strong: sonnet, medium: haiku }, timeout_sec: 1800, max_turns: 80 }`;
const r = makeFixtureRepo(root, "w4-maintain", { yaml: yaml(CLAUDE) });
const git = (...a: string[]) =>
  execFileSync("git", ["-C", r.dir, "-c", "user.name=spike", "-c", "user.email=s@example.invalid", ...a], { encoding: "utf8" }).trim();
const log = path.join(root, "w4-maintain.log");
// Containers of other runs on this machine (labelled the same) are not ours to count.
const before = new Set(kitchenContainers());
const ours = () => kitchenContainers().filter((c) => !before.has(c));

// The app changes; the Toolkit's settings feature file doesn't.
const server = path.join(r.dir, "server.js");
fs.writeFileSync(server, fs.readFileSync(server, "utf8").replace('data-testid="nav-settings"', 'data-testid="nav-preferences"'));
git("commit", "-qam", "app: the settings link's test id is nav-preferences");
const base = git("rev-parse", "HEAD");

const t0 = Date.now();
const m = kitchen(r, ["toolkit", "maintain"], 90 * 60_000);
fs.writeFileSync(log, m.out);
const secs = Math.round((Date.now() - t0) / 1000);
const st = JSON.parse(fs.readFileSync(path.join(r.dir, ".kitchen", "maintain.json"), "utf8")) as {
  sha: string;
  outcome: string;
  why?: string;
  features: { file: string; drift: boolean; live: string }[];
  branch?: string;
  commit?: string;
  pr?: number;
  fixes: number;
  usd: number;
};
for (const l of m.out.split("\n").filter((x) => /^maintain:/.test(x))) console.log(`    ${l}`);
check("maintain: outcome changed (one PR of proven fixes)", st.outcome === "changed" && m.code === 0, `${st.outcome}${st.why ? `: ${st.why}` : ""}`);
const settings = st.features.find((f) => f.file === "settings.md");
check("source wave: the settings reader reports drift", settings?.drift === true, JSON.stringify(st.features));
check("live pass: the base's check fails on the settings drive", /drive settings\.toggle-dark FAIL/.test(m.out) && settings?.live === "failed");
const changed = st.commit ? git("diff", "--name-only", base, st.commit).split("\n").filter(Boolean) : [];
check(
  "the fix commit changes only Toolkit files, settings.md among them",
  changed.length > 0 && changed.every((f) => f.startsWith(".kitchen/toolkit/")) && changed.includes(".kitchen/toolkit/features/settings.md"),
  changed.join(", "),
);
const fixed = st.commit ? git("show", `${st.commit}:.kitchen/toolkit/features/settings.md`) : "";
check("settings.md drives nav-preferences now", /nav-preferences/.test(fixed) && !/data-testid=nav-settings\]/.test(fixed));
check(
  "the engine's full check passed on the fix commit (sandboxed: unmerged)",
  /toolkit check: evidence ok/.test(m.out.split("full check on it")[1] ?? "") && /sandbox-exec/.test(m.out.split("full check on it")[1] ?? ""),
);
const prs = readLocalForge(r.dir).filter((x) => x.kind === "pr");
check(
  "one Toolkit PR through the forge (local)",
  prs.length === 1 && prs[0].branch === st.branch && prs[0].head === st.commit && st.pr === 1,
  JSON.stringify(prs.map((p) => ({ n: p.n, branch: p.branch, title: p.title }))),
);
check("main is untouched: the PR is a branch", git("rev-parse", "HEAD") === base);
const agents = ledger(r).filter((l) => l.stage === "maintain" && l.event === "agent");
console.log(`    agents: ${agents.map((a) => `${a.role} ${a.model} ${Math.round(a.secs ?? 0)}s $${(a.usd ?? 0).toFixed(3)}`).join("; ")}`);
console.log(`    maintain: ${secs}s wall, $${st.usd.toFixed(3)}`);
check("the source wave ran one reader per feature file, at once", agents.filter((a) => a.role === "maintain-source").length === st.features.length);
check("no container left running after maintain", ours().length === 0, ours().join(" "));

// Part 2: the trigger, scripted (the fixes are merged first, as a person would).
git("merge", "-q", "--ff-only", st.branch as string);
const SCRIPT = path.join(HERE, "maintain-fake.ts");
fs.writeFileSync(path.join(r.dir, "kitchen.yaml"), yaml(`{ tool: fake, script: ${JSON.stringify(SCRIPT)} }`, 30));
git("commit", "-qam", "kitchen.yaml: scripted agent, churn 30");
// baseline: maintain.json says the last maintain ran on `base`; the merge + yaml add little churn in mapped paths.
const due0 = kitchen(r, ["run", "--once"]);
check(
  "below the churn threshold: kitchen run does not start maintain",
  !/kitchen toolkit maintain/.test(due0.out),
  due0.out.split("\n").find((l) => l.startsWith("toolkit:")),
);
const extra = Array.from({ length: 40 }, (_, i) => `// churn ${i}`).join("\n");
fs.appendFileSync(server, `\n${extra}\n`);
git("commit", "-qam", "app: 40 lines of churn in server.js (mapped by every feature)");
const due1 = kitchen(r, ["run", "--once"], 30 * 60_000);
fs.appendFileSync(log, due1.out);
const st2 = JSON.parse(fs.readFileSync(path.join(r.dir, ".kitchen", "maintain.json"), "utf8")) as { sha: string; outcome: string; trigger: string };
check(
  "over the threshold: kitchen run starts maintain by itself (scripted readers, live pass on the merged Toolkit: clean)",
  /lines changed in feature-mapped paths/.test(due1.out) &&
    st2.outcome === "clean" &&
    st2.sha === git("rev-parse", "HEAD") &&
    /^churn \d+ lines/.test(st2.trigger),
  `${st2.outcome} ${st2.trigger}`,
);
const due2 = kitchen(r, ["run", "--once"]);
check("once per base: the next run doesn't start it again", !/kitchen toolkit maintain/.test(due2.out));
check("no kitchen container left running", ours().length === 0, ours().join(" "));
finish("w4 maintain");
