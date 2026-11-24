// `kitchen collect --install-schedule [--every 1h]` / `--remove-schedule` (ADR 0022, amendment): a collect on a
// timer, by the OS. macOS: a launchd agent with StartCalendarInterval (a run missed while the Mac slept runs on wake);
// Linux: a systemd user timer with Persistent=true (the same). It runs `kitchen collect` in the repo, with the PATH
// it was installed from (gh, claude). One per repo, named from the repo's path.
//
// ADR 0028 §5: the same writer files a check on a timer (`kitchen ticket --check --every day "<text>"`): one schedule
// per repo and check text, which runs `kitchen ticket --check` with that text on each tick. `--every off` with the
// same text removes it; `kitchen schedules` lists what this repo has (.kitchen/schedules.json, kept by the CLI).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Every = { minutes: number };
/** What a schedule runs: a collect, or ADR 0028's check (its ticket text). */
export type Task = { name: "collect" } | { name: "check"; text: string; into?: string };
const COLLECT: Task = { name: "collect" };
type Run = (cmd: string, args: string[]) => void;
const realRun: Run = (cmd, args) => {
  execFileSync(cmd, args, { stdio: "ignore", timeout: 20_000 });
};

/** The words `--every` takes besides a number: hour, day (and hourly, daily). */
const WORDS: Record<string, string> = { hour: "1h", hourly: "1h", day: "1d", daily: "1d" };

/** Pure: "30m", "1h", "2h", "1d", "hour", "day" → minutes. Divides an hour or a day, so the clock times are even. */
export function parseEvery(s = "1h"): Every {
  const t = WORDS[s.trim().toLowerCase()] ?? s.trim();
  const m = /^(\d+)\s*(m|min|h|d)$/.exec(t);
  if (!m) throw new Error(`--every takes 15m, 30m, 1h, 2h… 1d, hour or day (got ${s})`);
  const minutes = Number(m[1]) * (m[2] === "h" ? 60 : m[2] === "d" ? 1440 : 1);
  if (minutes < 15) throw new Error("--every: at least 15m");
  if (minutes < 60 ? 60 % minutes : minutes < 1440 ? 1440 % minutes : minutes !== 1440)
    throw new Error("--every: a divisor of an hour (15m, 20m, 30m) or of a day (1h, 2h, 3h, 4h, 6h, 8h, 12h), or 1d");
  return { minutes };
}

const hash = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);
/** One collect per repo; one check per repo and text (the same text again replaces it). */
export const scheduleId = (repo: string, task: Task = COLLECT) =>
  task.name === "collect"
    ? `dev.kitchen.collect.${hash(path.resolve(repo), 10)}`
    : `dev.kitchen.check.${hash(path.resolve(repo), 10)}.${hash(task.text.replace(/\s+/g, " ").trim(), 8)}`;

/** Pure: what the OS runs on each tick. A check says it came from this schedule, and how often (`--from-schedule day`). */
export function argvOf(node: string, cli: string, repo: string, task: Task = COLLECT, every?: Every): string[] {
  return task.name === "collect"
    ? [node, cli, "collect", "--repo", path.resolve(repo)]
    : [
        node,
        cli,
        "ticket",
        "--check",
        "--repo",
        path.resolve(repo),
        ...(task.into ? ["--into", task.into] : []),
        ...(every ? ["--from-schedule", label(every)] : []),
        task.text.replace(/\s+/g, " ").trim(),
      ];
}
const what = (t: Task) => (t.name === "collect" ? "Kitchen collect" : "Kitchen check");
const logOf = (t: Task) => (t.name === "collect" ? "collect.log" : "checks.log");

/** Pure: the times of day, as (hour or null for every hour, minute). */
export function slots(e: Every): { hour: number | null; minute: number }[] {
  if (e.minutes < 60) return Array.from({ length: 60 / e.minutes }, (_, i) => ({ hour: null, minute: i * e.minutes }));
  const hours = e.minutes / 60;
  if (hours === 1) return [{ hour: null, minute: 0 }];
  return Array.from({ length: 24 / hours }, (_, i) => ({ hour: i * hours, minute: 0 }));
}

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Pure: the launchd agent. */
export function launchdPlist(o: { id: string; argv: string[]; repo: string; every: Every; path: string; log: string }): string {
  const cal = slots(o.every)
    .map((s) => `      <dict>${s.hour === null ? "" : `<key>Hour</key><integer>${s.hour}</integer>`}<key>Minute</key><integer>${s.minute}</integer></dict>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(o.id)}</string>
  <key>ProgramArguments</key>
  <array>
${o.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(o.repo)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(o.path)}</string></dict>
  <key>StartCalendarInterval</key>
  <array>
${cal}
  </array>
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

/** Pure: the systemd service and timer. */
export function systemdUnits(o: { id: string; argv: string[]; repo: string; every: Every; path: string; what?: string }): { service: string; timer: string } {
  const name = o.what ?? "Kitchen collect";
  const q = (a: string) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);
  const cal = slots(o.every)
    .map((s) => `OnCalendar=*-*-* ${s.hour === null ? "*" : String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}:00`)
    .join("\n");
  return {
    service: `[Unit]\nDescription=${name} (${o.repo})\n\n[Service]\nType=oneshot\nWorkingDirectory=${o.repo}\nEnvironment=PATH=${o.path}\nExecStart=${o.argv.map(q).join(" ")}\n`,
    timer: `[Unit]\nDescription=${name} (${o.repo}), on a timer\n\n[Timer]\n${cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export type Where = { platform?: NodeJS.Platform; home?: string; run?: Run; uid?: number };

export function installSchedule(repo: string, cli: string, every: Every, w: Where = {}, task: Task = COLLECT): string[] {
  const platform = w.platform ?? process.platform;
  const home = w.home ?? os.homedir();
  const run = w.run ?? realRun;
  const id = scheduleId(repo, task);
  const argv = argvOf(process.execPath, cli, repo, task, every);
  const runs = task.name === "collect" ? "collect runs" : `the check "${task.text.slice(0, 60)}" is filed`;
  const PATH = process.env.PATH ?? "/usr/bin:/bin";
  if (platform === "darwin") {
    const f = path.join(home, "Library", "LaunchAgents", `${id}.plist`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const log = path.join(repo, ".kitchen", logOf(task));
    const domain = `gui/${w.uid ?? process.getuid?.() ?? 501}`;
    if (fs.existsSync(f))
      try {
        run("launchctl", ["bootout", `${domain}/${id}`]);
      } catch {}
    fs.writeFileSync(f, launchdPlist({ id, argv, repo: path.resolve(repo), every, path: PATH, log }));
    run("launchctl", ["bootstrap", domain, f]);
    return [`installed ${f}`, `${runs} every ${label(every)} (a run missed while asleep runs on wake); the log is .kitchen/${logOf(task)}`];
  }
  if (platform === "linux") {
    const d = path.join(home, ".config", "systemd", "user");
    fs.mkdirSync(d, { recursive: true });
    const u = systemdUnits({ id, argv, repo: path.resolve(repo), every, path: PATH, what: what(task) });
    fs.writeFileSync(path.join(d, `${id}.service`), u.service);
    fs.writeFileSync(path.join(d, `${id}.timer`), u.timer);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${id}.timer`]);
    return [`installed ${path.join(d, `${id}.timer`)}`, `${runs} every ${label(every)} (Persistent=true: a missed run runs on wake)`];
  }
  throw new Error(
    `no scheduler Kitchen knows on ${platform}: run ${task.name === "collect" ? "kitchen collect --detach" : 'kitchen ticket --check "…"'} from your own scheduler`,
  );
}

export function removeSchedule(repo: string, w: Where = {}, task: Task = COLLECT): string[] {
  const platform = w.platform ?? process.platform;
  const home = w.home ?? os.homedir();
  const run = w.run ?? realRun;
  const id = scheduleId(repo, task);
  const none = task.name === "collect" ? "no schedule installed for this repo" : `no schedule for the check "${task.text.slice(0, 60)}" in this repo`;
  if (platform === "darwin") {
    const f = path.join(home, "Library", "LaunchAgents", `${id}.plist`);
    if (!fs.existsSync(f)) return [none];
    try {
      run("launchctl", ["bootout", `gui/${w.uid ?? process.getuid?.() ?? 501}/${id}`]);
    } catch {}
    fs.rmSync(f, { force: true });
    return [`removed ${f}`];
  }
  if (platform === "linux") {
    const d = path.join(home, ".config", "systemd", "user");
    if (!fs.existsSync(path.join(d, `${id}.timer`))) return [none];
    try {
      run("systemctl", ["--user", "disable", "--now", `${id}.timer`]);
    } catch {}
    fs.rmSync(path.join(d, `${id}.timer`), { force: true });
    fs.rmSync(path.join(d, `${id}.service`), { force: true });
    return [`removed ${path.join(d, `${id}.timer`)}`];
  }
  return [none];
}

export const label = (e: Every) =>
  e.minutes % 60 ? `${e.minutes} minutes` : e.minutes === 60 ? "hour" : e.minutes === 1440 ? "day" : `${e.minutes / 60} hours`;

/** ADR 0028: this repo's schedules as the CLI installed them (`kitchen schedules`), in .kitchen/schedules.json. */
export type Kept = { id: string; task: Task; every: string; at: string };
const keptFile = (repo: string) => path.join(repo, ".kitchen", "schedules.json");
export function listKept(repo: string): Kept[] {
  try {
    return JSON.parse(fs.readFileSync(keptFile(repo), "utf8")) as Kept[];
  } catch {
    return [];
  }
}
/** Record (every) or forget (null) one schedule of this repo. */
export function keep(repo: string, task: Task, every: Every | null, now = new Date()) {
  const id = scheduleId(repo, task);
  const rest = listKept(repo).filter((k) => k.id !== id);
  const next = every ? [...rest, { id, task, every: label(every), at: now.toISOString() }] : rest;
  fs.mkdirSync(path.dirname(keptFile(repo)), { recursive: true });
  fs.writeFileSync(keptFile(repo), `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * ADR 0028 §5, `kitchen ticket --check --every <when> "<text>"`: install (or, with `off`, remove) the schedule that
 * files this check on each tick, and keep this repo's list (`kitchen schedules`) in step.
 */
export function scheduleCheck(repo: string, cli: string, text: string, every: string, w: Where = {}, into?: string): string[] {
  const task: Task = { name: "check", text: text.replace(/\s+/g, " ").trim(), ...(into ? { into } : {}) };
  if (!task.text) throw new Error('kitchen ticket --check --every needs the check\'s text: "<what to check>"');
  if (/^(off|never|none|remove)$/i.test(every.trim())) {
    const lines = removeSchedule(repo, w, task);
    keep(repo, task, null);
    return lines;
  }
  const e = parseEvery(every);
  const lines = installSchedule(repo, cli, e, w, task);
  keep(repo, task, e);
  return [...lines, `remove it with: kitchen ticket --check --every off "${task.text}"`];
}

/** `kitchen schedules`: what this repo runs on a timer, each with the command that removes it. */
export function schedulesLines(repo: string): string[] {
  const ks = listKept(repo);
  if (!ks.length) return ['no schedules for this repo (kitchen ticket --check --every day "…", kitchen collect --install-schedule)'];
  return ks.map((k) =>
    k.task.name === "collect"
      ? `every ${k.every}  collect   remove: kitchen collect --remove-schedule`
      : `every ${k.every}  check "${k.task.text}"${k.task.into ? ` on ${k.task.into}` : ""}   remove: kitchen ticket --check --every off "${k.task.text}"`,
  );
}
