// W3b open item, closed in W5: `test` and `cmd` proofs get the app's URL.
//   node spikes/w5/app-url.ts [scratch]
// A W1 fake-Toolkit repo (its `up` prints {"status":"ready","url":"http://127.0.0.1:1"}), one job with a
// worktree, no agent, no Docker. `up` through the engine (instance.ts) records the URL for the job's slot;
// a cmd proof run exactly as Verify runs it (prove.ts: untrusted env, proof sandbox) sees KITCHEN_APP_URL;
// after `down` the URL is gone and the proof no longer sees it.
import path from "node:path";
import { appUrlOf, down, freshUp } from "../../src/engine/instance.ts";
import { ensureWorktree } from "../../src/engine/worktree.ts";
import { prove } from "../../src/proof/prove.ts";
import { check, finish, jobDir, jobOf, makeRepo, ticket } from "../w1/lib.ts";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"));
const r = makeRepo(root, "app-url");
process.env.KITCHEN_HOME = r.home;
const id = ticket(r, "a test proof needs the app URL");
const dir = jobDir(r, id);
const job = await ensureWorktree(r.dir, jobOf(r, id));
const inst = { toolkitBin: path.join(r.dir, ".kitchen", "toolkit", "bin", "dev"), slotId: job.slotId, worktree: job.worktree, slot: { n: 1, ports: [31000] } };
await freshUp(inst, dir);
check("up recorded the app URL for the job's slot", appUrlOf(dir, job.slotId) === "http://127.0.0.1:1", String(appUrlOf(dir, job.slotId)));
const criterion = { id: "C1", proof: `cmd node -e "console.log('url=' + process.env.KITCHEN_APP_URL)"`, expect: 'contains "url=http://127.0.0.1:1"' };
const p = await prove({ jobDir: dir, criterion, role: "engine", testCmd: "node --test {file}" });
check("a cmd proof (untrusted env, proof sandbox) sees KITCHEN_APP_URL", p.status === "pass", `${p.status} ${p.why ?? ""} ${p.outcome.output.trim()}`);
await down(inst, dir);
const p2 = await prove({ jobDir: dir, criterion, role: "engine", testCmd: "node --test {file}" });
check("after down the URL is gone", appUrlOf(dir, job.slotId) === undefined && p2.status === "assert-fail", `${p2.status} ${p2.outcome.output.trim()}`);
finish("w5 app-url");
