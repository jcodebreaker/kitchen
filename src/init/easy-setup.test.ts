// Easy setup (ADR 0011) apart from the preflight: Enter takes the recommended answer, --yes takes
// them all (never an agent's proposal), every answer is on disk the moment it is given and a re-run
// continues where it stopped, and the Toolkit build's heartbeat (agenda strip, live activity,
// throttled without a terminal). The agent is the fake adapter throughout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, test, vi } from "vitest";
import { w2 } from "../cli/toolkit-commands.ts";
import { loadConfig } from "../config.ts";
import { Halt, parseChoice, parseYesNo, terminalAsk, yesToAll } from "./ask.ts";
import { buildStoppedAt, readInitState, toolkitBuild } from "./build.ts";
import { agendaLine, beatOf, StatusLine } from "./heartbeat.ts";
import { answersFile, markStep, readResume, saveAnswer, startOver, stoppedAt } from "./resume.ts";

const KITCHEN = path.resolve(import.meta.dirname, "..", "..");
let root: string;
const prev = { home: process.env.KITCHEN_HOME };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-easy-"));
  process.env.KITCHEN_HOME = path.join(root, "home");
});
afterAll(() => {
  if (prev.home === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = prev.home;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

function repo(label: string, files: Record<string, string> | string, yaml?: string): string {
  const dir = path.join(root, label);
  if (typeof files === "string") fs.cpSync(path.join(KITCHEN, "fixtures", files), dir, { recursive: true });
  else
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
  if (yaml) fs.writeFileSync(path.join(dir, "kitchen.yaml"), yaml);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

/** A terminal fed these lines, then closed (Ctrl-D). */
function feed(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (d) => {
    shown += String(d);
  });
  let i = 0;
  // One line each time a prompt appears; then the end of input.
  const next = () => setImmediate(() => (i < lines.length ? input.write(`${lines[i++]}\n`) : input.end()));
  const ask = terminalAsk({ input, output });
  const wrap =
    <T extends unknown[], R>(f: (...a: T) => Promise<R>) =>
    (...a: T) => {
      const p = f(...a);
      next();
      return p;
    };
  return { ask: { ...ask, yesNo: wrap(ask.yesNo), choose: wrap(ask.choose), text: wrap(ask.text) }, shown: () => shown };
}

test("Enter takes the recommended answer: [Y/n], [y/N], a numbered list with the default marked, a default text", async () => {
  assert.equal(parseYesNo("", true), true);
  assert.equal(parseYesNo("", false), false);
  assert.equal(parseYesNo(" Y ", false), true);
  assert.equal(parseYesNo("no", true), false);
  assert.equal(parseYesNo("sure", true), undefined, "asked again");
  const opts = [
    { value: "claude", label: "claude" },
    { value: "codex", label: "codex" },
  ];
  assert.equal(parseChoice("", opts, 1), 1);
  assert.equal(parseChoice("1", opts, 1), 0);
  assert.equal(parseChoice("codex", opts, 0), 1);
  assert.equal(parseChoice("3", opts, 0), undefined);

  const t = feed(["", "", "", ""]);
  assert.equal(await t.ask.yesNo("Go on?", { recommended: true }), true);
  assert.equal(await t.ask.choose("Which agent?", opts, 1), "codex");
  assert.equal(await t.ask.text("Which data?", { default: "the sample tasks", why: "the tests read seed/" }), "the sample tasks");
  // Untrusted text: no is the recommendation whatever the caller says, and Enter takes it.
  assert.equal(await t.ask.yesNo("Use these checks?", { recommended: true, untrusted: true }), false);
  const shown = t.shown();
  assert.match(shown, /Go on\? \[Y\/n\] /);
  assert.match(shown, /Which agent\?\n {2}1\) claude\n {2}2\) codex {3}\(recommended\)\nChoose 1-2 \[2\]: /);
  assert.match(shown, /Enter = the sample tasks \(recommended\)/);
  assert.match(shown, /\(the tests read seed\/\)/);
  assert.match(shown, /Use these checks\? \[y\/N\] /);
});

test("a typed answer wins; a wrong one is asked again; Ctrl-D at a prompt is a halt, not an answer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (d) => {
    shown += String(d);
  });
  const p = terminalAsk({ input, output }).yesNo("Go on?", { recommended: true });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();
  input.write("maybe\n");
  await tick();
  input.write("n\n");
  assert.equal(await p, false);
  assert.match(shown, /Please answer y or n/);
  const done = feed([]);
  await assert.rejects(done.ask.text("Anything?", { default: "x" }), Halt);
});

test("--yes takes every recommended answer, and never an agent's proposal", async () => {
  const said: string[] = [];
  const y = yesToAll((l) => said.push(l));
  assert.equal(await y.yesNo("Go on?", { recommended: true }), true);
  assert.equal(await y.yesNo("Delete it?", { recommended: false }), false);
  assert.equal(await y.yesNo("Use these checks?", { recommended: true, untrusted: true }), false);
  assert.equal(await y.text("Which data?", { default: "seed" }), "seed");
  assert.match(said.join("\n"), /Use these checks\? \[y\/N\] no \(--yes never accepts what an agent proposed\)/);
});

const ODD = { "README.md": "Run ./ci.sh before pushing.\n", "ci.sh": "#!/bin/sh\ntouch ran-ci\necho ok\n" };

test("kitchen init --yes: proposed checks stay commented out (ADR 0010 R8), and the answer is on disk", async () => {
  const script = path.join(root, "propose.mjs");
  fs.writeFileSync(script, `export default () => ({ line: "1 check", file: "CHECK: ci | sh ci.sh\\nTEST_CMD: none\\n" });\n`);
  const dir = repo("odd-yes", ODD, `version: 1\nagent: { tool: fake, script: ${JSON.stringify(script)} }\n`);
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((l: string) => printed.push(String(l)));
  try {
    assert.equal(await w2("init", ["--yes", "--repo", dir]), 0, printed.join("\n"));
  } finally {
    log.mockRestore();
  }
  assert.match(printed.join("\n"), /Use these checks\? \[y\/N\] no \(--yes never accepts what an agent proposed\)/);
  assert.deepEqual(loadConfig(dir).checkList, []);
  assert.equal(fs.existsSync(path.join(dir, "ran-ci")), false);
  assert.equal(readResume(dir).init?.answers["use-proposed-checks"], "no");
  assert.equal(readResume(dir).init?.step, "done");
});

test("answers.json: each answer written the moment it is given; start over moves the old state to .bak and keeps the other command's", () => {
  const dir = path.join(root, "resume-unit");
  fs.mkdirSync(path.join(dir, ".kitchen", "init"), { recursive: true });
  markStep(dir, "init", "run");
  saveAnswer(dir, "init", "tool", "codex");
  saveAnswer(dir, "toolkit", "q:data", "empty");
  assert.equal(stoppedAt(dir, "init"), "run");
  assert.equal(JSON.parse(fs.readFileSync(answersFile(dir), "utf8")).init.answers.tool, "codex");
  const own = path.join(dir, ".kitchen", "init", "checks.json");
  fs.writeFileSync(own, "{}");
  assert.deepEqual(startOver(dir, "init", [own]), [".kitchen/init/answers.json", ".kitchen/init/checks.json"]);
  assert.equal(fs.existsSync(`${own}.bak`), true);
  assert.equal(fs.existsSync(own), false);
  assert.equal(JSON.parse(fs.readFileSync(`${answersFile(dir)}.bak`, "utf8")).init.answers.tool, "codex");
  assert.equal(readResume(dir).init, undefined);
  assert.equal(readResume(dir).toolkit?.answers["q:data"], "empty", "the Toolkit build's answers are kept");
  markStep(dir, "init", "done");
  assert.equal(stoppedAt(dir, "init"), null);
});

test("kitchen init that stopped at its checks: the re-run says where and continues there; --start-over moves the state to .bak", async () => {
  const dir = repo("failing", { "package.json": JSON.stringify({ scripts: { test: "exit 1" } }) }, "version: 1\nagent: { tool: fake }\n");
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((l: string) => printed.push(String(l)));
  try {
    assert.equal(await w2("init", ["--repo", dir]), 1);
    assert.match(printed.join("\n"), new RegExp(`test failed on your checkout[\\s\\S]*Resume: kitchen init --repo ${dir}`));
    assert.equal(stoppedAt(dir, "init"), "run");
    printed.splice(0);
    assert.equal(await w2("init", ["--repo", dir]), 1);
    assert.match(
      printed.join("\n"),
      /kitchen init stopped last time at: running the checks\.\nContinuing at running the checks \(kitchen init --start-over begins again\)\./,
    );
    printed.splice(0);
    assert.equal(await w2("init", ["--repo", dir, "--start-over"]), 1);
    assert.match(printed.join("\n"), /Starting over: \.kitchen\/init\/answers\.json → \.kitchen\/init\/answers\.json\.bak, \.kitchen\/init\/checks\.json → /);
    assert.ok(fs.existsSync(path.join(dir, ".kitchen", "init", "checks.json.bak")));
  } finally {
    log.mockRestore();
  }
});

/** A setup script with two questions; each call writes a little live activity to the stream first. */
const SETUP_SCRIPT = (toolkits: string) => `import fs from "node:fs";
import path from "node:path";
const from = ${JSON.stringify(toolkits)};
const ev = (req, o) => { if (req.streamFile) { fs.mkdirSync(path.dirname(req.streamFile), { recursive: true }); fs.appendFileSync(req.streamFile, JSON.stringify(o) + "\\n"); } };
export default async (req) => {
  ev(req, { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: path.join(req.cwd, ".kitchen/toolkit/features/books.md"), content: "a\\nb" } }] } });
  await new Promise((r) => setTimeout(r, 1300));
  if (req.outFile === "survey.md")
    return { line: "survey", file: 'Surface: api\\n\`\`\`json\\n[{"id":"data","question":"Seed the sample books?","why":"seed/ has them","default":"yes, the samples"},{"id":"port","question":"Which port?","default":"3000"}]\\n\`\`\`\\n' };
  fs.cpSync(path.join(from, "toolkit"), path.join(req.cwd, ".kitchen", "toolkit"), { recursive: true });
  fs.copyFileSync(path.join(from, "env.kitchen"), path.join(req.cwd, ".env.kitchen"));
  return { line: "built", file: "STATUS: READY\\nSURFACE: api\\n" };
};
`;

test("toolkit build: the agenda strip, a heartbeat from the agent's stream, questions with Enter = default; a stop half way asks only the rest", async () => {
  const script = path.join(root, "setup-q.mjs");
  fs.writeFileSync(script, SETUP_SCRIPT(path.join(KITCHEN, "bench", "toolkits", "e-library")));
  const dir = repo("tk", "e-library", `version: 1\nagent: { tool: fake, script: ${JSON.stringify(script)} }\n`);
  const lines: string[] = [];
  const beats: string[] = [];
  const out = { phase: (l: string) => lines.push(l), log: () => {}, agenda: (l: string) => lines.push(`AGENDA ${l}`), beat: (t: string) => beats.push(t) };
  // The person answers the first question, then presses Ctrl-D at the second.
  const t = feed(["", ""]);
  const stopAtSecond = { ...t.ask, text: async (q: string, o: { default: string }) => (q.includes("port") ? Promise.reject(new Halt()) : t.ask.text(q, o)) };
  await assert.rejects(toolkitBuild({ repo: dir, generateOnly: true, ask: stopAtSecond }, out), Halt);
  assert.deepEqual(
    lines.filter((l) => l.startsWith("AGENDA")),
    ["AGENDA ▸ Read the repo · Writing the Toolkit · Prove it"],
  );
  assert.ok(beats.includes("writing .kitchen/toolkit/features/books.md"), beats.join(" | "));
  assert.ok(beats[0]?.startsWith("starting the fake agent"), beats.join(" | "));
  assert.equal(readResume(dir).toolkit?.answers["q:data"], "yes, the samples", "Enter took the default, saved at once");
  assert.equal(readResume(dir).toolkit?.answers["q:port"], undefined);
  assert.equal(buildStoppedAt(readInitState(dir)), "your answers to its questions");

  // Again, with --yes: it says where it stopped, asks only the second question, and goes on to the end.
  lines.splice(0);
  const said: string[] = [];
  assert.equal(await toolkitBuild({ repo: dir, generateOnly: true, ask: yesToAll((l) => said.push(l)) }, out), 0, lines.join("\n"));
  assert.deepEqual(lines.slice(0, 2), ["Teaching Kitchen to run tk…", "kitchen toolkit build stopped last time at: your answers to its questions."]);
  assert.deepEqual(said, [
    "Continue there, or start over? Continue at your answers to its questions, keeping every finished step (--yes)",
    "Which port? 3000 (--yes)",
  ]);
  assert.deepEqual(readInitState(dir)?.steps.answers, { data: "yes, the samples", port: "3000" });
  assert.deepEqual(
    lines.filter((l) => l.startsWith("AGENDA")),
    ["AGENDA ✓ Read the repo · ▸ Writing the Toolkit · Prove it"],
  );
  assert.equal(readResume(dir).toolkit?.step, "Writing the Toolkit", "a --generate-only build doesn't count as done");
});

test("toolkit build without a terminal or --yes: the questions go to a file, exit 3, and the line that resumes it", async () => {
  const script = path.join(root, "setup-q2.mjs");
  fs.writeFileSync(script, SETUP_SCRIPT(path.join(KITCHEN, "bench", "toolkits", "e-library")));
  const dir = repo("tk-file", "e-library", `version: 1\nagent: { tool: fake, script: ${JSON.stringify(script)} }\n`);
  const lines: string[] = [];
  assert.equal(await toolkitBuild({ repo: dir, generateOnly: true, resume: "kitchen toolkit build" }, { phase: (l) => lines.push(l), log: () => {} }), 3);
  assert.equal(lines.at(-1), "Resume: kitchen toolkit build --answers <file>");
});

test("heartbeat lines: agenda strip, what each agent event says, and the throttle with and without a terminal", () => {
  assert.equal(agendaLine(["Read the repo", "Writing the Toolkit", "Prove it"], 1), "✓ Read the repo · ▸ Writing the Toolkit · Prove it");
  assert.equal(beatOf({ c: "tool", t: "Write", vb: "Write", tg: "features/loans.md" }), "writing features/loans.md");
  assert.equal(beatOf({ c: "tool", t: "x", vb: "Bash", tg: "npm test" }), "running npm test");
  assert.equal(beatOf({ c: "tool", t: "x", vb: "Kitchen", tg: "toolkit_check books" }), "running toolkit check");
  assert.equal(beatOf({ c: "res", t: "ok" }), null);

  // No terminal: nothing appended for 10 s, then one line; the same activity again is "still …".
  let now = 0;
  const w: string[] = [];
  const pipe = new StatusLine({ tty: false, write: (s) => w.push(s), now: () => now });
  pipe.line("Teaching Kitchen to run x…");
  for (let s = 1; s <= 9; s++) {
    now = s * 1000;
    pipe.beat(`editing f${s}.md`);
    pipe.tick();
  }
  assert.deepEqual(w, ["Teaching Kitchen to run x…\n"], "quiet: no line in the first 10 s");
  now = 10_000;
  pipe.tick();
  assert.deepEqual(w.slice(1), ["  … editing f9.md · 10s\n"]);
  now = 15_000;
  pipe.tick();
  assert.equal(w.length, 2, "at most one line per 10 s");
  now = 20_000;
  pipe.tick();
  assert.equal(w.at(-1), "  … still editing f9.md · 20s\n");
  now = 24_000;
  pipe.beat("running npm test");
  assert.equal(w.length, 3);
  now = 30_000;
  pipe.beat("running npm test again");
  assert.equal(w.at(-1), "  … running npm test again · 30s\n", "never silent for more than 10 s");

  // A terminal: one status line, rewritten in place, cleared for every real line and drawn again after it.
  now = 0;
  const t: string[] = [];
  const term = new StatusLine({ tty: true, write: (s) => t.push(s), now: () => now, cols: 80 });
  term.beat("reading package.json");
  assert.deepEqual(t, ["\r\x1b[2K  … reading package.json · 0.0s"]);
  now = 100;
  term.beat("reading README.md");
  assert.equal(t.length, 1, "redraws at most every 200 ms");
  now = 1000;
  term.tick();
  assert.equal(t.at(-1), "\r\x1b[2K  … reading README.md · 1.0s");
  term.line("  ✓ Read the repo");
  assert.deepEqual(t.slice(-3), ["\r\x1b[2K", "  ✓ Read the repo\n", "\r\x1b[2K  … reading README.md · 1.0s"]);
  term.restart();
  term.tick();
  assert.equal(t.at(-1), "\r\x1b[2K", "a new phase clears the old heartbeat");
  term.beat("x".repeat(200));
  assert.ok((t.at(-1) ?? "").length <= 80 + 5, "one row");
});
