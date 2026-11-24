// `kitchen collect --install-schedule [--every 1h]` / `--remove-schedule` (ADR 0022, amendment): a collect on a
// timer, by the OS. macOS: a launchd agent with StartCalendarInterval (a run missed while the Mac slept runs on wake);
// Linux: a systemd user timer with Persistent=true (the same). It runs `kitchen collect` in the repo, with the PATH
// it was installed from (gh, claude). One per repo, named from the repo's path.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Every = { minutes: number };
type Run = (cmd: string, args: string[]) => void;
const realRun: Run = (cmd, args) => {
  execFileSync(cmd, args, { stdio: "ignore", timeout: 20_000 });
};

/** Pure: "30m", "1h", "2h", "1d" → minutes. Divides an hour or a day, so the clock times are even. */
export function parseEvery(s = "1h"): Every {
  const m = /^(\d+)\s*(m|min|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`--every takes 15m, 30m, 1h, 2h… or 1d (got ${s})`);
  const minutes = Number(m[1]) * (m[2] === "h" ? 60 : m[2] === "d" ? 1440 : 1);
  if (minutes < 15) throw new Error("--every: at least 15m");
  if (minutes < 60 ? 60 % minutes : minutes < 1440 ? 1440 % minutes : minutes !== 1440)
    throw new Error("--every: a divisor of an hour (15m, 20m, 30m) or of a day (1h, 2h, 3h, 4h, 6h, 8h, 12h), or 1d");
  return { minutes };
}

export const scheduleId = (repo: string) => `dev.kitchen.collect.${createHash("sha256").update(path.resolve(repo)).digest("hex").slice(0, 10)}`;

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
export function systemdUnits(o: { id: string; argv: string[]; repo: string; every: Every; path: string }): { service: string; timer: string } {
  const q = (a: string) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);
  const cal = slots(o.every)
    .map((s) => `OnCalendar=*-*-* ${s.hour === null ? "*" : String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}:00`)
    .join("\n");
  return {
    service: `[Unit]\nDescription=Kitchen collect (${o.repo})\n\n[Service]\nType=oneshot\nWorkingDirectory=${o.repo}\nEnvironment=PATH=${o.path}\nExecStart=${o.argv.map(q).join(" ")}\n`,
    timer: `[Unit]\nDescription=Kitchen collect (${o.repo}), on a timer\n\n[Timer]\n${cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export type Where = { platform?: NodeJS.Platform; home?: string; run?: Run; uid?: number };

export function installSchedule(repo: string, cli: string, every: Every, w: Where = {}): string[] {
  const platform = w.platform ?? process.platform;
  const home = w.home ?? os.homedir();
  const run = w.run ?? realRun;
  const id = scheduleId(repo);
  const argv = [process.execPath, cli, "collect", "--repo", path.resolve(repo)];
  const PATH = process.env.PATH ?? "/usr/bin:/bin";
  if (platform === "darwin") {
    const f = path.join(home, "Library", "LaunchAgents", `${id}.plist`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const log = path.join(repo, ".kitchen", "collect.log");
    const domain = `gui/${w.uid ?? process.getuid?.() ?? 501}`;
    if (fs.existsSync(f))
      try {
        run("launchctl", ["bootout", `${domain}/${id}`]);
      } catch {}
    fs.writeFileSync(f, launchdPlist({ id, argv, repo: path.resolve(repo), every, path: PATH, log }));
    run("launchctl", ["bootstrap", domain, f]);
    return [`installed ${f}`, `collect runs every ${label(every)} (a run missed while asleep runs on wake); the log is .kitchen/collect.log`];
  }
  if (platform === "linux") {
    const d = path.join(home, ".config", "systemd", "user");
    fs.mkdirSync(d, { recursive: true });
    const u = systemdUnits({ id, argv, repo: path.resolve(repo), every, path: PATH });
    fs.writeFileSync(path.join(d, `${id}.service`), u.service);
    fs.writeFileSync(path.join(d, `${id}.timer`), u.timer);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${id}.timer`]);
    return [`installed ${path.join(d, `${id}.timer`)}`, `collect runs every ${label(every)} (Persistent=true: a missed run runs on wake)`];
  }
  throw new Error(`no scheduler Kitchen knows on ${platform}: run kitchen collect --detach from your own scheduler`);
}

export function removeSchedule(repo: string, w: Where = {}): string[] {
  const platform = w.platform ?? process.platform;
  const home = w.home ?? os.homedir();
  const run = w.run ?? realRun;
  const id = scheduleId(repo);
  if (platform === "darwin") {
    const f = path.join(home, "Library", "LaunchAgents", `${id}.plist`);
    if (!fs.existsSync(f)) return ["no schedule installed for this repo"];
    try {
      run("launchctl", ["bootout", `gui/${w.uid ?? process.getuid?.() ?? 501}/${id}`]);
    } catch {}
    fs.rmSync(f, { force: true });
    return [`removed ${f}`];
  }
  if (platform === "linux") {
    const d = path.join(home, ".config", "systemd", "user");
    if (!fs.existsSync(path.join(d, `${id}.timer`))) return ["no schedule installed for this repo"];
    try {
      run("systemctl", ["--user", "disable", "--now", `${id}.timer`]);
    } catch {}
    fs.rmSync(path.join(d, `${id}.timer`), { force: true });
    fs.rmSync(path.join(d, `${id}.service`), { force: true });
    return [`removed ${path.join(d, `${id}.timer`)}`];
  }
  return ["no schedule installed for this repo"];
}

const label = (e: Every) => (e.minutes % 60 ? `${e.minutes} minutes` : e.minutes === 60 ? "hour" : `${e.minutes / 60} hours`);
