// Optional module: a browser session daemon for one instance (web surfaces).
// `up` starts it through lib/browser.mjs; it owns one headless Chromium context,
// so cookies and the open page survive between separate `bin/dev <primitive>`
// calls, until `reset` (fresh context) or `down` (exit).
//   node browser-daemon.mjs --port <p> --base <app url> --login '<json recipe>'
// Needs `playwright` in the Toolkit's package.json and its browser installed by
// `prepare` (`npx playwright install --only-shell chromium`).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { parseArgs, sameOrigin } from "./common.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const PORT = Number(flags.port);
const BASE = String(flags.base);
/** {path, user, password, submit, expect?: {target, text}} — selectors of the app's real sign-in form; text may hold {user}. */
const LOGIN = flags.login ? JSON.parse(String(flags.login)) : null;
const ACTION_TIMEOUT = Number(flags["action-timeout"] || 5000);

const browser = await chromium.launch({ headless: true });
let context;
let page;
async function freshContext() {
  if (context) await context.close().catch(() => {});
  context = await browser.newContext({ viewport: { width: Number(flags.width || 1280), height: Number(flags.height || 800) } });
  context.setDefaultTimeout(ACTION_TIMEOUT);
  page = await context.newPage();
}
await freshContext();

const appUrl = (p) => sameOrigin(BASE, p);
// A press may start a navigation; let it land before the next step reads.
const settle = () => page.waitForLoadState("load").catch(() => {});

const ops = {
  async ping() {
    return { ok: true, out: { url: page.url() } };
  },
  async reset() {
    await freshContext();
    return { ok: true, out: "fresh browser context" };
  },
  /** Sign in through the real form. bin/dev looks the password up (seed users, .env.kitchen) and passes it. */
  async login({ as, password }) {
    if (!LOGIN) return { ok: false, out: "this Toolkit has no login recipe" };
    if (!password) return { ok: false, out: `no seed user ${JSON.stringify(as)}` };
    await context.clearCookies();
    await page.goto(appUrl(LOGIN.path));
    await page.locator(LOGIN.user).first().fill(String(as));
    await page.locator(LOGIN.password).first().fill(String(password));
    await page.locator(LOGIN.submit).first().click();
    await settle();
    if (!LOGIN.expect) return { ok: true, out: page.url() };
    const want = String(LOGIN.expect.text ?? "").replaceAll("{user}", String(as));
    const got = await page
      .locator(LOGIN.expect.target)
      .first()
      .innerText({ timeout: 3000 })
      .catch(() => null);
    return got?.includes(want) ? { ok: true, out: got } : { ok: false, out: `sign-in failed at ${page.url()}` };
  },
  async press({ target }) {
    await page.locator(String(target)).first().click();
    await settle();
    return { ok: true, out: page.url() };
  },
  async type({ target, text }) {
    await page
      .locator(String(target))
      .first()
      .fill(String(text ?? ""));
    return { ok: true, out: String(text ?? "") };
  },
  /** Inner text or an attribute; a missing element or attribute is ok:false, never "". */
  async read({ target = "body", attr }) {
    const el = page.locator(String(target)).first();
    if ((await el.count()) === 0) return { ok: false, out: `no element matches ${target}` };
    if (!attr) return { ok: true, out: await el.innerText() };
    const v = await el.getAttribute(String(attr));
    return v === null ? { ok: false, out: `${target} has no attribute ${attr}` } : { ok: true, out: v };
  },
  async open({ path: p = "/" }) {
    await page.goto(appUrl(p));
    await settle();
    return { ok: true, out: page.url() };
  },
  async reload() {
    await page.reload();
    await settle();
    return { ok: true, out: page.url() };
  },
  async screenshot({ name = "screen", out, width }) {
    if (!out) return { ok: false, out: "screenshot needs --out" };
    if (width) await page.setViewportSize({ width: Number(width), height: 800 });
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `${String(name).replace(/[^a-zA-Z0-9_.-]/g, "_")}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return { ok: true, out: page.url(), files: [file] };
  },
  /** Same-origin request with the browser's cookies (acts as the signed-in user). */
  async http({ method = "GET", path: p = "/", body, expect_status }) {
    const r = await context.request.fetch(appUrl(p), {
      maxRedirects: 0,
      method: String(method).toUpperCase(),
      data: body === undefined ? undefined : typeof body === "string" ? JSON.parse(body) : body,
    });
    const text = await r.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    // ok: a 2xx/3xx, or exactly `expect_status` when given (so a proof can assert a 403 or 404).
    const ok = expect_status === undefined ? r.status() < 400 : String(r.status()) === String(expect_status);
    return { ok, out: { status: r.status(), body: parsed } };
  },
};

// One op at a time: a drive is sequential and the page is shared.
let chain = Promise.resolve();
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => {
    data += c;
  });
  req.on("end", () => {
    chain = chain.then(async () => {
      let result;
      try {
        const { op, args = {} } = JSON.parse(data || "{}");
        result = ops[op] ? await ops[op](args) : { ok: false, out: `unknown op ${op}` };
      } catch (e) {
        result = { ok: false, out: String(e.message || e).split("\n")[0] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: [], ...result }));
    });
  });
});
server.listen(PORT, "127.0.0.1", () => console.error(`browser daemon on ${PORT}, app ${BASE}`));

async function shutdown() {
  server.close();
  await browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
