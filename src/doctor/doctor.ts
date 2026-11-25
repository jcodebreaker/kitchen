// `kitchen doctor` (ADR 0033 §3): the project's setup, checked before a run needs it. By default it runs nothing of
// the app: kitchen.yaml `requires:` checks, the browser, and what kitchen.yaml says about the app. `--app` tries the
// prepare step, app.start, the health check and the stop once on a throwaway checkout of HEAD (.kitchen/doctor/wt,
// removed after); `--reset` runs app.reset too. Both start the app with the person's environment, so each is said
// first and only ever run when asked: Kitchen can't tell from a command whether it touches the person's own data.
// `kitchen init` runs the default report. `kitchen run`'s preflight refuses on a failing `requires`.
import fs from "node:fs";
import path from "node:path";
import { prepareOf, runShell } from "../checks/run-checks.ts";
import { type Config, loadConfig } from "../config.ts";
import { git, revParse } from "../engine/git.ts";
import { dropTrial } from "../engine/staging.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { processStart, withFileLock } from "../lock.ts";
import {
  appEnv,
  composeProject,
  doctorAppFile,
  fixedPort,
  freePort,
  healthy,
  join,
  portInUse,
  portWords,
  type Started,
  startApp,
  stopApp,
  stopCommand,
  stopDoctorLeftover,
} from "../qa/app.ts";
import { browserNeed, type Probe, resolveBrowser } from "../qa/browser.ts";

export type Row = { what: string; state: "ok" | "missing" | "failing" | "not tried" | "set"; detail: string; fix?: string };
export type Report = { rows: Row[] };

const doctorDir = (repo: string) => path.join(kitchenDir(repo), "doctor");
const lastLine = (s: string) => s.trim().split("\n").at(-1)?.slice(0, 160) ?? "";
/** The lines said before the app's steps run (ADR 0033 §3): what they may touch. */
export const APP_WARNING =
  "this starts your app with your shell's environment: if it migrates or seeds on start, it touches whatever DATABASE_URL/env points at";
export const RESET_WARNING = "this runs app.reset: it may wipe the data your local app uses";
/** Set by Ctrl-C or SIGTERM while the app's steps run. */
let interrupted = false;

/**
 * What a Ctrl-C or SIGTERM must end (ADR 0033 §3): the command running now (its process group: a `requires` check, a
 * prepare, a reset) and, once the app's steps began, their cleanup.
 */
export type Ctl = { running?: number; cleanUp?: () => Promise<void> };
const track = (ctl: Ctl | undefined) => ({
  onSpawn: (pid: number | undefined) => {
    if (ctl) ctl.running = pid;
  },
});

/** Each `requires:` entry's check, run from the repo: ok, or failing with its fix. */
export async function requiresRows(repo: string, cfg: Config, log?: string, ctl?: Ctl): Promise<Row[]> {
  const rows: Row[] = [];
  for (const r of cfg.requires) {
    const x = await runShell(r.check, { cwd: repo, timeoutSec: 60, log, ...track(ctl) });
    if (ctl) ctl.running = undefined;
    rows.push(
      x.ok
        ? { what: `requires ${r.name}`, state: "ok", detail: r.check }
        : {
            what: `requires ${r.name}`,
            state: "failing",
            detail: `\`${r.check}\` exit ${x.exit ?? "timeout"}${lastLine(x.all) ? `: ${lastLine(x.all)}` : ""}`,
            fix: r.fix || `make \`${r.check}\` pass`,
          },
    );
  }
  return rows;
}

/** ADR 0033 §3: `kitchen run` refuses on the first failing `requires`: the line to say, or null. */
export async function requiresRefusal(repo: string, cfg: Config): Promise<string | null> {
  const bad = (await requiresRows(repo, cfg)).find((r) => r.state === "failing");
  return bad ? `${bad.what.replace(/^requires /, "")} isn't ready (${bad.detail}): ${bad.fix}` : null;
}

const resetMissing: Row = {
  what: "reset",
  state: "missing",
  detail: "no app.reset: QA's restarts keep the data earlier checks left",
  fix: "add app.reset: a command that puts the data back to its seed",
};
const notTried = (what: string, why: string, fix?: string): Row => ({ what, state: "not tried", detail: why, ...(fix ? { fix } : {}) });
const appMissing = (): Row[] => [
  {
    what: "start",
    state: "missing",
    detail: "no app.start: QA checks with tests and commands",
    fix: 'if there is an app, add app: start: "<a command that serves it on $PORT>" to kitchen.yaml',
  },
];

/** The rows for a fixed port someone else's app answers on: nothing tried there. */
const portRows = (port: number, reset?: Row): Row[] => [
  ...(reset ? [reset] : []),
  notTried(
    "start",
    `${portWords(port)}: Kitchen won't start a second one there, or stop it`,
    "stop what answers there and run kitchen doctor --app again, or drop the fixed port (app.port, a port in app.url) and serve on $PORT ({port}) so each job gets its own",
  ),
  notTried("health", "the app wasn't started"),
  notTried("stop", "the app wasn't started"),
];

/**
 * `--app` (and `--reset`): the prepare step, reset (only with `reset: true`), start, health and stop, once, on a
 * throwaway checkout of HEAD. A fixed port something already answers on is left alone (startApp refuses it). Ctrl-C
 * or SIGTERM ends what is running (a prepare, a reset, the app), runs a compose app's stop and removes the checkout;
 * a crash leaves .kitchen/doctor/app.json, which the next doctor and the orchestrator's sweep stop.
 */
export async function appRows(repo: string, cfg: Config, log: string, o: { reset?: boolean; ctl?: Ctl } = {}): Promise<Row[]> {
  const a = cfg.app;
  if (!a.start) return appMissing();
  const head = await revParse(repo, "HEAD");
  if (!head) return [a.reset ? notTried("reset", "the repo has no commit yet") : resetMissing, notTried("start", "the repo has no commit yet")];
  const wt = path.join(doctorDir(repo), "wt");
  const project = composeProject(a, "doctor");
  const fixed = fixedPort(a);
  const port = fixed ?? (await freePort());
  // Someone else's app on the fixed port: nothing is reset, started or stopped (startApp refuses it too).
  if (fixed && (await portInUse(fixed, join((a.url ?? "http://127.0.0.1:{port}").replaceAll("{port}", String(fixed)), a.health))))
    return portRows(fixed, a.reset ? notTried("reset", `port ${fixed} is in use`) : resetMissing);
  const env = appEnv({ port, project });
  let live: Started | undefined;
  const ctl: Ctl = o.ctl ?? {};
  // Once a reset or the app ran: what stops it (a compose app's `down`, or app.stop).
  let stopAfter: Parameters<typeof stopApp>[0] | undefined;
  const cleanUp = async () => {
    if (ctl.running) {
      try {
        process.kill(-ctl.running, "SIGKILL");
      } catch {}
      ctl.running = undefined;
    }
    if (live) await stopApp(live, log).catch(() => true);
    else if (stopAfter?.stop) await stopApp(stopAfter, log).catch(() => true);
    live = undefined;
    stopAfter = undefined;
    fs.rmSync(doctorAppFile(repo), { force: true });
    await dropTrial(repo, wt);
  };
  ctl.cleanUp = cleanUp;
  const sh = (cmd: string, secs: number, e?: Record<string, string>) =>
    runShell(cmd, { cwd: wt, timeoutSec: secs, log, env: e, ...track(ctl) }).finally(() => (ctl.running = undefined));
  const rows: Row[] = [];
  try {
    await dropTrial(repo, wt);
    await git(repo, ["worktree", "add", "-q", "--detach", wt, head]);
    // The prepare step QA runs in a fresh worktree (an install from the lockfile), never the person's node_modules.
    if (fs.existsSync(path.join(wt, "package.json")) && !fs.existsSync(path.join(wt, "node_modules"))) {
      const prepare = prepareOf(cfg);
      if (!prepare) rows.push(notTried("prepare", "no node_modules in a fresh checkout, and kitchen.yaml names no checks_install or checks_prepare"));
      else {
        const p = await sh(prepare, 1800);
        if (!p.ok)
          return [
            ...rows,
            {
              what: "prepare",
              state: "failing",
              detail: `\`${prepare}\` exit ${p.exit ?? "timeout"}`,
              fix: `run ${prepare} in a fresh checkout and fix what it says`,
            },
            notTried("start", "preparing failed"),
          ];
        rows.push({ what: "prepare", state: "ok", detail: prepare });
      }
    }
    const stop = stopCommand(a, project);
    if (!a.reset) rows.push(resetMissing);
    else if (!o.reset) rows.push(notTried("reset", "kitchen doctor --reset runs it (it may wipe the data your local app uses)"));
    else {
      stopAfter = { stop: stop?.replaceAll("{port}", String(port)), env, wt };
      const r = await sh(a.reset.replaceAll("{port}", String(port)), 300, env);
      if (!r.ok)
        return [
          ...rows,
          {
            what: "reset",
            state: "failing",
            detail: `\`${a.reset}\` exit ${r.exit ?? "timeout"}${lastLine(r.all) ? `: ${lastLine(r.all)}` : ""}`,
            fix: "run app.reset in a fresh checkout and fix what it says",
          },
          notTried("start", "the reset failed"),
        ];
      rows.push({ what: "reset", state: "ok", detail: a.reset });
    }
    const r = await startApp(
      { ...cfg, app: { ...a, reset: undefined } },
      {
        wt,
        log,
        project,
        port,
        onSpawn: (s) => {
          live = s;
          writeAtomic(
            doctorAppFile(repo),
            JSON.stringify({ ...s, owner: process.pid, ownerStart: processStart(process.pid), appStart: s.pid ? processStart(s.pid) : null }),
          );
        },
      },
    );
    if (!r.ok && r.step === "port") return [...rows, ...portRows(port)];
    const failed = r.ok ? null : r.step;
    rows.push(
      failed === "start"
        ? {
            what: "start",
            state: "failing",
            detail: r.ok ? "" : r.why,
            fix: "app.start must keep serving in the foreground on $PORT: run it in a fresh checkout and read the log",
          }
        : { what: "start", state: "ok", detail: a.start },
    );
    rows.push(
      failed === "health"
        ? {
            what: "health",
            state: "failing",
            detail: r.ok ? "" : r.why,
            fix: "check app.health (a path that answers 2xx/3xx once up), app.port/url and ready_timeout_sec",
          }
        : failed === "start"
          ? notTried("health", "the app didn't start")
          : { what: "health", state: "ok", detail: `${a.health} answered` },
    );
    const st = r.app;
    if (!st) return rows;
    const stopped = await stopApp(st, log);
    live = undefined;
    stopAfter = undefined;
    fs.rmSync(doctorAppFile(repo), { force: true });
    if (failed) return [...rows, notTried("stop", "the app wasn't up")];
    let still = false;
    for (let i = 0; i < 10; i++) {
      still = await healthy(join(st.url, a.health));
      if (!still) break;
      await new Promise((x) => setTimeout(x, 300));
    }
    rows.push(
      !stopped
        ? {
            what: "stop",
            state: "failing",
            detail: `\`${st.stop}\` failed`,
            fix: "run app.stop by hand and fix it (it runs after the app's process group ends)",
          }
        : still
          ? {
              what: "stop",
              state: "failing",
              detail: `${st.url} still answers after the stop`,
              fix: "add app.stop: a command that stops what app.start started (e.g. docker compose down)",
            }
          : { what: "stop", state: "ok", detail: st.stop ? `the process group ended, then \`${st.stop}\`` : "the process group ended" },
    );
    return rows;
  } finally {
    await cleanUp();
    ctl.cleanUp = undefined;
  }
}

/**
 * Pure: what kitchen.yaml says about the app, run by nothing. `kitchen init` says "set"; `kitchen doctor` without
 * `--app` says each step is not tried, and how to try it.
 */
export function staticRows(cfg: Pick<Config, "app">, o: { doctor?: boolean } = {}): Row[] {
  const a = cfg.app;
  if (!a.start) return appMissing();
  const stop = stopCommand(a, composeProject(a, "001-x"));
  const row = (what: string, detail: string, how = "kitchen doctor --app tries prepare/start/health/stop"): Row =>
    o.doctor ? { what, state: "not tried", detail: `${detail} (${how})` } : { what, state: "set", detail };
  return [
    a.reset ? row("reset", a.reset, "kitchen doctor --reset runs it: it may wipe the data your local app uses") : resetMissing,
    row("start", a.start),
    row("health", a.health),
    row("stop", stop ? `the process group, then \`${stop}\`` : "the process group"),
    ...(Object.keys(a.scenarios).length ? [{ what: "scenarios", state: "set" as const, detail: Object.keys(a.scenarios).join(", ") }] : []),
    ...(a.whoami ? [{ what: "whoami", state: "set" as const, detail: a.whoami }] : []),
  ];
}

/** ADR 0034 §2: which browser QA will use, or that none was found and how to get one. Nothing is installed. */
export function browserRow(cfg: Pick<Config, "browser">, probe?: Probe): Row {
  const b = resolveBrowser(cfg, probe);
  const pin = cfg.browser ? ` (browser: ${cfg.browser} in kitchen.yaml)` : "";
  if (b) return { what: "browser", state: "ok", detail: `${b.name}, for QA's pages${pin}: ${b.executable}` };
  const name = cfg.browser && { chrome: "Chrome", msedge: "Edge", chromium: "Playwright's Chromium" }[cfg.browser];
  return {
    what: "browser",
    state: "missing",
    detail: `${name ? `${name} isn't installed${pin}` : "no Chrome, Edge or Playwright's Chromium found"}: kitchen run refuses once QA here needs a browser`,
    fix: browserNeed(cfg.browser).fix,
  };
}

/** Another doctor holds the repo's doctor lock. */
export class DoctorBusy extends Error {}

/**
 * The whole report: requires, the browser QA uses, then the app: as kitchen.yaml sets it (`app` false: `init` for
 * init's wording), or tried (`app`, `reset`). One doctor at a time per repo: a second one is refused at once.
 */
export async function doctorReport(
  repo: string,
  cfg: Config = loadConfig(repo),
  o: { app?: boolean; reset?: boolean; init?: boolean } = {},
): Promise<Report & { log: string }> {
  fs.mkdirSync(doctorDir(repo), { recursive: true });
  const log = path.join(doctorDir(repo), "doctor.log");
  const lock = path.join(doctorDir(repo), ".lock");
  try {
    return await withFileLock(
      lock,
      async () => {
        // Ctrl-C or SIGTERM anywhere (a `requires` check, a prepare, a reset, the app): end it, clean up, exit.
        const ctl: Ctl = {};
        const onSignal = (sig: NodeJS.Signals) => {
          interrupted = true;
          if (ctl.running)
            try {
              process.kill(-ctl.running, "SIGKILL");
            } catch {}
          void (ctl.cleanUp?.() ?? Promise.resolve()).finally(() => {
            process.stderr.write(`kitchen doctor: ${sig}: ended what it started and removed its checkout\n`);
            process.exit(sig === "SIGINT" ? 130 : 143);
          });
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        try {
          fs.writeFileSync(log, "");
          await stopDoctorLeftover(repo);
          const req = await requiresRows(repo, cfg, log, ctl);
          const app = o.app || o.reset ? await appRows(repo, cfg, log, { reset: o.reset, ctl }) : staticRows(cfg, { doctor: !o.init });
          return { rows: [...req, browserRow(cfg), ...app], log };
        } finally {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        }
      },
      { timeoutMs: 0 },
    );
  } catch (e) {
    if (!/^lock .* held by/.test((e as Error).message)) throw e;
    let pid = "?";
    try {
      pid = String((JSON.parse(fs.readFileSync(lock, "utf8")) as { pid: number }).pid);
    } catch {}
    throw new DoctorBusy(`a kitchen doctor is already running (pid ${pid})`);
  }
}

/** Pure: the report's lines. */
export function doctorLines(r: Report): string[] {
  const out: string[] = [];
  for (const x of r.rows) {
    out.push(`  ${x.state.padEnd(9)} ${x.what.padEnd(18)} ${x.detail}`);
    if (x.fix && x.state !== "ok" && x.state !== "set") out.push(`  ${"".padEnd(9)} ${"".padEnd(18)} fix: ${x.fix}`);
  }
  return out;
}

export async function doctor(repo: string, out: (l: string) => void, o: { app?: boolean; reset?: boolean } = {}): Promise<number> {
  const app = o.app || o.reset;
  out(
    app
      ? `Project setup (ADR 0033): requires, then prepare, ${o.reset ? "reset, " : ""}start, health and stop once on a throwaway checkout of HEAD`
      : "Project setup (ADR 0033): requires, and the app as kitchen.yaml sets it (nothing of it runs without --app)",
  );
  if (app) out(`  ${APP_WARNING}`);
  if (o.reset) out(`  ${RESET_WARNING}`);
  let r: Report & { log: string };
  try {
    r = await doctorReport(repo, loadConfig(repo), { app, reset: o.reset });
  } catch (e) {
    if (!(e instanceof DoctorBusy)) throw e;
    out(e.message);
    return 1;
  }
  // Ctrl-C: the signal handler says so and exits; a report of the half-run is no report.
  if (interrupted) return new Promise<number>(() => {});
  for (const l of doctorLines(r)) out(l);
  const bad = r.rows.filter((x) => x.state === "failing").length;
  out(bad ? `${bad} failing: fix them, then kitchen doctor again (the log: ${path.relative(repo, r.log)})` : "Nothing failing.");
  return bad ? 1 : 0;
}
