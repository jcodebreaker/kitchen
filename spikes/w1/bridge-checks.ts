// W1 carry-over: the builder's `checks` tool on `kitchen mcp`. Talks JSON-RPC to
// the real bridge over stdio (no agent): the kitchen.yaml checks run in the job
// worktree with the untrusted env (a GH_TOKEN in the bridge's env never reaches
// them), each is stamped like a drive (role builder, worktree HEAD), and only
// the builder gets the tool.
//   node spikes/w1/bridge-checks.ts <scratch dir>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CLI, check, finish, jobDir, jobOf, kitchen, makeRepo, type Repo, stepUntil, ticket } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"));
fs.mkdirSync(root, { recursive: true });
const r = makeRepo(root, "bridge");
const id = ticket(r, "Bridge checks\nscenario: chore");
stepUntil(r, id, "gate"); // the builder has run: the job has a worktree and a commit
const yaml = fs
  .readFileSync(path.join(r.dir, "kitchen.yaml"), "utf8")
  .replace(
    /checks:\n.*\n/,
    'checks:\n  - { name: scrubbed, run: "test -z \\"$GH_TOKEN\\" && test \\"$KITCHEN_UNTRUSTED\\" = 1 && git push origin HEAD 2>&1 | grep -q kitchen-push-blocked" }\n  - { name: fails, run: "echo boom >&2; exit 3" }\n',
  );
fs.writeFileSync(path.join(r.dir, "kitchen.yaml"), yaml);
kitchen(r, "status");

async function bridge(rr: Repo, role: string, calls: { method: string; params?: unknown }[]) {
  const p = spawn(process.execPath, [CLI, "mcp", "--job", id, "--role", role, "--repo", rr.dir], {
    env: { ...rr.env, GH_TOKEN: "ghp_FAKE_SHOULD_NOT_LEAK" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = readline.createInterface({ input: p.stdout });
  const replies: Record<number, { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: { message: string } }> = {};
  const done = new Promise<void>((res) =>
    rl.on("line", (l) => {
      const m = JSON.parse(l);
      replies[m.id] = m;
      if (Object.keys(replies).length === calls.length) res();
    }),
  );
  calls.forEach((c, i) => {
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...c })}\n`);
  });
  await done;
  p.stdin.end();
  await new Promise((res) => p.once("exit", res));
  return replies;
}

const b = await bridge(r, "builder", [
  { method: "initialize", params: { protocolVersion: "2025-06-18" } },
  { method: "tools/list" },
  { method: "tools/call", params: { name: "checks", arguments: {} } },
  { method: "tools/call", params: { name: "checks", arguments: { job: "other" } } },
]);
check("builder sees the checks tool", !!b[2].result?.tools?.some((t) => t.name === "checks"));
const res = JSON.parse(b[3].result?.content?.[0].text ?? "{}") as {
  ok: boolean;
  sha: string;
  checks: { name: string; ok: boolean; exit: number; evidence: string; tail: string }[];
};
check(
  "checks ran: the untrusted env (no GH_TOKEN, push blocked) and a failing one reported with its exit",
  res.checks?.[0]?.ok === true && res.checks?.[1]?.exit === 3 && res.ok === false && b[3].result?.isError === true,
  JSON.stringify(res.checks?.map((c) => [c.name, c.exit, c.evidence])),
);
check("extra fields are refused", /unknown fields: job/.test(b[4].result?.content?.[0].text ?? ""));
const entries = fs
  .readFileSync(path.join(jobDir(r, id), "evidence", "manifest.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { id: string; role: string; sha: string; check?: string; exit: number });
const mine = entries.filter((e) => e.role === "builder");
const head = res.sha;
check(
  "each check stamped like a drive: role builder, the worktree HEAD, its own e<N>/",
  mine.length === 2 && mine.every((e) => e.sha === head && fs.existsSync(path.join(jobDir(r, id), "evidence", e.id, "stdout.txt"))),
  mine.map((e) => `${e.id}:${e.check}:${e.exit}`).join(" "),
);
check("stamped sha is the job worktree's HEAD", head === execHead(jobOf(r, id).worktree), head);
const leaked = fs
  .readdirSync(path.join(jobDir(r, id), "evidence"), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".txt") || f.endsWith(".json"))
  .some((f) => fs.readFileSync(path.join(jobDir(r, id), "evidence", f), "utf8").includes("ghp_FAKE"));
check("the fake token appears in no evidence", !leaked);
const v = await bridge(r, "verifier", [{ method: "tools/list" }, { method: "tools/call", params: { name: "checks", arguments: {} } }]);
check("the verifier gets no checks tool", !v[1].result?.tools?.some((t) => t.name === "checks") && /unknown tool checks/.test(v[2].error?.message ?? ""));

function execHead(wt: string): string {
  return execFileSync("git", ["--git-dir", jobOf(r, id).gitDir, "--work-tree", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

finish("w1 bridge checks");
