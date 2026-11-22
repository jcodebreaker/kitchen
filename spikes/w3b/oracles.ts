// W3b: the benchmark's hidden oracles discriminate. No agent: for every ticket with an
// oracle, the oracle runs on the untouched base (it must FAIL: the ticket isn't done
// there), and for the planted bugs it runs again with the plant taken back out (it must
// PASS: that is the fix). Proves the oracle path end to end (fixture repo, engine-owned
// checkout, slot, fresh app, prove()) on every fixture before any money is spent.
//   node spikes/w3b/oracles.ts <scratch> [ticket…]
import fs from "node:fs";
import path from "node:path";
import { runOracle } from "../../src/bench/oracle.ts";
import { FIXTURES, gitIn, makeBenchRepo } from "../../src/bench/repo.ts";
import { loadSet } from "../../src/bench/set.ts";
import { check, finish } from "../w3a/lib.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const [scratch, ...only] = process.argv.slice(2);
const root = path.resolve(scratch ?? path.join(import.meta.dirname, ".work"), "oracles");
fs.mkdirSync(root, { recursive: true });
process.env.KITCHEN_HOME = path.join(root, "kitchen-home");
fs.mkdirSync(process.env.KITCHEN_HOME, { recursive: true, mode: 0o700 });
const tickets = loadSet(ROOT).filter((t) => t.oracle && (!only.length || only.includes(t.id)));
for (const t of tickets) {
  const repo = makeBenchRepo(ROOT, t, path.join(root, t.id), "{ tool: fake, script: none.ts }");
  const log = (m: string) => fs.appendFileSync(path.join(root, `${t.id}.log`), `${m}\n`);
  const t0 = Date.now();
  const onBase = await runOracle({ kitchenRoot: ROOT, repo, branch: "main", ticket: t, testCmd: FIXTURES[t.fixture].testCmd, log });
  check(
    `${t.id}: the oracle FAILS on the base (${Math.round((Date.now() - t0) / 1000)} s)`,
    !onBase.pass && !onBase.error,
    onBase.error ?? onBase.results.map((r) => `${r.id} ${r.status}`).join(", "),
  );
  const fixable = t.plant.filter((p) => "from" in p);
  if (t.kind === "bug" && fixable.length) {
    for (const p of fixable) {
      if (!("from" in p)) continue;
      const f = path.join(repo, p.file);
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(p.to, p.from));
    }
    gitIn(repo, "checkout", "-q", "-b", "fixed");
    gitIn(repo, "commit", "-qam", "take the plant out (the fix)");
    const fixed = await runOracle({ kitchenRoot: ROOT, repo, branch: "fixed", ticket: t, testCmd: FIXTURES[t.fixture].testCmd, log });
    check(
      `${t.id}: the oracle PASSES with the planted bug taken out`,
      fixed.pass,
      fixed.error ?? fixed.results.map((r) => `${r.id} ${r.status} ${r.why ?? ""}`).join(", "),
    );
    gitIn(repo, "checkout", "-q", "main");
  }
}
finish("w3b oracles");
