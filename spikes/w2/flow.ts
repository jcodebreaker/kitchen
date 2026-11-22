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

// ---------- 1. questions without a TTY, init detached (the /kitchen skill's way) ----------
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** `kitchen init --status` until it isn't running; returns its last answer. */
const pollStatus = async (maxSecs = 600) => {
  const end = Date.now() + maxSecs * 1000;
  let s = kitchen(r, ["init", "--status"]);
  let polls = 1;
  while (/^init: running/.test(s.out) && Date.now() < end) {
    await sleep(1000);
    s = kitchen(r, ["init", "--status"]);
    polls++;
  }
  return { ...s, polls };
};
const initLog = path.join(r.dir, ".kitchen", "init", "init.log");
const logText = () => (fs.existsSync(initLog) ? fs.readFileSync(initLog, "utf8") : "");
let x = kitchen(r, ["init", "--detach"]);
check("init --detach returns at once with the pid and the log", x.code === 0 && /init detached: pid \d+/.test(x.out), x.out.trim().split("\n")[0]);
const again = kitchen(r, ["init", "--detach"]);
check("a second init while one runs is refused", again.code === 1 && /already running/.test(again.out), again.out.trim());
let st = await pollStatus();
check(
  "init --status: questions (exit 3), the question in the status",
  st.code === 0 && /^init: questions: 1 question/.test(st.out),
  st.out.trim().split("\n")[0],
);
check("the detached init exited 3 on the questions (log)", /question\(s\) for you/.test(logText()));
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
x = kitchen(r, ["init", "--answers", answers, "--detach"]);
st = await pollStatus();
x = { out: logText(), code: /^init: done/.test(st.out) ? 0 : 1 };
check(
  "init --answers --detach resumes; --status says done (exit 0)",
  st.code === 0 && /^init: done/.test(st.out),
  st.out.trim().split("\n").slice(0, 3).join(" | "),
);
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

// A re-run after a failed check never says done without a passing check (W2 review).
const stateFile = path.join(k, "init", "state.json");
const failState = (patch: Record<string, unknown>) => {
  const s = readJson<{ steps: { check: Record<string, unknown> } }>(stateFile);
  Object.assign(s.steps.check, patch);
  fs.writeFileSync(stateFile, JSON.stringify(s));
};
failState({ ok: false, failed: "up" });
x = kitchen(r, ["init"]);
check(
  "re-run after a failed check: checks again (and passes)",
  x.code === 0 && /the last check failed at up: checking again/.test(x.out) && /toolkit check: PASS/.test(x.out) && /done: Toolkit proven/.test(x.out),
  (x.out.match(/init: .*/g) ?? []).slice(-3).join(" | "),
);
failState({ static: true });
x = kitchen(r, ["init"]);
check("re-run after a --generate-only check: runs the full check", x.code === 0 && /was static only/.test(x.out) && /second slot\) ok/.test(x.out));
check("calls: no agent ran for either re-run", calls().length === 2);

// ---------- 1b. secret scan: the setup commit is refused, naming the keys ----------
{
  const s = fixtureRepo(root, "a-web", "a-secret", {
    fresh: true,
    yaml: `agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-setup.ts"))} }\n`,
  });
  // The developer's own untracked .env shares a value with what the agent wrote into .env.kitchen.
  fs.writeFileSync(path.join(s.dir, ".env"), "SEED_ALICE_PASSWORD=alice-fake-pw\nPORT=3000\n");
  s.env.W2_FAKE_SECRET = "1";
  const af = path.join(root, "answers-secret.json");
  fs.writeFileSync(af, JSON.stringify({ answers: {} }));
  const y = kitchen(s, ["init", "--answers", af]);
  check(
    "secret scan: init refuses the setup commit and names each key",
    y.code === 1 &&
      /refusing to commit the setup branch/.test(y.out) &&
      /\.env\.kitchen:\d+ STRIPE_SECRET_KEY: a live Stripe secret key/.test(y.out) &&
      /\.env\.kitchen:\d+ SEED_ALICE_PASSWORD: the same value as SEED_ALICE_PASSWORD \(\.env\)/.test(y.out),
    (y.out.match(/ {2}\.env\.kitchen.*/g) ?? []).join(" | "),
  );
  check(
    "nothing committed on kitchen/setup",
    git(s.dir, "rev-list", "--count", "main..kitchen/setup") === "0" || /Toolkit/.test(git(s.dir, "log", "--format=%s", "main..kitchen/setup")) === false,
  );
  check("--status says failed, with the reason", /^init: failed \(exit 1\): secret scan/.test(kitchen(s, ["init", "--status"]).out));
}

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
const stat = kitchen(r, ["status"]);
check("status shows the paused queue", /queue: paused \(Toolkit check failed/.test(stat.out), (stat.out.match(/queue: .*/) ?? [""])[0]);
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

// parallel:false is enforced by the runner (kitchen.yaml still says concurrency: 2; init no longer edits it).
const pf = path.join(k, "toolkit.proven");
fs.writeFileSync(pf, JSON.stringify({ ...readJson<Record<string, unknown>>(pf), parallel: false }));
kitchen(r, ["ticket", "One"]);
kitchen(r, ["ticket", "Two"]);
x = kitchen(r, ["run", "--once"]);
check(
  "a Toolkit proven parallel:false: the runner takes one job at a time over kitchen.yaml's concurrency 2",
  /the Toolkit is proven parallel:false, so one job at a time \(kitchen\.yaml says 2\)/.test(x.out) &&
    /^concurrency: 2/m.test(fs.readFileSync(path.join(r.dir, "kitchen.yaml"), "utf8")),
  (x.out.match(/run: the Toolkit.*/) ?? [""])[0],
);

const left = ourContainers();
check("no Kitchen containers left", left.length === 0, left.join(", "));
const wts = fs.readdirSync(path.join(r.dir, ".worktrees"));
check("unused Toolkit checkouts removed (only the proven one and _setup remain)", wts.filter((w) => w.startsWith("_toolkit@")).length === 1, wts.join(", "));
finish("w2 flow");
