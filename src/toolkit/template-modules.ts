// The optional modules Kitchen ships in toolkit-template/lib/ (the browser module on
// Playwright, the terminal module), and the rules around them: a Toolkit that needs a
// browser uses Kitchen's own module, copied byte for byte by the engine, never one an
// agent wrote (a hand-rolled CDP driver times out where Playwright waits properly).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TEMPLATE_DIR = path.resolve(import.meta.dirname, "..", "..", "toolkit-template");
/** The Playwright version the browser module is tested with (its browser build is cached per version). */
export const PLAYWRIGHT = "1.65.0";
/** The browser module's files, under the Toolkit's lib/. */
export const BROWSER_FILES = ["lib/browser.mjs", "lib/browser-daemon.mjs"] as const;
/** What `browserPrimitives()` gives: a gap naming one of these is solved by the browser module. */
export const BROWSER_PRIMITIVES = ["open", "reload", "press", "type", "read", "screenshot", "login"] as const;

export const isBrowserGap = (gap: string): boolean => (BROWSER_PRIMITIVES as readonly string[]).includes(gap);

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** True when `toolkitDir` holds the browser module exactly as Kitchen ships it. */
export function hasTemplateBrowser(toolkitDir: string): boolean {
  return BROWSER_FILES.every((f) => fs.existsSync(path.join(toolkitDir, f)) && sha(path.join(toolkitDir, f)) === sha(path.join(TEMPLATE_DIR, f)));
}

/**
 * Restores Kitchen's browser module into a Toolkit (engine side, never retyped by an agent): both lib files
 * from the template, and `playwright@<PLAYWRIGHT>` in the Toolkit's package.json. Returns what it changed.
 */
export function restoreBrowserModule(toolkitDir: string): string[] {
  const changed: string[] = [];
  for (const f of BROWSER_FILES) {
    const dest = path.join(toolkitDir, f);
    if (fs.existsSync(dest) && sha(dest) === sha(path.join(TEMPLATE_DIR, f))) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE_DIR, f), dest);
    changed.push(f);
  }
  const pj = path.join(toolkitDir, "package.json");
  let pkg: { dependencies?: Record<string, string> } & Record<string, unknown> = { name: "kitchen-toolkit", private: true, type: "module" };
  try {
    pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
  } catch {}
  if (pkg.dependencies?.playwright !== PLAYWRIGHT) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}), playwright: PLAYWRIGHT };
    fs.writeFileSync(pj, `${JSON.stringify(pkg, null, 2)}\n`);
    changed.push("package.json");
  }
  return changed;
}

/** Signs of code that drives a browser itself: CDP by hand, a launched Chrome, another automation library. */
const DRIVER =
  /Runtime\.evaluate|Page\.navigate|webSocketDebuggerUrl|--remote-debugging-port|chrome-remote-interface|from\s+["']puppeteer|require\(["']puppeteer|chromium\.launch|from\s+["']playwright|require\(["']playwright|selenium-webdriver|webdriverio/;

/**
 * Hand-rolled browser drivers in a Toolkit: any file under lib/ (or app.mjs) that drives a browser and is not
 * Kitchen's own browser module byte for byte. Each entry says which file and what to do instead. Empty: fine.
 */
export function handRolledBrowser(toolkitDir: string): string[] {
  const out: string[] = [];
  const files = ["app.mjs"];
  const lib = path.join(toolkitDir, "lib");
  if (fs.existsSync(lib))
    for (const d of fs.readdirSync(lib, { recursive: true, withFileTypes: true }))
      if (d.isFile() && /\.(mjs|cjs|js|ts)$/.test(d.name)) files.push(path.relative(toolkitDir, path.join(d.parentPath, d.name)));
  for (const f of files) {
    const p = path.join(toolkitDir, f);
    if (!fs.existsSync(p)) continue;
    if ((BROWSER_FILES as readonly string[]).includes(f) && sha(p) === sha(path.join(TEMPLATE_DIR, f))) continue;
    if (DRIVER.test(fs.readFileSync(p, "utf8")))
      out.push(
        `${f} drives a browser itself: use Kitchen's browser module instead (lib/browser.mjs + lib/browser-daemon.mjs from the template, unchanged; app.mjs only imports browserPrimitives/startBrowser/resetBrowser from it)`,
      );
  }
  return out;
}
