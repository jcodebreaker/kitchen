// Browser session daemon for one id. `up` starts it; it owns one headless
// Chromium context so cookies and the open page survive between separate
// `bin/dev <primitive>` calls, until `reset` (fresh context) or `down` (exit).
//   node driver.mjs --port <p> --base <app url> --src <dir>
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { parseArgs, readEnvFile } from "./common.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const PORT = Number(flags.port);
const BASE = String(flags.base).replace(/\/$/, "");
const SRC = String(flags.src);
const ACTION_TIMEOUT = 5000;

const browser = await chromium.launch({ headless: true });
let context;
let page;
async function freshContext() {
  if (context) await context.close().catch(() => {});
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(ACTION_TIMEOUT);
  page = await context.newPage();
}
await freshContext();

const seedPassword = (user) => {
  const env = readEnvFile(path.join(SRC, ".env.kitchen"));
  return env[`SEED_${user.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASSWORD`];
};

async function settle() {
  // A press may start a navigation; let it land before the next step reads.
  await page.waitForLoadState("load").catch(() => {});
}

const ops = {
  async ping() {
    return { ok: true, out: { url: page.url() } };
  },
  async reset() {
    await freshContext();
    return { ok: true, out: "fresh browser context" };
  },
  async login({ as }) {
    const pw = as && seedPassword(as);
    if (!pw) return { ok: false, out: `no seed user ${JSON.stringify(as)}` };
    await context.clearCookies();
    await page.goto(`${BASE}/login`);
    await page.getByTestId("login-username").fill(as);
    await page.getByTestId("login-password").fill(pw);
    await page.getByTestId("login-submit").click();
    await settle();
    const who = await page
      .getByTestId("signed-in-as")
      .innerText({ timeout: 3000 })
      .catch(() => null);
    return who === `Signed in as ${as}` ? { ok: true, out: who } : { ok: false, out: `sign-in failed at ${page.url()}` };
  },
  async press({ target }) {
    await page.locator(target).first().click();
    await settle();
    return { ok: true, out: page.url() };
  },
  async type({ target, text }) {
    await page.locator(target).first().fill(String(text ?? ""));
    return { ok: true, out: String(text ?? "") };
  },
  async read({ target = "body", attr }) {
    const el = page.locator(target).first();
    if ((await el.count()) === 0) return { ok: false, out: `no element matches ${target}` };
    const v = attr ? await el.getAttribute(String(attr)) : await el.innerText();
    return { ok: true, out: v ?? "" };
  },
  async screenshot({ name = "screen", out }) {
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `${String(name).replace(/[^a-zA-Z0-9_.-]/g, "_")}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return { ok: true, out: page.url(), files: [file] };
  },
  async http({ method = "GET", path: p = "/", body }) {
    // Uses the browser context's cookies, so it acts as the signed-in user.
    const r = await context.request.fetch(`${BASE}${p}`, {
      method: String(method).toUpperCase(),
      data: body === undefined ? undefined : typeof body === "string" ? JSON.parse(body) : body,
    });
    const text = await r.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { ok: r.status() < 400, out: { status: r.status(), body: parsed } };
  },
};

// One op at a time: a drive is sequential and the page is shared.
let chain = Promise.resolve();
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    chain = chain.then(async () => {
      let result;
      try {
        const { op, args = {} } = JSON.parse(data || "{}");
        if (!ops[op]) result = { ok: false, out: `unknown op ${op}` };
        else result = await ops[op](args);
      } catch (e) {
        result = { ok: false, out: String(e.message || e).split("\n")[0] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: [], ...result }));
    });
  });
});
server.listen(PORT, "127.0.0.1", () => console.error(`driver listening on ${PORT}, app ${BASE}`));

async function shutdown() {
  server.close();
  await browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
