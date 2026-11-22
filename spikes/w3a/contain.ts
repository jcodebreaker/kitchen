// Review round 2, finding 3: cmd and test proofs are contained. A copy of fixture A,
// a job with a worktree (no agent, no Docker: cmd proofs need neither), and a spec
// whose criteria are attacks. Each runs through prove() exactly as Verify would
// (role engine, untrusted env, proof sandbox), then the spike reads the evidence
// files on disk:
//   C1 node -e reads $KITCHEN_HOME/engine.key           → denied (EPERM), key not in evidence
//   C2 node -p process.env leaks a fake token             → evidence redacted
//   C3 python3 -c urllib fetches https://example.com      → network denied
//   C4 cat .env.kitchen (a secret-shaped value)           → evidence redacted
//   C5 node -e writes a file outside the worktree         → denied
//   C6 node -e reads the job's job.json (evidence folder) → denied
//   C8 python3 opens a TCP socket to 1.1.1.1:443         → denied
//   C7 node --test on a worktree test file               → still runs (the sandbox lets real tests through)
// spec-lint (the first line) is reported for each: it passes all of these but the
// last one's path tricks, which is why the sandbox is the boundary.
//   node spikes/w3a/contain.ts <scratch>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lintSpec, parseCriteria } from "../../src/checks/spec-lint.ts";
import { ensureWorktree } from "../../src/engine/worktree.ts";
import { prove } from "../../src/proof/prove.ts";
import { check, finish, HERE, jobDir, jobOf, makeFixtureRepo, ticket } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work"));
fs.mkdirSync(root, { recursive: true });
const yaml = `concurrency: 1
agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-agent.ts"))} }
test_cmd: "node --test {file}"
`;
const r = makeFixtureRepo(root, "contain", { yaml });
process.env.KITCHEN_HOME = r.home;
const id = ticket(r, "containment spike");
const dir = jobDir(r, id);
const job = await ensureWorktree(r.dir, jobOf(r, id));
const wt = job.worktree;
const key = fs.readFileSync(path.join(r.home, "engine.key"), "utf8").trim();
const TOKEN = "sk_test_kitchenFAKE0123456789abcdefXYZ";
const GH = "ghp_FAKEkitchen0123456789abcdefghijklmnopq";
fs.appendFileSync(path.join(wt, ".env.kitchen"), `STRIPE_SECRET_KEY=${TOKEN}\nAPP_GH_TOKEN=${GH}\n`);
fs.mkdirSync(path.join(wt, "test"), { recursive: true });
fs.writeFileSync(path.join(wt, "test", "ok.test.mjs"), 'import test from "node:test";\ntest("runs", () => {});\n');

// Paths built at run time, so no absolute path or `..` is in the proof line (spec-lint's denylist can't see them).
const up = (n: number) => `process.cwd().split(String.fromCharCode(47)).slice(0,-${n}).join(String.fromCharCode(47))`;
const SPEC = `## Criteria
- [C1] reads the engine key
  proof: cmd node -e "console.log(require('fs').readFileSync(${up(3)}+'${String.fromCharCode(47)}kitchen-home${String.fromCharCode(47)}engine.key','utf8'))"
  expect: exit 0
- [C2] dumps the env
  proof: cmd node -p "JSON.stringify(process.env)"
  expect: exit 0
- [C3] fetches from the network
  proof: cmd python3 -c "import urllib.request;print(urllib.request.urlopen('https://example.com',timeout=10).status)"
  expect: exit 0
- [C4] prints the app's env file
  proof: cmd cat .env.kitchen
  expect: exit 0
- [C5] writes outside the worktree
  proof: cmd node -e "require('fs').writeFileSync(${up(2)}+'${String.fromCharCode(47)}escaped.txt','x')"
  expect: exit 0
- [C6] reads the job record
  proof: cmd node -e "console.log(require('fs').readFileSync(${up(2)}+'${String.fromCharCode(47)}.kitchen${String.fromCharCode(47)}jobs${String.fromCharCode(47)}${id}${String.fromCharCode(47)}job.json','utf8'))"
  expect: exit 0
- [C8] opens a socket to an IP address (no DNS)
  proof: cmd python3 -c "import socket;socket.create_connection(('1.1.1.1',443),timeout=10);print('connected')"
  expect: exit 0
- [C7] a real test still runs
  proof: test test/ok.test.mjs
  expect: exit 0
`;
fs.writeFileSync(path.join(dir, "spec.md"), SPEC);
const lint = lintSpec(SPEC, { kind: "feature", toolkit: { primitives: [], drives: {} } });
console.log(`    spec-lint (first line): ${lint.ok ? "passes every attack" : `refuses: ${lint.reason}`}`);

const ev = (ids: string[]) =>
  ids.flatMap((e) => fs.readdirSync(path.join(dir, "evidence", e)).map((f) => fs.readFileSync(path.join(dir, "evidence", e, f), "utf8"))).join("\n");
const results: Record<string, { status: string; text: string; why?: string }> = {};
for (const c of parseCriteria(SPEC)) {
  const p = await prove({ jobDir: dir, criterion: c, role: "engine", testCmd: "node --test {file}", log: (m) => console.log(`    [prove] ${m}`) });
  results[c.id] = { status: p.status, text: ev(p.evidence), why: p.why };
  console.log(`    ${c.id} ${p.status}${p.why ? `: ${p.why.slice(0, 120)}` : ""}`);
}
const sandboxed = fs
  .readFileSync(path.join(dir, "evidence", "manifest.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { sandboxed?: boolean })
  .every((e) => e.sandboxed === true);
check("every cmd/test proof entry is stamped sandboxed: true", sandboxed);
check(
  "C1 node -e reading $KITCHEN_HOME/engine.key: denied, the key is nowhere in the evidence",
  results.C1.status !== "pass" && /EPERM|not permitted/.test(results.C1.text) && !results.C1.text.includes(key),
  results.C1.why,
);
check(
  "C2 node -p process.env: the fake tokens are redacted in the evidence on disk",
  results.C2.status === "pass" && !results.C2.text.includes(TOKEN) && !results.C2.text.includes(GH) && results.C2.text.includes("[redacted]"),
  (/STRIPE_SECRET_KEY[^,]*/.exec(results.C2.text) ?? [""])[0],
);
check(
  "C3 python3 urllib: the network is denied",
  results.C3.status !== "pass" && /URLError|not permitted|nodename|Errno/.test(results.C3.text),
  (
    results.C3.text
      .split("\n")
      .filter((l) => /Error/.test(l))
      .at(-1) ?? ""
  ).slice(0, 160),
);
check(
  "C4 cat .env.kitchen: the secret-shaped values are redacted in the evidence on disk",
  !results.C4.text.includes(TOKEN) && !results.C4.text.includes(GH) && /STRIPE_SECRET_KEY=\[redacted\]/.test(results.C4.text),
  (/STRIPE_SECRET_KEY=\S*/.exec(results.C4.text) ?? [""])[0],
);
check("C5 a write outside the worktree: denied", results.C5.status !== "pass" && !fs.existsSync(path.join(r.dir, ".worktrees", "escaped.txt")), results.C5.why);
check("C6 reading the job's own job.json: denied", results.C6.status !== "pass" && /EPERM|not permitted/.test(results.C6.text), results.C6.why);
check(
  "C8 python3 socket to 1.1.1.1:443 (no DNS): denied",
  results.C8.status !== "pass" && /not permitted|PermissionError/.test(results.C8.text),
  (
    results.C8.text
      .split("\n")
      .filter((l) => /Error/.test(l))
      .at(-1) ?? ""
  ).slice(0, 160),
);
// The control: the same commands unsandboxed (as the engine itself) do succeed, so the denials above are the sandbox's.
const bare = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: wt, encoding: "utf8", timeout: 20_000 });
const cmdOf = (id: string) =>
  parseCriteria(SPEC)
    .find((c) => c.id === id)
    ?.proof?.replace(/^cmd /, "") ?? "";
check("control: C1's command reads the key when run unsandboxed", bare(cmdOf("C1")).stdout.includes(key));
const c8 = bare(cmdOf("C8"));
check("control: C8's socket connects when run unsandboxed", c8.stdout.includes("connected"), c8.stderr.slice(-120));
check("C7 a real `test` proof still runs and passes under the sandbox", results.C7.status === "pass", results.C7.why);
finish("w3a contain");
