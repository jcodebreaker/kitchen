// W3b: the benchmark's hidden oracles discriminate. No agent: for every ticket with an
// oracle, the oracle runs on the untouched base (it must FAIL: the ticket isn't done
// there), and for the planted bugs it runs again with the plant taken back out (it must
// PASS: that is the fix). A feature ticket listed in IMPLEMENTATIONS gets hand-written
// branches too: a correct one (must PASS) and wrong ones (must FAIL). Proves the oracle
// path end to end (fixture repo, engine-owned checkout, slot, fresh app, prove()) on
// every fixture before any money is spent.
//   node spikes/w3b/oracles.ts <scratch> [ticket…]
import fs from "node:fs";
import path from "node:path";
import { runOracle } from "../../src/bench/oracle.ts";
import { FIXTURES, gitIn, makeBenchRepo } from "../../src/bench/repo.ts";
import { applyPlant, loadSet, type Plant } from "../../src/bench/set.ts";
import { check, finish } from "../w3a/lib.ts";

const LOGIN_OK = 'await pool.query("INSERT INTO sessions (token, user_id) VALUES ($1, $2)", [token, rows[0].id]);';
const LOGIN_QUERY = '    const { rows } = await pool.query("SELECT id FROM users WHERE username = $1 AND password_hash';
const MIGRATION = { file: "db/003_last_login.sql", append: "ALTER TABLE users ADD COLUMN last_login_at timestamptz;\n" };

/** Hand-written implementations of feature tickets: edits (in the plant format) on top of the base. */
const IMPLEMENTATIONS: Record<string, { name: string; pass: boolean; edits: Plant[] }[]> = {
  "a-primitive": [
    {
      name: "correct: a migration, and a successful sign-in sets it",
      pass: true,
      edits: [
        MIGRATION,
        { file: "server.js", from: LOGIN_OK, to: `${LOGIN_OK}\n    await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [rows[0].id]);` },
      ],
    },
    {
      name: "wrong: every sign-in attempt sets it, a refused one too",
      pass: false,
      edits: [
        MIGRATION,
        {
          file: "server.js",
          from: LOGIN_QUERY,
          to: `    await pool.query("UPDATE users SET last_login_at = now() WHERE username = $1", [username || ""]);\n${LOGIN_QUERY}`,
        },
      ],
    },
    { name: "wrong: only the column (nothing sets it)", pass: false, edits: [MIGRATION] },
  ],
};

const ROOT = path.resolve(import.meta.dirname, "../..");
const [scratch, ...only] = process.argv.slice(2);
const root = path.resolve(scratch ?? path.join(import.meta.dirname, ".work"), "oracles");
fs.mkdirSync(root, { recursive: true });
process.env.KITCHEN_HOME = path.join(root, "kitchen-home");
fs.mkdirSync(process.env.KITCHEN_HOME, { recursive: true, mode: 0o700 });
const tickets = loadSet(ROOT).filter((t) => t.oracle && (!only.length || only.includes(t.id)));
const detail = (r: Awaited<ReturnType<typeof runOracle>>) => r.error ?? r.results.map((x) => `${x.id} ${x.status}${x.why ? ` ${x.why}` : ""}`).join(", ");
for (const t of tickets) {
  const repo = makeBenchRepo(ROOT, t, path.join(root, t.id), "{ tool: fake, script: none.ts }");
  const log = (m: string) => fs.appendFileSync(path.join(root, `${t.id}.log`), `${m}\n`);
  const oracleOn = (branch: string) => runOracle({ kitchenRoot: ROOT, repo, branch, ticket: t, testCmd: FIXTURES[t.fixture].testCmd, log });
  const t0 = Date.now();
  const onBase = await oracleOn("main");
  check(`${t.id}: the oracle FAILS on the base (${Math.round((Date.now() - t0) / 1000)} s)`, !onBase.pass && !onBase.error, detail(onBase));
  const fixable = t.plant.filter((p) => "from" in p);
  if (t.kind === "bug" && fixable.length) {
    for (const p of fixable) {
      if (!("from" in p)) continue;
      const f = path.join(repo, p.file);
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(p.to, p.from));
    }
    gitIn(repo, "checkout", "-q", "-b", "fixed");
    gitIn(repo, "commit", "-qam", "take the plant out (the fix)");
    const fixed = await oracleOn("fixed");
    check(`${t.id}: the oracle PASSES with the planted bug taken out`, fixed.pass, detail(fixed));
    gitIn(repo, "checkout", "-q", "main");
  }
  for (const [i, impl] of (IMPLEMENTATIONS[t.id] ?? []).entries()) {
    gitIn(repo, "checkout", "-q", "-b", `impl-${i}`, "main");
    for (const e of impl.edits) {
      const f = path.join(repo, e.file);
      fs.writeFileSync(f, applyPlant(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "", e));
    }
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", impl.name);
    const t1 = Date.now();
    const r = await oracleOn(`impl-${i}`);
    check(
      `${t.id}: the oracle ${impl.pass ? "PASSES" : "FAILS"} on "${impl.name}" (${Math.round((Date.now() - t1) / 1000)} s)`,
      impl.pass ? r.pass : !r.pass && !r.error,
      detail(r),
    );
    gitIn(repo, "checkout", "-q", "main");
  }
}
finish("w3b oracles");
