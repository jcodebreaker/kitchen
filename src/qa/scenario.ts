// ADR 0033 §1-§2: `kitchen qa scenario <job> <name>` and `kitchen qa whoami <job>`. A scenario prepares one state on
// the job's running app, stopping just before the tested action, and prints JSON of what it made; whoami says who
// QA is. Each answer lands in the QA folder as evidence a verdict row cites.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Config, loadConfig, SCENARIO } from "../config.ts";
import { writeAtomic } from "../engine/store.ts";
import { isRunId } from "../verify/paths.ts";
import { jobPaths, join, mask, parseHeaders, reachable, readState, runUrl } from "./app.ts";

/** What a scenario or whoami command gets: the app's URL and port, its compose project, the job, and who to be. */
function envOf(repo: string, id: string, as?: string): Record<string, string> | null {
  const remote = runUrl(repo, id);
  const st = readState(repo, id);
  if (!remote && !st) return null;
  return {
    BASE_URL: remote ?? (st?.url as string),
    ...(st?.port ? { PORT: String(st.port) } : {}),
    ...(st?.project ? { COMPOSE_PROJECT_NAME: st.project } : {}),
    ...(isRunId(id) ? {} : { KITCHEN_JOB: id }),
    ...(as ? { KITCHEN_AS: as } : {}),
  };
}

/** A shell command's stdout apart from its stderr (the JSON is on stdout; both go to the log). */
function sh(cmd: string, o: { cwd: string; env: Record<string, string>; log: string; timeoutSec: number }): Promise<{ code: number | null; stdout: string }> {
  fs.appendFileSync(o.log, `$ ${cmd}\n`);
  return new Promise((resolve) => {
    const c = spawn("/bin/sh", ["-c", cmd], { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    c.stdout.on("data", (d: Buffer) => {
      stdout += d;
      fs.appendFileSync(o.log, d);
    });
    c.stderr.on("data", (d: Buffer) => fs.appendFileSync(o.log, d));
    const t = setTimeout(() => {
      try {
        process.kill(-(c.pid as number), "SIGKILL");
      } catch {}
    }, o.timeoutSec * 1000);
    c.on("error", () => {});
    c.on("close", (code) => {
      clearTimeout(t);
      fs.appendFileSync(o.log, `${stdout.endsWith("\n") || !stdout ? "" : "\n"}[exit ${code}]\n`);
      resolve({ code, stdout });
    });
  });
}

/** Pure: the JSON a command printed: all of stdout, else its last line that is JSON. Null when there is none. */
export function jsonOut(stdout: string): unknown {
  const all = stdout.trim();
  for (const t of [all, ...all.split("\n").reverse()]) {
    const s = t.trim();
    if (!/^[[{]/.test(s)) continue;
    try {
      return JSON.parse(s);
    } catch {}
  }
  return null;
}

export async function scenario(repo: string, ref: string, name: string, out: (l: string) => void, cfg: Config = loadConfig(repo)): Promise<number> {
  const all = cfg.app.scenarios;
  // Own keys only (never `constructor`), and a name that can be a file name.
  const cmd = SCENARIO.test(name) && Object.hasOwn(all, name) ? all[name] : undefined;
  if (!cmd) {
    const names = Object.keys(all);
    out(
      `scenario: no scenario ${name} in kitchen.yaml${names.length ? ` (it has ${names.join(", ")})` : ": add app.scenarios: { <name>: <command that prepares it and prints JSON> }"}`,
    );
    return 1;
  }
  const { id, wt, out: dir } = jobPaths(repo, ref);
  const env = envOf(repo, id);
  if (!env) {
    out(`scenario: the app is not up: kitchen qa up ${id} first`);
    return 1;
  }
  const log = path.join(dir, `scenario-${name}.log`);
  fs.writeFileSync(log, "");
  const r = await sh(cmd, { cwd: wt, env, log, timeoutSec: 300 });
  const made = jsonOut(r.stdout);
  if (r.code !== 0) {
    out(`scenario: ${name} failed (exit ${r.code ?? "timeout"}); see ${path.relative(repo, log)}`);
    return 1;
  }
  if (made === null || typeof made !== "object") {
    out(`scenario: ${name} printed no JSON (what it made: record ids, who to log in as); see ${path.relative(repo, log)}`);
    return 1;
  }
  writeAtomic(path.join(dir, `scenario-${name}.json`), `${JSON.stringify(made, null, 2)}\n`);
  out(`scenario: ${name} ready (scenario-${name}.json): ${JSON.stringify(made).slice(0, 300)}. Read it back through the app before you act.`);
  return 0;
}

export async function whoami(
  repo: string,
  ref: string,
  o: { headers: string[]; as?: string; name?: string },
  out: (l: string) => void,
  cfg: Config = loadConfig(repo),
): Promise<number> {
  const w = cfg.app.whoami;
  if (!w) {
    out(
      "whoami: kitchen.yaml has no app.whoami: say who you acted as in each row's note (the header or login you used). Add app.whoami: a command or a path that returns the identity",
    );
    return 1;
  }
  // Always whoami-…: a name never lands on verdict.json.
  // `ana@example.com` → whoami-ana_example.com.json: any other character becomes _.
  const suffix = (o.name ?? o.as ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 80);
  const name = suffix ? `whoami-${suffix}` : "whoami";
  const path_ = /^(\/|https?:\/\/)/.test(w);
  // A command gets who to be in $KITCHEN_AS; headers are for a path. Refused rather than dropped.
  if (!path_ && o.headers.length)
    throw new Error("whoami: app.whoami is a command: --header is for a path whoami; say who to be with --as (it gets $KITCHEN_AS)");
  // A path is asked with the headers alone: `--as` without one would be asked as nobody and saved as someone.
  if (path_ && o.as && !o.headers.length)
    throw new Error(`whoami: app.whoami is a path (${w}): --as only names the file; pass the header you act as (--header 'X-User: ${o.as}')`);
  const headers = parseHeaders(o.headers);
  const asked = { via: path_ ? `GET ${w}` : "command", ...(o.as ? { as: o.as } : {}), ...(o.headers.length ? { headers: mask(headers) } : {}) };
  const { id, wt, out: dir } = jobPaths(repo, ref);
  const env = envOf(repo, id, o.as);
  if (!env) {
    out(`whoami: the app is not up: kitchen qa up ${id} first`);
    return 1;
  }
  let body: string;
  let ok: boolean;
  const log = path.join(dir, `${name}.log`);
  fs.writeFileSync(log, "");
  if (path_) {
    const url = join(env.BASE_URL, w);
    if (!reachable(url, runUrl(repo, id))) throw new Error(`whoami: ${url} is not this machine (127.0.0.1 or localhost only)`);
    try {
      const r = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      body = await r.text();
      ok = r.ok;
      fs.appendFileSync(
        log,
        `GET ${url}\n${Object.entries(mask(headers))
          .map(([k, v]) => `${k}: ${v}\n`)
          .join("")}\nHTTP ${r.status}\n${body}\n`,
      );
    } catch (e) {
      body = "";
      ok = false;
      fs.appendFileSync(log, `GET ${url}\nrequest failed: ${(e as Error).message}\n`);
    }
  } else {
    const r = await sh(w, { cwd: wt, env, log, timeoutSec: 60 });
    body = r.stdout;
    ok = r.code === 0;
  }
  if (!ok) {
    out(`whoami: ${w} failed; see ${path.relative(repo, log)}`);
    return 1;
  }
  const j = jsonOut(body);
  const file = j !== null ? `${name}.json` : `${name}.txt`;
  // What it answered, and how it was asked (sensitive header values masked).
  writeAtomic(path.join(dir, file), j !== null ? `${JSON.stringify({ identity: j, asked }, null, 2)}\n` : `# asked: ${JSON.stringify(asked)}\n${body}`);
  out(`whoami: ${(j !== null ? JSON.stringify(j) : body.trim()).slice(0, 300)} (${file})`);
  return 0;
}
