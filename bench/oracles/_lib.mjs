// What every bench oracle shares. An oracle is `node bench/oracles/<key>.mjs`, run by bench/run.ts once the queue
// drained, never by Kitchen and never seen by an agent. It reads its environment:
//   BENCH_URL          the app, started from the merged staging on fresh seed data (tickets with app: true)
//   BENCH_JOB          the job's job.json (absent when the ticket was never filed)
//   BENCH_REPO         the bench repo; BENCH_MAIN_BEFORE: main's sha before the run
// It prints what it saw and exits 0 (pass) or 1 (fail).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const problems = [];

/** Records a problem unless `ok`; returns `ok`. */
export function expect(ok, what) {
  if (!ok) problems.push(what);
  return !!ok;
}

/** One HTTP call to the app as a member (`as`: the X-Member header, or null for none). */
export async function call(method, path, as, body) {
  const headers = {};
  if (as) headers["x-member"] = as;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(process.env.BENCH_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  console.log(`${method} ${path}${as ? ` as ${as}` : ""} -> ${r.status} ${text.slice(0, 200)}`);
  return { status: r.status, headers: r.headers, body: json };
}

/** The job as Kitchen left it, or null when it was never filed. */
export function job() {
  const f = process.env.BENCH_JOB;
  if (!f || !fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

/** Pure: the stages a job's lanes ran in (from its agent runs). */
export const lanesRun = (j) => [...new Set((j?.agentRuns ?? []).map((r) => r.stage))];

/** A git command in the bench repo, its output trimmed. */
export const repoGit = (...args) => execFileSync("git", ["-C", process.env.BENCH_REPO, ...args], { encoding: "utf8" }).trim();

/** Prints the problems and exits: 0 when there are none. */
export function done() {
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  console.log(problems.length ? "ORACLE FAIL" : "ORACLE PASS");
  process.exit(problems.length ? 1 : 0);
}
