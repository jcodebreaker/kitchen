// Run one ticket's oracle on an existing branch of an existing bench repo (e.g. a run that
// ended needs-human, to tell a Kitchen miss from a bench defect).
//   node spikes/w3b/oracle-on.ts <ticket> <bench repo> <branch> <kitchen-home>
import { runOracle } from "../../src/bench/oracle.ts";
import { FIXTURES } from "../../src/bench/repo.ts";
import { loadSet } from "../../src/bench/set.ts";

const [id, repo, branch, home] = process.argv.slice(2);
process.env.KITCHEN_HOME = home;
const root = new URL("../..", import.meta.url).pathname;
const t = loadSet(root).find((x) => x.id === id);
if (!t) throw new Error(`no ticket ${id}`);
const r = await runOracle({ kitchenRoot: root, repo, branch, ticket: t, testCmd: FIXTURES[t.fixture].testCmd, log: (m) => console.error(m.slice(0, 300)) });
console.log(JSON.stringify(r));
process.exitCode = r.pass ? 0 : 1;
