// ADR 0034: QA uses the browser already installed (Chrome, then Edge, then Playwright's Chromium on disk), a pin in
// kitchen.yaml picks one, and Kitchen never downloads a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  type BrowserChoice,
  browserNeed,
  browserWords,
  CHROMIUM_INSTALL,
  ensureBrowser,
  headlessShell,
  KITCHEN_DIR,
  launchBrowser,
  launchOptions,
  machine,
  type Probe,
  playwright,
  resolveBrowser,
} from "./browser.ts";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const probe = (o: {
  platform?: NodeJS.Platform;
  files?: string[];
  on?: Record<string, string>;
  chromium?: string | null;
  env?: Record<string, string>;
}): Probe => ({
  platform: o.platform ?? "darwin",
  home: "/Users/ana",
  env: o.env ?? {},
  exists: (f) => (o.files ?? []).includes(f),
  which: (c) => o.on?.[c] ?? null,
  chromium: () => o.chromium ?? null,
});

test("ADR 0034 §1: Chrome, then Edge, then Playwright's Chromium already on disk; nothing found: null", () => {
  const all = probe({ files: [MAC_CHROME, MAC_EDGE], chromium: "/cache/chromium-1/chrome" });
  assert.deepEqual(resolveBrowser({}, all), { channel: "chrome", name: "Chrome", executable: MAC_CHROME });
  assert.deepEqual(resolveBrowser({}, probe({ files: [MAC_EDGE], chromium: "/c" })), { channel: "msedge", name: "Edge", executable: MAC_EDGE });
  assert.deepEqual(resolveBrowser({}, probe({ chromium: "/c/chromium_headless_shell-1" })), { name: "Chromium", executable: "/c/chromium_headless_shell-1" });
  assert.equal(resolveBrowser({}, probe({})), null);
  // ~/Applications on macOS; PATH on Linux; Program Files on Windows.
  const home = "/Users/ana/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(resolveBrowser({}, probe({ files: [home] }))?.executable, home);
  const lx = probe({ platform: "linux", on: { "google-chrome-stable": "/usr/bin/google-chrome-stable", "microsoft-edge": "/usr/bin/microsoft-edge" } });
  assert.deepEqual(resolveBrowser({}, lx), { channel: "chrome", name: "Chrome", executable: "/usr/bin/google-chrome-stable" });
  assert.equal(resolveBrowser({}, probe({ platform: "linux", on: { "microsoft-edge": "/usr/bin/microsoft-edge" } }))?.name, "Edge");
  const win = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.equal(resolveBrowser({}, probe({ platform: "win32", env: { PROGRAMFILES: "C:\\Program Files" }, files: [win] }))?.executable, win);
});

test("ADR 0034 §4: a pin tries that browser only; a missing one is the refusal", () => {
  const all = probe({ files: [MAC_CHROME, MAC_EDGE], chromium: "/c" });
  assert.equal(resolveBrowser({ browser: "msedge" }, all)?.name, "Edge");
  assert.deepEqual(resolveBrowser({ browser: "chromium" }, all), { name: "Chromium", executable: "/c" });
  const chromeOnly = probe({ files: [MAC_CHROME], chromium: "/c" });
  assert.equal(resolveBrowser({ browser: "msedge" }, chromeOnly), null, "Chrome and Chromium are never tried");
  const r = ensureBrowser(() => {}, { browser: "msedge" }, { needed: true, probe: chromeOnly });
  assert.deepEqual(r, { browser: null, refusal: "QA needs Edge (browser: msedge in kitchen.yaml): install Microsoft Edge, or take browser: out" });
  assert.equal(browserNeed("chrome").refusal, "QA needs Chrome (browser: chrome in kitchen.yaml): install Google Chrome, or take browser: out");
  assert.equal(
    browserNeed("chromium").refusal,
    `QA needs Playwright's Chromium (browser: chromium in kitchen.yaml): run \`${CHROMIUM_INSTALL}\`, or take browser: out`,
  );
});

test("ADR 0034 §2: the refusal and the note, word for word", () => {
  const BROWSER_MISSING = browserNeed().refusal;
  // The command installs the Chromium Kitchen's pinned Playwright looks for: npx run from Kitchen's own folder.
  assert.equal(CHROMIUM_INSTALL, `(cd ${KITCHEN_DIR} && npx playwright install chromium)`);
  assert.equal(BROWSER_MISSING, `QA needs a browser: install Google Chrome, or run \`${CHROMIUM_INSTALL}\``);
  const said: string[] = [];
  assert.deepEqual(
    ensureBrowser((l) => said.push(l), {}, { needed: false, probe: probe({}) }),
    { browser: null, refusal: null },
  );
  assert.deepEqual(said, [`note: ${BROWSER_MISSING} (nothing queued needs it yet)`]);
  assert.equal(ensureBrowser(() => {}, {}, { probe: probe({}) }).refusal, BROWSER_MISSING, "needed (or not known): refused");
  assert.equal(ensureBrowser(() => said.push("x"), {}, { probe: probe({ files: [MAC_CHROME] }) }).browser?.name, "Chrome");
  assert.equal(said.length, 1, "found: nothing said");
  assert.equal(browserWords({ name: "Chrome", version: "158.0.7444.12" }), "Chrome 158");
});

test("ADR 0034 §2: Kitchen never runs an installer, even with no browser and an npx on PATH", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-nobrowser-"));
  const mark = path.join(dir, "ran");
  fs.writeFileSync(path.join(dir, "npx"), `#!/bin/sh\necho "$@" > ${JSON.stringify(mark)}\n`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prev}`;
  try {
    const p = { ...machine(), exists: () => false, which: () => null, chromium: () => null };
    assert.equal(ensureBrowser(() => {}, {}, { needed: true, probe: p }).refusal, browserNeed().refusal);
    assert.equal(ensureBrowser(() => {}, { browser: "chromium" }, { needed: true, probe: p }).refusal, browserNeed("chromium").refusal);
  } finally {
    process.env.PATH = prev;
  }
  assert.equal(fs.existsSync(mark), false, "no npx (no playwright install) was started");
  const src = fs.readFileSync(path.join(import.meta.dirname, "browser.ts"), "utf8");
  assert.doesNotMatch(src, /node:child_process/, "resolving a browser starts no process");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ADR 0034 §1: launch options by channel; a browser outside Playwright's own lookup goes by its path", () => {
  const mac = { platform: "darwin" as const, env: {} };
  // Playwright's Chromium by its own binary: the full browser when only it is there, or the headless shell's.
  assert.deepEqual(launchOptions({ name: "Chromium", executable: "/c/chrome" }, mac), { headless: true, executablePath: "/c/chrome" });
  assert.deepEqual(launchOptions({ channel: "chrome", name: "Chrome", executable: MAC_CHROME }, mac), { headless: true, channel: "chrome" });
  const home = "/Users/ana/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.deepEqual(launchOptions({ channel: "chrome", name: "Chrome", executable: home }, mac), { headless: true, channel: "chrome", executablePath: home });
});

const chrome = resolveBrowser({ browser: "chrome" });
test.skipIf(!chrome)("ADR 0034: the installed Chrome launches headless and says its version (skipped without Chrome)", async () => {
  if (!chrome) return;
  const b = await playwright().chromium.launch(launchOptions(chrome));
  try {
    assert.match(b.version(), /^\d+\.\d+/);
  } finally {
    await b.close();
  }
});

test("ADR 0034: a browser that doesn't start is said with up to five lines, and the next in order is used", async () => {
  const all = probe({ files: [MAC_CHROME, MAC_EDGE], chromium: "/c/chrome" });
  const tried: string[] = [];
  const launch = async (b: BrowserChoice) => {
    tried.push(b.name);
    if (b.name === "Chrome") throw new Error("browserType.launch: Failed to launch\n\n  a\nb\nc\nd\ne\nf");
    return { name: b.name };
  };
  const got = await launchBrowser({}, { probe: all, launch });
  assert.ok(!("refusal" in got));
  assert.deepEqual([tried, got.choice.name, got.browser], [["Chrome", "Edge"], "Edge", { name: "Edge" }]);
  assert.deepEqual(got.failed, [
    { choice: { channel: "chrome", name: "Chrome", executable: MAC_CHROME }, why: ["browserType.launch: Failed to launch", "a", "b", "c", "d"] },
  ]);
  // All fail: each one's lines, and how to pin one; with a pin, only that one is tried.
  const none = await launchBrowser({}, { probe: all, launch: async () => Promise.reject(new Error("no")) });
  assert.ok("refusal" in none);
  assert.equal(
    none.refusal,
    [
      "no browser QA found would start: pin one with browser: in kitchen.yaml",
      `  Chrome (${MAC_CHROME}) didn't start:`,
      "    no",
      `  Edge (${MAC_EDGE}) didn't start:`,
      "    no",
      "  Chromium (/c/chrome) didn't start:",
      "    no",
    ].join("\n"),
  );
  tried.length = 0;
  const pinned = await launchBrowser({ browser: "chrome" }, { probe: all, launch });
  assert.deepEqual(tried, ["Chrome"]);
  assert.match(String("refusal" in pinned && pinned.refusal), /^no browser QA found would start: browser: chrome is pinned in kitchen.yaml/);
  assert.deepEqual(await launchBrowser({}, { probe: probe({}), launch }), { refusal: browserNeed().refusal });
});

test("ADR 0034: only the headless shell on disk: its own binary, the path doctor shows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-shell-"));
  assert.equal(headlessShell(dir), null);
  const bin = path.join(dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
  fs.mkdirSync(path.dirname(bin));
  fs.writeFileSync(bin, "");
  assert.equal(headlessShell(dir), bin);
  fs.rmSync(dir, { recursive: true, force: true });
});

const chromium = resolveBrowser({ browser: "chromium" });
test.skipIf(!chromium)("ADR 0034: Playwright's Chromium on disk launches by its path (skipped without it)", async () => {
  if (!chromium) return;
  const b = await playwright().chromium.launch(launchOptions(chromium));
  try {
    assert.match(b.version(), /^\d+\.\d+/);
  } finally {
    await b.close();
  }
});
