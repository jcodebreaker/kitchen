// W3b (asked by W4): a proof can assert a 4xx. `http --expect_status 403` is ok only for that
// status; without it a 4xx is still ok:false. Fixture A's Toolkit, through the engine's prove().
//   node spikes/w3b/http-status.ts <scratch>
import fs from "node:fs";
import path from "node:path";
import { runOracle } from "../../src/bench/oracle.ts";
import { makeBenchRepo } from "../../src/bench/repo.ts";
import type { BenchTicket } from "../../src/bench/set.ts";
import { check, finish } from "../w3a/lib.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"), "http-status");
fs.mkdirSync(root, { recursive: true });
process.env.KITCHEN_HOME = path.join(root, "kitchen-home");
fs.mkdirSync(process.env.KITCHEN_HOME, { recursive: true, mode: 0o700 });
const t = (criteria: string): BenchTicket => ({
  id: "http-status",
  fixture: "a-web",
  set: "tuned",
  kind: "feature",
  tiers: [],
  text: "x",
  plant: [],
  expect: { outcome: ["done"] },
  oracle: { criteria, files: {} },
});
const repo = makeBenchRepo(ROOT, t("x"), path.join(root, "repo"), "{ tool: fake, script: none.ts }");
const run = (c: string) => runOracle({ kitchenRoot: ROOT, repo, branch: "main", ticket: t(c), testCmd: "node --test {file}" });
const a = await run(`- [C1] alice gets 403 on /admin
  proof: toolkit login --as alice ; toolkit http --method GET --path /admin --expect_status 403 --save r
  expect: $r contains "403"`);
check("http --expect_status 403 on a 403: ok, the proof passes", a.pass, JSON.stringify(a.results));
const b = await run(`- [C1] alice gets 403 on /admin
  proof: toolkit login --as alice ; toolkit http --method GET --path /admin --save r
  expect: $r contains "403"`);
check("without expect_status a 4xx is still a failed step", !b.pass && b.results[0]?.status === "step-failed", JSON.stringify(b.results));
const c = await run(`- [C1] bob-admin is not refused
  proof: toolkit login --as bob-admin ; toolkit http --method GET --path /admin --expect_status 403 --save r
  expect: $r contains "403"`);
check("expect_status 403 on a 200: not ok", !c.pass && c.results[0]?.status === "step-failed", JSON.stringify(c.results));
finish("w3b http-status");
