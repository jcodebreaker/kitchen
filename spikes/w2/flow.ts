// W2 exit checks that need no model (scripted setup role, real Toolkit, real Docker):
//  1. `kitchen init` without a TTY: survey asks a question → setup-questions.json, exit 3;
//     `init --answers` resumes (survey not re-run, the answer reaches the build prompt),
//     commits on kitchen/setup, `toolkit check` passes, toolkit.proven written; a third
//     `init` does nothing new.
//  2. Base-change re-proof on the next `kitchen run`: no change → nothing; a README change →
//     doctor + smoke drive; a Toolkit-mapped path → full check; a broken Toolkit → queue
//     paused + one Toolkit ticket, the queued job untouched, stays paused on the next run;
//     fixed → re-proven, queue runs again.
//   node spikes/w2/flow.ts [scratch dir]
import fs from "node:fs";
import path from "node:path";
import { check, finish, fixtureRepo, git, HERE, kitchen, ourContainers, readJson } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work", "flow"));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const fakeLog = path.join(root, "fake-calls.jsonl");
const r = fixtureRepo(root, "a-web", "a-flow", {
  fresh: true,
  yaml: `agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-setup.ts"))} }\nconcurrency: 2\n`,
});
r.env.W2_FAKE_LOG = fakeLog;
const calls = () =>
  fs.existsSync(fakeLog)
    ? fs
        .readFileSync(fakeLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { role: string; file: string; resume: string | null; prompt: string })
    : [];
const k = path.join(r.dir, ".kitchen");

// ---------- 1. questions without a TTY ----------
let x = kitchen(r, ["init"]);
check("init without a TTY exits 3 when the survey has a question", x.code === 3, `exit ${x.code}; ${x.out.trim().split("\n").pop()}`);
const qf = path.join(k, "setup-questions.json");
const q = fs.existsSync(qf) ? readJson<{ questions: { id: string; question: string }[] }>(qf) : null;
check("setup-questions.json holds the question", q?.questions.length === 1 && q.questions[0].id === "q1", JSON.stringify(q?.questions));
check(
  "kitchen.yaml kept, skill installed for both tools",
  fs.existsSync(path.join(r.dir, ".claude/skills/kitchen/SKILL.md")) && fs.existsSync(path.join(r.dir, ".agents/skills/kitchen/SKILL.md")),
);
check("only the survey ran", calls().length === 1 && calls()[0].file === "survey.md");

const answers = path.join(root, "answers.json");
fs.writeFileSync(answers, JSON.stringify({ answers: { q1: "bob-admin" } }));
x = kitchen(r, ["init", "--answers", answers]);
check("init --answers resumes and finishes", x.code === 0, x.out.trim().split("\n").slice(-6).join(" | "));
const c = calls();
check(
  "the survey is not run again; build resumes its session",
  c.length === 2 && c[1].file === "setup.md" && c[1].resume === "fake-setup-1",
  JSON.stringify(c.map((y) => [y.file, y.resume])),
);
check("the answer reaches the build prompt, quoted", /<<<ANSWERS[\s\S]*answer: bob-admin[\s\S]*ANSWERS>>>/.test(c[1]?.prompt ?? ""));
check("questions file removed after answering", !fs.existsSync(qf));
const log = git(r.dir, "log", "--format=%s", "main..kitchen/setup");
check("the Toolkit is a commit on kitchen/setup", /kitchen setup: Toolkit/.test(log), log.replace(/\n/g, " | "));
check("main untouched by the setup commit", git(r.dir, "rev-list", "--count", "main") === "1");
const proven = readJson<{ sha: string; branch?: string; features: unknown[] }>(path.join(k, "toolkit.proven"));
check(
  "toolkit.proven names the setup commit",
  proven.sha === git(r.dir, "rev-parse", "kitchen/setup") && proven.branch === "kitchen/setup" && proven.features.length === 3,
  `${proven.sha.slice(0, 12)} ${proven.branch}`,
);
check("check output lists prepare, two slots, evidence", /prepare ok/.test(x.out) && /second slot\) ok/.test(x.out) && /evidence ok/.test(x.out));
x = kitchen(r, ["init"]);
check("a third init does nothing new", x.code === 0 && calls().length === 2 && !/toolkit check on/.test(x.out), x.out.trim().split("\n")[0]);

// ---------- 2. base-change re-proof ----------
git(r.dir, "merge", "--ff-only", "-q", "kitchen/setup");
x = kitchen(r, ["run", "--once"]);
check("base = proven sha: run doesn't re-check", x.code === 0 && !/toolkit: base moved/.test(x.out), x.out.trim().split("\n")[0]);

fs.appendFileSync(path.join(r.dir, "README.md"), "\nA line nobody maps.\n");
git(r.dir, "commit", "-qam", "docs");
x = kitchen(r, ["run", "--once"]);
check(
  "unmapped change: doctor + smoke drive",
  /doctor \+ smoke drive/.test(x.out) && /drive \S+ ok/.test(x.out) && /re-proven/.test(x.out),
  (x.out.match(/toolkit: .*/g) ?? []).join(" | "),
);
check("smoke runs no second slot and no reset round", !/second slot/.test(x.out) && !/after reset/.test(x.out));
check("toolkit.proven moved to the new base", readJson<{ sha: string }>(path.join(k, "toolkit.proven")).sha === git(r.dir, "rev-parse", "HEAD"));

fs.appendFileSync(path.join(r.dir, "server.js"), "\n// a mapped change\n");
git(r.dir, "commit", "-qam", "app change");
x = kitchen(r, ["run", "--once"]);
check(
  "feature-mapped change: full check",
  /full check \(Toolkit paths changed: server\.js\)/.test(x.out) && /second slot\) ok/.test(x.out) && /re-proven/.test(x.out),
  (x.out.match(/toolkit: .*/g) ?? []).join(" | "),
);

const dev = path.join(r.dir, ".kitchen", "toolkit", "bin", "dev");
fs.writeFileSync(dev, fs.readFileSync(dev, "utf8").replace('"--memory", "256m"', '"--memory", "not-a-size"'));
git(r.dir, "commit", "-qam", "break the Toolkit");
const t = kitchen(r, ["ticket", "Add a footer"]);
const job = /ticket (\S+)/.exec(t.out)?.[1] ?? "?";
x = kitchen(r, ["run", "--once"]);
check(
  "broken Toolkit: full check fails, queue paused",
  /full check/.test(x.out) && /FAIL at up/.test(x.out) && /queue paused/.test(x.out),
  (x.out.match(/toolkit: .*/g) ?? []).join(" | "),
);
const tickets = () =>
  fs.existsSync(path.join(k, "tickets.jsonl"))
    ? fs
        .readFileSync(path.join(k, "tickets.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { key: string; title: string; body: string })
    : [];
check(
  "one Toolkit ticket filed, with the failing step",
  tickets().length === 1 && /re-proof failed/.test(tickets()[0].title) && /failed step: up/.test(tickets()[0].body),
  tickets()[0]?.title,
);
const jobState = () => readJson<{ stage: string; moves: number }>(path.join(k, "jobs", job, "job.json"));
check("the queued job was not taken", jobState().stage === "intake" && jobState().moves === 0 && calls().length === 2);
const st = kitchen(r, ["status"]);
check("status shows the paused queue", /queue: paused \(Toolkit check failed/.test(st.out), (st.out.match(/queue: .*/) ?? [""])[0]);
x = kitchen(r, ["run", "--once"]);
check(
  "next run stays paused without re-checking or re-filing",
  /queue paused:/.test(x.out) && !/toolkit check: describe/.test(x.out) && tickets().length === 1,
);

git(r.dir, "revert", "--no-edit", "HEAD");
x = kitchen(r, ["run", "--once"]);
check(
  "fixed on the base: re-proven, queue runs, the job is taken",
  /re-proven/.test(x.out) && !fs.existsSync(path.join(k, "queue.json")) && jobState().stage !== "intake",
  jobState().stage,
);

const left = ourContainers();
check("no Kitchen containers left", left.length === 0, left.join(", "));
const wts = fs.readdirSync(path.join(r.dir, ".worktrees"));
check("unused Toolkit checkouts removed (only the proven one and _setup remain)", wts.filter((w) => w.startsWith("_toolkit@")).length === 1, wts.join(", "));
finish("w2 flow");
