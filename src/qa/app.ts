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
import { type AppConfig, type Config, loadConfig } from "../config.ts";
import { criteriaOf, qaDir, regressDir } from "../engine/lanes.ts";
import type { Job } from "../engine/machine.ts";
import { findJob, jobDirOf, listJobs, updateJob, worktreeOf, writeAtomic } from "../engine/store.ts";
import { isRunId, runDir, runEvidence, runWorktree } from "../verify/paths.ts";

type AppState = Partial<Started> & { url: string; at: string; legacy?: { id: string; dev: string; wt: string } };
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

/** A setup step `kitchen qa up` is on (`of`: the health wait's limit in seconds), or null when it is over. */
export type Step = { cmd: string; of?: number } | null;

/**
 * ADR 0029 §4: the job records the setup step in `checking` (ADR 0025), so the dashboard shows it with the log's last
 * line; null clears it. A verify run has no job; a failed write never fails the step.
 */
const setupStep =
  (repo: string, ref: string, log: string, seen?: (c: Job["checking"] | null) => void) =>
  async (s: Step): Promise<void> => {
    if (isRunId(ref)) return;
    try {
      const id = findJob(repo, ref).id;
      const rel = path.relative(jobDirOf(repo, id), log);
      await updateJob(repo, id, (j) => {
        if (s) j.checking = { cmd: s.cmd, at: new Date().toISOString(), log: rel, setup: true, ...(s.of ? { of: s.of } : {}) };
        else if (j.checking?.setup) delete j.checking;
        seen?.(j.checking ? { ...j.checking } : null);
        return j;
      });
    } catch {}
  };

/** `seen`: each value the job's `checking` takes, as written (a seam for tests). */
export async function appUp(
  repo: string,
  ref: string,
  out: (l: string) => void,
  cfg: Config = loadConfig(repo),
  o: { seen?: (c: Job["checking"] | null) => void } = {},
): Promise<number> {
  const { id: jid, wt, out: dir } = jobPaths(repo, ref);
  const remote = runUrl(repo, jid);
  if (remote) {
    out(`app: this sweep drives ${remote}: Kitchen starts nothing here (kitchen qa page|http ${jid} <path> go there)`);
    return 1;
  }
  // ADR 0029 §2: QA again on what it couldn't test: the first `qa up` of that lane starts the app on fresh seed data.
  const fresh = !isRunId(jid) && !!findJob(repo, jid).qaRetry?.reset;
  if (fresh) await appDown(repo, jid);
  const had = readState(repo, jid);
  if (had && (had.legacy || (had.pid && alive(had.pid))) && (await healthy(join(had.url, cfg.app.health)))) {
    out(`app: up at ${had.url}`);
    return 0;
  }
  const log = path.join(dir, "app.log");
  const step = setupStep(repo, jid, log, o.seen);
  let code = 1;
  try {
    code = await startUp(repo, jid, wt, log, out, cfg, step);
    return code;
  } finally {
    await step(null);
    if (fresh && code === 0)
      await updateJob(repo, jid, (j) => {
        if (j.qaRetry) delete j.qaRetry.reset;
        return j;
      });
  }
}

async function startUp(
  repo: string,
  jid: string,
  wt: string,
  log: string,
  out: (l: string) => void,
  cfg: Config,
  step: (s: Step) => Promise<void>,
): Promise<number> {
  const prepare = prepareOf(cfg);
  if (prepare && fs.existsSync(path.join(wt, "package.json")) && !fs.existsSync(path.join(wt, "node_modules"))) {
    await step({ cmd: `Preparing · ${prepare}` });
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
    await step({ cmd: "Preparing · bin/dev prepare" });
    await runShell(`"${dev}" prepare --src "${wt}"`, { cwd: wt, timeoutSec: 1800, log });
    await step({ cmd: "Starting the app" });
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
  const r = await startApp(cfg, {
    wt,
    log,
    project: composeProject(cfg.app, jid),
    onSpawn: (st) => writeAtomic(stateFile(repo, jid), JSON.stringify(st)),
    onStep: step,
  });
  if (!r.ok) {
    await appDown(repo, jid);
    out(`app: ${r.why}; see ${path.relative(repo, log)}`);
    return 1;
  }
  out(`app: up at ${r.app.url} (pid ${r.app.pid}${r.app.project ? `, compose project ${r.app.project}` : ""}, log ${path.relative(repo, log)})`);
  return 0;
}

/**
 * ADR 0021 §4: the compose project a job's app runs in (`kq<job number>`, `kq-<run>` for a verify run), or null when
 * `app.start` doesn't run `docker compose` / `docker-compose`. Containers, networks and volumes are then per job.
 */
export const COMPOSE = /(?<![\w-])(docker[ \t]+compose|docker-compose)(?![\w-])/;
export function composeProject(app: Pick<AppConfig, "start">, id: string): string | null {
  if (!COMPOSE.test(app.start)) return null;
  const num = /^(\d+)-/.exec(id)?.[1];
  return (num ? `kq${num}` : `kq-${id}`).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

/** Pure: what the app's commands (start, reset, stop) get on top of Kitchen's environment. */
export function appEnv(o: { port: number; project: string | null }): Record<string, string> {
  return { PORT: String(o.port), ...(o.project ? { COMPOSE_PROJECT_NAME: o.project } : {}) };
}

/** Pure: what runs after the app's process ends: `app.stop`, else a compose app's `docker compose -p <project> down -v`. */
export function stopCommand(app: Pick<AppConfig, "stop">, project: string | null): string | null {
  return app.stop ?? (project ? `docker compose -p ${project} down -v` : null);
}

/** A started app: what stopping it needs. `stop` and `env` are filled at start, so a later config edit can't strand it. */
export type Started = { pid?: number; port: number; url: string; at: string; project?: string; wt: string; stop?: string; env?: Record<string, string> };

/**
 * Start the app from `wt` as kitchen.yaml `app:` says: `app.reset`, then `app.start` on a free port (in $PORT and
 * `{port}`), then wait for the health check. `onSpawn` gets the state as soon as there is a process to stop; `onStep`
 * each step as it begins (ADR 0029 §4).
 * Shared by `kitchen qa up` and the merge gate's `needs_app` checks.
 */
export async function startApp(
  cfg: Config,
  o: { wt: string; log: string; project: string | null; onSpawn?: (s: Started) => void; onStep?: (s: Step) => Promise<void> },
): Promise<{ ok: true; app: Started } | { ok: false; why: string; app?: Started }> {
  const port = cfg.app.port && !cfg.app.start.includes("{port}") && !(cfg.app.url ?? "").includes("{port}") ? cfg.app.port : await freePort();
  const extra = appEnv({ port, project: o.project });
  const env = { ...process.env, ...extra };
  const fill = (s: string) => s.replaceAll("{port}", String(port));
  const stop = stopCommand(cfg.app, o.project);
  if (cfg.app.reset) {
    await o.onStep?.({ cmd: "Resetting data" });
    const r = await runShell(fill(cfg.app.reset), { cwd: o.wt, timeoutSec: 300, log: o.log, env });
    if (!r.ok) return { ok: false, why: `app.reset failed (exit ${r.exit})` };
  }
  await o.onStep?.({ cmd: "Starting the app" });
  const fd = fs.openSync(o.log, "a");
  const child = spawn("/bin/sh", ["-c", fill(cfg.app.start)], { cwd: o.wt, env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.closeSync(fd);
  let exit: number | null | undefined;
  child.on("exit", (code) => {
    exit = code;
  });
  const url = fill(cfg.app.url ?? "http://127.0.0.1:{port}");
  const st: Started = {
    pid: child.pid,
    port,
    url,
    at: new Date().toISOString(),
    wt: o.wt,
    ...(o.project ? { project: o.project } : {}),
    ...(stop ? { stop: fill(stop), env: extra } : {}),
  };
  o.onSpawn?.(st);
  await o.onStep?.({ cmd: `Waiting for ${cfg.app.health}`, of: cfg.app.ready_timeout_sec });
  const end = Date.now() + cfg.app.ready_timeout_sec * 1000;
  while (Date.now() < end) {
    if (await healthy(join(url, cfg.app.health))) return { ok: true, app: st };
    // A start command that exits 0 (`docker compose up -d`) leaves the app running: keep waiting for the health check.
    if (exit !== undefined && exit !== 0) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, why: `not healthy at ${join(url, cfg.app.health)} within ${cfg.app.ready_timeout_sec}s`, app: st };
}

/** Stop what `startApp` started: its process group, then `app.stop` (or the compose project's down). */
export async function stopApp(s: Partial<Pick<Started, "pid" | "stop" | "env" | "wt">>, log?: string): Promise<void> {
  if (s.pid) {
    try {
      process.kill(-s.pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 30 && alive(s.pid); i++) await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(-s.pid, "SIGKILL");
    } catch {}
  }
  if (s.stop) await runShell(s.stop, { cwd: s.wt && fs.existsSync(s.wt) ? s.wt : process.cwd(), timeoutSec: 300, log, env: s.env });
}

export async function appDown(repo: string, ref: string, out: (l: string) => void = () => {}): Promise<number> {
  const id = isRunId(ref) ? ref : findJob(repo, ref).id;
  const s = readState(repo, id);
  if (!s) {
    out("app: not running");
    return 0;
  }
  if (s.legacy) await runShell(`"${s.legacy.dev}" down --id ${s.legacy.id}`, { cwd: s.legacy.wt, timeoutSec: 120 });
  else await stopApp(s);
  fs.rmSync(stateFile(repo, id), { force: true });
  out("app: stopped");
  return 0;
}

/**
 * ADR 0029 §5: stop every job's app (its app.json) whose job is not in a running lane: when a wave plan drains and
 * when `kitchen run` starts. The lines it says, one per app stopped.
 */
export async function sweepApps(repo: string): Promise<string[]> {
  const said: string[] = [];
  for (const j of listJobs(repo)) {
    if (j.running || !fs.existsSync(stateFile(repo, j.id))) continue;
    await appDown(repo, j.id).catch(() => {});
    said.push(`${j.id}  app stopped (no lane works on it)`);
  }
  return said;
}

/**
 * `kitchen qa reset`: the app down, `app.reset`, the app up again (appUp runs the reset), so the next criterion
 * starts on the seed data. Without an app.reset it only restarts, and says the data is what earlier checks left.
 */
export async function appReset(repo: string, ref: string, out: (l: string) => void, cfg: Config = loadConfig(repo)): Promise<number> {
  const remote = runUrl(repo, ref);
  if (remote) {
    out(`app: ${remote} is a deployed environment: Kitchen can't reset it. A recipe that needs fresh seed data is "not run: needs a fresh seed"`);
    return 1;
  }
  await appDown(repo, ref);
  const code = await appUp(repo, ref, out, cfg);
  if (code === 0 && cfg.app.start && !cfg.app.reset) out("app: restarted, but kitchen.yaml has no app.reset: the data is what earlier checks left (not fresh)");
  else if (code === 0 && cfg.app.reset) out(`app: reset (${cfg.app.reset}) and restarted on fresh data`);
  return code;
}

/**
 * ADR 0021 §3: a sweep run with `--url` drives that deployed environment: its URL (from the run's run.json, never a
 * job) is the base, and the only non-loopback origin `page` and `http` accept. Null for anything else.
 */
export function runUrl(repo: string, id: string): string | null {
  if (!isRunId(id)) return null;
  try {
    const u = (JSON.parse(fs.readFileSync(path.join(runDir(repo, id), "run.json"), "utf8")) as { url?: unknown }).url;
    return typeof u === "string" && /^https?:\/\//.test(u) ? u : null;
  } catch {
    return null;
  }
}

function baseUrl(repo: string, id: string): string | null {
  return runUrl(repo, id) ?? readState(repo, id)?.url ?? null;
}

/** Pure: `url` is this machine, or on the origin of the deployed URL a `--url` sweep drives. */
export function reachable(url: string, remote: string | null): boolean {
  if (LOOPBACK.test(url)) return true;
  if (!remote) return false;
  try {
    return new URL(url).origin === new URL(remote).origin;
  } catch {
    return false;
  }
}

/** Playwright, from Kitchen's own dependencies. */
function playwright(): { chromium: { launch(o: object): Promise<Browser>; executablePath(): string } } {
  const req = createRequire(import.meta.url);
  try {
    return req("playwright") as ReturnType<typeof playwright>;
  } catch {
    throw new Error("Playwright is missing from Kitchen's install: npm install in Kitchen's folder (it is a pinned dependency)");
  }
}
/** Kitchen's own folder: its package.json pins Playwright, and the browser is installed from there. */
const KITCHEN_DIR = path.resolve(import.meta.dirname, "..", "..");
/** ADR 0029 §4: the install command (KITCHEN_BROWSER_INSTALL: tests and hooks put a stand-in there, never a download). */
const INSTALL = "npx playwright install chromium";
const installCmd = () => process.env.KITCHEN_BROWSER_INSTALL || INSTALL;
/** The one line for a missing browser: `kitchen run` refuses with it, `kitchen qa page` says it. */
export const browserMissing = () => `the browser QA uses (Playwright's Chromium) isn't installed: run ${INSTALL} in ${KITCHEN_DIR}`;

/** ADR 0029 §4: Playwright's Chromium is on this machine: the full browser, or the headless shell a headless launch uses. */
export function browserReady(): boolean {
  try {
    const exe = playwright().chromium.executablePath();
    if (fs.existsSync(exe)) return true;
    const m = /^(.*[\\/])chromium-(\d+)[\\/]/.exec(exe);
    return !!m && fs.existsSync(`${m[1]}chromium_headless_shell-${m[2]}`);
  } catch {
    return false;
  }
}

/** ADR 0029 §4: QA here needs the browser: there is an app to drive, or an open job has a page criterion. */
export function browserNeeded(repo: string, cfg: Config): boolean {
  if (cfg.app.start) return true;
  return listJobs(repo).some(
    (j) => !j.archived && j.stage !== "done" && j.stage !== "rejected" && criteriaOf(jobDirOf(repo, j.id)).some((c) => c.check === "page"),
  );
}

/**
 * ADR 0029 §4: before QA needs it (`kitchen init`, `kitchen run`), Chromium is installed once when it is missing, its
 * output through `out`. Null when it is there (or isn't needed yet: then only a note), else the line to refuse with.
 * `ready` and `install` are seams for tests.
 */
export async function ensureBrowser(
  out: (l: string) => void,
  o: { needed?: boolean; ready?: () => boolean; install?: (out: (l: string) => void) => Promise<boolean> } = {},
): Promise<string | null> {
  const ready = o.ready ?? browserReady;
  if (ready()) return null;
  if (o.needed === false) {
    out(`note: ${browserMissing()} (nothing queued needs it yet)`);
    return null;
  }
  out("Installing the browser QA uses, once (~150 MB)…");
  const ok = await (o.install ?? installBrowser)(out);
  return ok && ready() ? null : browserMissing();
}

const installBrowser = (out: (l: string) => void) =>
  new Promise<boolean>((resolve) => {
    const c = spawn("/bin/sh", ["-c", installCmd()], { cwd: KITCHEN_DIR, stdio: ["ignore", "pipe", "pipe"] });
    const say = (d: Buffer) => {
      for (const l of d.toString("utf8").split("\n")) {
        const t = l.split("\r").at(-1)?.trim();
        if (t) out(`  ${t}`);
      }
    };
    c.stdout.on("data", say);
    c.stderr.on("data", say);
    c.on("error", () => resolve(false));
    c.on("close", (code) => resolve(code === 0));
  });

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
  if (!reachable(url, runUrl(repo, jid))) throw new Error(`page: ${url} is not this machine (127.0.0.1 or localhost only)`);
  let browser: Browser;
  try {
    browser = await playwright().chromium.launch({ headless: true });
  } catch (e) {
    // ADR 0029 §4: Playwright's own missing-browser error, as one line.
    if (!browserReady()) {
      out(`page: ${browserMissing()}`);
      return 1;
    }
    throw e;
  }
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
  if (!reachable(url, runUrl(repo, jid))) throw new Error(`http: ${url} is not this machine (127.0.0.1 or localhost only)`);
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
