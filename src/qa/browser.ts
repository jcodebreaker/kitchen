// ADR 0034: the browser QA drives pages with. The one installed on the machine: Google Chrome, then Microsoft Edge,
// then Playwright's Chromium (or its headless shell), only if it is already on disk. `browser:` in kitchen.yaml pins
// one, and the others are never tried. Kitchen never downloads a browser: the install command is only ever said.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";

export type Channel = "chrome" | "msedge";
/** The browser QA uses: a channel Playwright drives (Chrome, Edge), or Playwright's own Chromium (no channel). */
export type BrowserChoice = { channel?: Channel; name: string; executable: string };
export type BrowserPin = NonNullable<Config["browser"]>;

/** Kitchen's own folder: its package.json pins Playwright, whose Chromium `npx playwright install chromium` there fetches. */
export const KITCHEN_DIR = path.resolve(import.meta.dirname, "..", "..");

/** Playwright's Chromium for Kitchen's pinned Playwright: npx resolves it from Kitchen's own node_modules. */
const dirArg = /^[\w./-]+$/.test(KITCHEN_DIR) ? KITCHEN_DIR : `'${KITCHEN_DIR.replace(/'/g, "'\\''")}'`;
export const CHROMIUM_INSTALL = `(cd ${dirArg} && npx playwright install chromium)`;

/**
 * ADR 0034 §2, §4: what QA lacks and how to get it. No pin: any browser; a pin: that one, or take the pin out.
 * `refusal` is the one line `kitchen run` refuses with and `kitchen qa page` says; doctor shows `fix`.
 */
export function browserNeed(pin?: BrowserPin): { refusal: string; fix: string } {
  const fix = !pin
    ? `install Google Chrome, or run \`${CHROMIUM_INSTALL}\``
    : pin === "chromium"
      ? `run \`${CHROMIUM_INSTALL}\`, or take browser: out`
      : `install ${pin === "chrome" ? "Google Chrome" : "Microsoft Edge"}, or take browser: out`;
  const what = pin ? `QA needs ${pin === "chromium" ? "Playwright's Chromium" : NAME[pin]} (browser: ${pin} in kitchen.yaml)` : "QA needs a browser";
  return { refusal: `${what}: ${fix}`, fix };
}

const NAME: Record<BrowserPin, string> = { chrome: "Chrome", msedge: "Edge", chromium: "Chromium" };

/** What resolving looks at, never launching anything: a seam for tests. */
export type Probe = {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  exists(p: string): boolean;
  /** The command's path on PATH, or null. */
  which(cmd: string): string | null;
  /** Playwright's Chromium on disk (the full browser, or the headless shell a headless launch uses), or null. */
  chromium(): string | null;
};

/** Pure: the paths Playwright's own channel lookup uses (a found browser elsewhere is launched by its path). */
function standardPaths(ch: Channel, p: Pick<Probe, "platform" | "env">): string[] {
  const mac = {
    chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    msedge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  };
  const linux = { chrome: "/opt/google/chrome/chrome", msedge: "/opt/microsoft/msedge/msedge" };
  const win = { chrome: "\\Google\\Chrome\\Application\\chrome.exe", msedge: "\\Microsoft\\Edge\\Application\\msedge.exe" };
  if (p.platform === "darwin") return [mac[ch]];
  if (p.platform === "win32")
    return [p.env.LOCALAPPDATA, p.env.PROGRAMFILES, p.env["PROGRAMFILES(X86)"]].filter((d): d is string => !!d).map((d) => `${d}${win[ch]}`);
  return [linux[ch]];
}

/** Pure on its probe: where Chrome or Edge is installed, found without launching it, or null. */
function findChannel(ch: Channel, p: Probe): string | null {
  const app = ch === "chrome" ? "Google Chrome.app/Contents/MacOS/Google Chrome" : "Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const paths = [...standardPaths(ch, p), ...(p.platform === "darwin" ? [path.join(p.home, "Applications", app)] : [])];
  const found = paths.find((f) => p.exists(f));
  if (found || p.platform === "darwin" || p.platform === "win32") return found ?? null;
  const cmds = ch === "chrome" ? ["google-chrome", "google-chrome-stable"] : ["microsoft-edge", "microsoft-edge-stable"];
  return cmds.map((c) => p.which(c)).find((f): f is string => !!f) ?? null;
}

/**
 * ADR 0034 §1, §4: every browser QA could use, in order: Chrome, then Edge, then Playwright's Chromium already on
 * disk; with `browser:` pinned, that one only. Empty when none is there. Nothing is launched or installed.
 */
export function resolveBrowsers(cfg: Pick<Config, "browser">, p: Probe = machine()): BrowserChoice[] {
  const order: BrowserPin[] = cfg.browser ? [cfg.browser] : ["chrome", "msedge", "chromium"];
  const found: BrowserChoice[] = [];
  for (const b of order) {
    if (b === "chromium") {
      const exe = p.chromium();
      if (exe) found.push({ name: NAME.chromium, executable: exe });
      continue;
    }
    const exe = findChannel(b, p);
    if (exe) found.push({ channel: b, name: NAME[b], executable: exe });
  }
  return found;
}

/** The browser QA will use first (what `kitchen doctor` names), or null. */
export const resolveBrowser = (cfg: Pick<Config, "browser">, p: Probe = machine()): BrowserChoice | null => resolveBrowsers(cfg, p)[0] ?? null;

/** Pure: up to five lines of why a browser didn't start (Playwright's error, its browser log). */
const whyLines = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5);

export type Launched<B> = { browser: B; choice: BrowserChoice; failed: { choice: BrowserChoice; why: string[] }[] };

/**
 * ADR 0034: start the first browser that launches, in order; one that fails is said and the next is tried. None
 * found: the refusal. All failed: each one's lines, and how to pin one. `launch` and `probe` are seams for tests.
 */
export async function launchBrowser<B>(
  cfg: Pick<Config, "browser">,
  o: { probe?: Probe; launch?: (b: BrowserChoice) => Promise<B> } = {},
): Promise<Launched<B> | { refusal: string }> {
  const all = resolveBrowsers(cfg, o.probe);
  if (!all.length) return { refusal: browserNeed(cfg.browser).refusal };
  const launch = o.launch ?? ((b: BrowserChoice) => playwright<B>().chromium.launch(launchOptions(b)));
  const failed: Launched<B>["failed"] = [];
  for (const choice of all) {
    try {
      return { browser: await launch(choice), choice, failed };
    } catch (e) {
      failed.push({ choice, why: whyLines(e) });
    }
  }
  const hint = cfg.browser ? `browser: ${cfg.browser} is pinned in kitchen.yaml: pin another, or take it out` : "pin one with browser: in kitchen.yaml";
  return { refusal: [`no browser QA found would start: ${hint}`, ...failedLines(failed)].join("\n") };
}

/** Pure: each browser that didn't start, with its lines. */
export const failedLines = (failed: Launched<unknown>["failed"]) =>
  failed.flatMap((f) => [`  ${f.choice.name} (${f.choice.executable}) didn't start:`, ...f.why.map((l) => `    ${l}`)]);

/** Pure: Playwright's launch options: headless, by channel (and by path when it isn't where Playwright looks). */
export function launchOptions(b: BrowserChoice, p: Pick<Probe, "platform" | "env"> = machine()): Record<string, unknown> {
  // Playwright's Chromium by its own binary: the full browser when that is what's there, else the headless shell.
  if (!b.channel) return { headless: true, executablePath: b.executable };
  const real = (f: string) => {
    try {
      return fs.realpathSync(f);
    } catch {
      return f;
    }
  };
  const std = standardPaths(b.channel, p).map(real);
  return { headless: true, channel: b.channel, ...(std.includes(real(b.executable)) ? {} : { executablePath: b.executable }) };
}

/** Pure: "Chrome 158" from the name and Playwright's `browser.version()` ("158.0.7444.12"). */
export const browserWords = (b: { name: string; version: string }) => `${b.name} ${b.version.split(".")[0]}`;

type PlaywrightBrowser = { version(): string; close(): Promise<void> };
/** Playwright, from Kitchen's own dependencies. */
export function playwright<B = PlaywrightBrowser>(): { chromium: { launch(o: object): Promise<B>; executablePath(): string } } {
  const req = createRequire(import.meta.url);
  try {
    return req("playwright") as ReturnType<typeof playwright<B>>;
  } catch {
    throw new Error("Playwright is missing from Kitchen's install: npm install in Kitchen's folder (it is a pinned dependency)");
  }
}

/** Playwright's Chromium on this machine: the full browser, else the headless shell's own binary; else null. */
function chromiumOnDisk(): string | null {
  try {
    const exe = playwright().chromium.executablePath();
    if (fs.existsSync(exe)) return exe;
    const m = /^(.*[\\/])chromium-(\d+)[\\/]/.exec(exe);
    return m ? headlessShell(`${m[1]}chromium_headless_shell-${m[2]}`) : null;
  } catch {
    return null;
  }
}

/** The binary in a chromium_headless_shell-N folder (chrome-headless-shell-<platform>/chrome-headless-shell[.exe]). */
export function headlessShell(dir: string): string | null {
  try {
    for (const d of fs.readdirSync(dir).filter((x) => x.startsWith("chrome-headless-shell")))
      for (const f of ["chrome-headless-shell", "chrome-headless-shell.exe"]) if (fs.existsSync(path.join(dir, d, f))) return path.join(dir, d, f);
  } catch {}
  return null;
}

/** The machine Kitchen runs on: file checks and PATH lookups only, no process started. */
export function machine(): Probe {
  const env = process.env;
  return {
    platform: process.platform,
    home: os.homedir(),
    env,
    exists: (f) => fs.existsSync(f),
    which: (cmd) => {
      for (const d of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
        const f = path.join(d, cmd);
        try {
          fs.accessSync(f, fs.constants.X_OK);
          if (fs.statSync(f).isFile()) return f;
        } catch {}
      }
      return null;
    },
    chromium: chromiumOnDisk,
  };
}

/**
 * ADR 0034 §2: before QA needs it (`kitchen run`'s preflight): the browser QA will use, or the line to refuse with.
 * Not needed yet (no app, no page criterion): a note, never a refusal. Nothing is ever installed.
 */
export function ensureBrowser(
  out: (l: string) => void,
  cfg: Pick<Config, "browser">,
  o: { needed?: boolean; probe?: Probe } = {},
): { browser: BrowserChoice | null; refusal: string | null } {
  const browser = resolveBrowser(cfg, o.probe);
  if (browser) return { browser, refusal: null };
  const { refusal } = browserNeed(cfg.browser);
  if (o.needed === false) {
    out(`note: ${refusal} (nothing queued needs it yet)`);
    return { browser: null, refusal: null };
  }
  return { browser: null, refusal };
}
