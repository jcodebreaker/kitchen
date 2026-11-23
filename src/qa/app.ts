// What the QA lane runs the app and gathers evidence with (ADR 0016 §3): `kitchen qa up|down|reset|page|http <job>`.
//
// - up: the app from the job's worktree, as kitchen.yaml `app:` says (reset, then start on a free port, then wait
//   for the health check). A repo that still has an older Kitchen Toolkit (.kitchen/toolkit/bin/dev) and no
//   `app.start` keeps working: its `bin/dev prepare` and `up` start the app instead.
// - reset: down, then up again (which runs `app.reset` first): fresh seed data between criteria that need it.
// - page: a real browser (Playwright's Chromium, pinned in Kitchen's package.json) opens a page, optionally runs a
//   small script, and saves a screenshot plus a text file (final URL, title, visible text, console errors).
// - http: one request, saved as a plain transcript.
// Every file lands in the job's QA folder for this round, where the verdict cites it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareOf, runShell } from "../checks/run-checks.ts";
import { type Config, loadConfig } from "../config.ts";
import { qaDir, regressDir } from "../engine/lanes.ts";
import { findJob, jobDirOf, worktreeOf, writeAtomic } from "../engine/store.ts";
import { isRunId, runDir, runEvidence, runWorktree } from "../verify/paths.ts";

type AppState = { pid?: number; port?: number; url: string; at: string; legacy?: { id: string; dev: string; wt: string } };
const stateFile = (repo: string, id: string) => path.join(isRunId(id) ? runDir(repo, id) : jobDirOf(repo, id), "app.json");
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function readState(repo: string, id: string): AppState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(repo, id), "utf8")) as AppState;
  } catch {
    return null;
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    return r.status < 400;
  } catch {
    return false;
  }
}

const join = (base: string, p: string) => (/^https?:\/\//.test(p) ? p : `${base.replace(/\/$/, "")}/${p.replace(/^\//, "")}`);
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

/**
 * What `kitchen qa … <ref>` works on: a job (its worktree; its QA folder, or its regress folder while the job is in
 * regress) or a verify run (`sweep-…`, `maintain-…`: its checkout and evidence folder under .kitchen/verify/).
 */
function jobPaths(repo: string, ref: string): { id: string; wt: string; out: string } {
  if (isRunId(ref)) {
    if (!fs.existsSync(runDir(repo, ref))) throw new Error(`no verify run ${ref}`);
    const out = runEvidence(repo, ref);
    fs.mkdirSync(out, { recursive: true });
    return { id: ref, wt: runWorktree(repo, ref), out };
  }
  const job = findJob(repo, ref);
  const wt = job.worktree && fs.existsSync(job.worktree) ? job.worktree : worktreeOf(repo, job.id);
  const dir = jobDirOf(repo, job.id);
  const out = job.stage === "regress" ? regressDir(dir, job.round) : qaDir(dir, job.round);
  fs.mkdirSync(out, { recursive: true });
  return { id: job.id, wt: fs.existsSync(wt) ? wt : repo, out };
}

const legacyDev = (wt: string, repo: string) => [wt, repo].map((d) => path.join(d, ".kitchen", "toolkit", "bin", "dev")).find((f) => fs.existsSync(f));

export async function appUp(repo: string, ref: string, out: (l: string) => void, cfg: Config = loadConfig(repo)): Promise<number> {
  const { id: jid, wt, out: dir } = jobPaths(repo, ref);
  const had = readState(repo, jid);
  if (had && (had.legacy || (had.pid && alive(had.pid))) && (await healthy(join(had.url, cfg.app.health)))) {
    out(`app: up at ${had.url}`);
    return 0;
  }
  const log = path.join(dir, "app.log");
  const prepare = prepareOf(cfg);
  if (prepare && fs.existsSync(path.join(wt, "package.json")) && !fs.existsSync(path.join(wt, "node_modules"))) {
    const p = await runShell(prepare, { cwd: wt, timeoutSec: 1800, log });
    if (!p.ok) {
      out(`app: preparing failed (${prepare}); see ${log}`);
      return 1;
    }
  }
  if (!cfg.app.start) {
    const dev = legacyDev(wt, repo);
    if (!dev) {
      out("app: kitchen.yaml has no app.start (nothing to run): check with tests and commands instead");
      return 1;
    }
    const id = `kq${jid.split("-")[0]}`;
    await runShell(`"${dev}" prepare --src "${wt}"`, { cwd: wt, timeoutSec: 1800, log });
    const r = await runShell(`"${dev}" up --id ${id} --src "${wt}"`, { cwd: wt, timeoutSec: 600, log });
    const line = r.all
      .trim()
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("{"));
    const url = line ? (JSON.parse(line) as { url?: string }).url : undefined;
    if (!r.ok || !url) {
      out(`app: the Toolkit's bin/dev up failed; see ${log}`);
      return 1;
    }
    writeAtomic(stateFile(repo, jid), JSON.stringify({ url, at: new Date().toISOString(), legacy: { id, dev, wt } }));
    out(`app: up at ${url} (the repo's Toolkit, bin/dev up)`);
    return 0;
  }
  const port = cfg.app.port && !cfg.app.start.includes("{port}") && !(cfg.app.url ?? "").includes("{port}") ? cfg.app.port : await freePort();
  const env = { ...process.env, PORT: String(port) };
  const fill = (s: string) => s.replaceAll("{port}", String(port));
  if (cfg.app.reset) {
    const r = await runShell(fill(cfg.app.reset), { cwd: wt, timeoutSec: 300, log, env });
    if (!r.ok) {
      out(`app: app.reset failed (exit ${r.exit}); see ${log}`);
      return 1;
    }
  }
  const fd = fs.openSync(log, "a");
  const child = spawn("/bin/sh", ["-c", fill(cfg.app.start)], { cwd: wt, env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.closeSync(fd);
  const url = fill(cfg.app.url ?? "http://127.0.0.1:{port}");
  writeAtomic(stateFile(repo, jid), JSON.stringify({ pid: child.pid, port, url, at: new Date().toISOString() }));
  const end = Date.now() + cfg.app.ready_timeout_sec * 1000;
  while (Date.now() < end) {
    if (await healthy(join(url, cfg.app.health))) {
      out(`app: up at ${url} (pid ${child.pid}, log ${path.relative(repo, log)})`);
      return 0;
    }
    if (child.pid && !alive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await appDown(repo, jid);
  out(`app: not healthy at ${join(url, cfg.app.health)} within ${cfg.app.ready_timeout_sec}s; see ${path.relative(repo, log)}`);
  return 1;
}

export async function appDown(repo: string, ref: string, out: (l: string) => void = () => {}): Promise<number> {
  const id = isRunId(ref) ? ref : findJob(repo, ref).id;
  const s = readState(repo, id);
  if (!s) {
    out("app: not running");
    return 0;
  }
  if (s.legacy) await runShell(`"${s.legacy.dev}" down --id ${s.legacy.id}`, { cwd: s.legacy.wt, timeoutSec: 120 });
  else if (s.pid) {
    try {
      process.kill(-s.pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 30 && alive(s.pid); i++) await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(-s.pid, "SIGKILL");
    } catch {}
  }
  fs.rmSync(stateFile(repo, id), { force: true });
  out("app: stopped");
  return 0;
}

/**
 * `kitchen qa reset`: the app down, `app.reset`, the app up again (appUp runs the reset), so the next criterion
 * starts on the seed data. Without an app.reset it only restarts, and says the data is what earlier checks left.
 */
export async function appReset(repo: string, ref: string, out: (l: string) => void, cfg: Config = loadConfig(repo)): Promise<number> {
  await appDown(repo, ref);
  const code = await appUp(repo, ref, out, cfg);
  if (code === 0 && cfg.app.start && !cfg.app.reset) out("app: restarted, but kitchen.yaml has no app.reset: the data is what earlier checks left (not fresh)");
  else if (code === 0 && cfg.app.reset) out(`app: reset (${cfg.app.reset}) and restarted on fresh data`);
  return code;
}

function baseUrl(repo: string, id: string): string | null {
  return readState(repo, id)?.url ?? null;
}

/** Playwright, from Kitchen's own dependencies. */
function playwright(): { chromium: { launch(o: object): Promise<Browser> } } {
  const req = createRequire(import.meta.url);
  try {
    return req("playwright") as ReturnType<typeof playwright>;
  } catch {
    throw new Error("Playwright is missing from Kitchen's install: npm install in Kitchen's folder (it is a pinned dependency)");
  }
}
type Page = {
  goto(u: string, o: object): Promise<unknown>;
  on(e: string, f: (x: unknown) => void): void;
  screenshot(o: object): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  innerText(s: string): Promise<string>;
  setDefaultTimeout(n: number): void;
};
type Browser = { newContext(o: object): Promise<{ newPage(): Promise<Page> }>; close(): Promise<void>; version(): string };

export async function page(repo: string, ref: string, target: string, o: { name: string; script?: string }, out: (l: string) => void): Promise<number> {
  if (!NAME.test(o.name)) throw new Error("--name: letters, digits, . _ - (a file name without a folder)");
  const { id: jid, out: dir } = jobPaths(repo, ref);
  const base = baseUrl(repo, jid);
  if (!base && !/^https?:/.test(target)) {
    out(`page: the app is not up: kitchen qa up ${jid} first`);
    return 1;
  }
  const url = join(base ?? "", target);
  if (!LOOPBACK.test(url)) throw new Error(`page: ${url} is not this machine (127.0.0.1 or localhost only)`);
  const browser = await playwright().chromium.launch({ headless: true });
  const errors: string[] = [];
  let ok = true;
  let why = "";
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", timezoneId: "UTC" });
    const p = await ctx.newPage();
    p.setDefaultTimeout(15_000);
    p.on("pageerror", (e) => errors.push(String(e)));
    p.on("console", (m) => {
      const msg = m as { type(): string; text(): string };
      if (msg.type() === "error") errors.push(msg.text());
    });
    const res = (await p.goto(url, { waitUntil: "load" })) as { status(): number } | null;
    if (o.script) {
      const mod = (await import(pathToFileURL(path.resolve(o.script)).href)) as { default?: (page: Page, ctx: object) => Promise<unknown> };
      if (typeof mod.default !== "function") throw new Error(`${o.script} must export a default async function (page, ctx)`);
      await mod.default(p, { url: base ?? url, job: jid, dir });
    }
    await p.screenshot({ path: path.join(dir, `${o.name}.png`), fullPage: true });
    const text = (await p.innerText("body").catch(() => "")).slice(0, 6000);
    writeAtomic(
      path.join(dir, `${o.name}.txt`),
      [
        `opened: ${url}`,
        `status: ${res?.status() ?? "?"}`,
        `final url: ${p.url()}`,
        `title: ${await p.title()}`,
        `browser: chromium ${browser.version()} (Playwright), 1280x800`,
        `console errors: ${errors.length ? `\n${errors.map((e) => `  ${e}`).join("\n")}` : "none"}`,
        "",
        "visible text:",
        text,
        "",
      ].join("\n"),
    );
  } catch (e) {
    ok = false;
    why = (e as Error).message.split("\n")[0];
    writeAtomic(path.join(dir, `${o.name}.txt`), `opened: ${url}\nerror: ${(e as Error).message}\nconsole errors: ${errors.join("\n") || "none"}\n`);
  } finally {
    await browser.close();
  }
  out(
    ok
      ? `page: ${o.name}.png and ${o.name}.txt in ${path.relative(repo, dir)}${errors.length ? ` (${errors.length} console errors)` : ""}`
      : `page: failed: ${why} (${o.name}.txt)`,
  );
  return ok ? 0 : 1;
}

export async function http(
  repo: string,
  ref: string,
  method: string,
  target: string,
  o: { name: string; headers: string[]; data?: string },
  out: (l: string) => void,
): Promise<number> {
  if (!NAME.test(o.name)) throw new Error("--name: letters, digits, . _ - (a file name without a folder)");
  const { id: jid, out: dir } = jobPaths(repo, ref);
  const base = baseUrl(repo, jid);
  if (!base && !/^https?:/.test(target)) {
    out(`http: the app is not up: kitchen qa up ${jid} first`);
    return 1;
  }
  const url = join(base ?? "", target);
  if (!LOOPBACK.test(url)) throw new Error(`http: ${url} is not this machine (127.0.0.1 or localhost only)`);
  const headers: Record<string, string> = {};
  for (const h of o.headers) {
    const i = h.indexOf(":");
    if (i < 1) throw new Error(`--header takes 'Name: value', got ${h}`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  if (o.data !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const req = [`${method.toUpperCase()} ${url}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", o.data ?? ""].join("\n");
  let resText: string;
  let status = 0;
  try {
    const r = await fetch(url, { method: method.toUpperCase(), headers, body: o.data, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    status = r.status;
    const body = await r.text();
    resText = [
      `HTTP ${r.status} ${r.statusText}`,
      ...[...r.headers].map(([k, v]) => `${k}: ${v}`),
      "",
      body.length > 20000 ? `${body.slice(0, 20000)}\n…` : body,
    ].join("\n");
  } catch (e) {
    resText = `request failed: ${(e as Error).message}`;
  }
  writeAtomic(path.join(dir, `${o.name}.http.txt`), `# request\n${req}\n\n# response\n${resText}\n`);
  out(`http: ${method.toUpperCase()} ${target} → ${status || "no response"} (${o.name}.http.txt)`);
  return status ? 0 : 1;
}
