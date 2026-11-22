// Optional module for web surfaces: start the browser session daemon for an
// instance, and the generic web primitives (open, reload, press, type, read,
// screenshot, http, login) that talk to it. Use from app.mjs:
//
//   import { browserPrimitives, startBrowser, resetBrowser } from "./lib/browser.mjs";
//   up:        await startBrowser(ctx, { port: ctx.ports[2], base: url, login: { path: "/login", user: "#user", password: "#pw", submit: "button[type=submit]", expect: { target: "header", text: "{user}" } } });
//   reset:     await resetBrowser(ctx);
//   primitives: { ...browserPrimitives({ passwordOf: (ctx, user) => ctx.env[`SEED_${user.toUpperCase()}_PASSWORD`] }), …your own }
//
// prepare must install it: add "playwright" to package.json and run
// `node_modules/.bin/playwright install --only-shell chromium` (cached per version).
import path from "node:path";
import { TOOLKIT_DIR } from "./common.mjs";

export async function startBrowser(ctx, { port, base, login, width }) {
  const args = [path.join(TOOLKIT_DIR, "lib", "browser-daemon.mjs"), "--port", String(port), "--base", base];
  if (login) args.push("--login", JSON.stringify(login));
  if (width) args.push("--width", String(width));
  ctx.spawn("browser", process.execPath, args, { cwd: TOOLKIT_DIR });
  ctx.state.browserUrl = `http://127.0.0.1:${port}`;
  ctx.save();
  await ctx.waitFor(async () => (await ctx.httpJson(ctx.state.browserUrl, { op: "ping" }, 2000)).body?.ok === true, {
    timeoutMs: 30000,
    what: "browser daemon",
  });
}

export async function callBrowser(ctx, op, args = {}) {
  if (!ctx.state.browserUrl) return { ok: false, out: "no browser session for this id" };
  const r = await ctx.httpJson(ctx.state.browserUrl, { op, args });
  return r.body ?? { ok: false, out: `browser daemon answered ${r.status}` };
}

export async function resetBrowser(ctx) {
  const r = await callBrowser(ctx, "reset");
  if (!r.ok) throw new Error(`browser reset failed: ${r.out}`);
}

/** Doctor check for app.mjs: `"browser session": () => browserAlive(ctx)`. */
export async function browserAlive(ctx) {
  return (await callBrowser(ctx, "ping")).ok === true || "browser daemon not answering";
}

/** The generic web primitives (PLAN §2), forwarded to the daemon. `passwordOf(ctx, user)` reads .env.kitchen. */
export function browserPrimitives({ passwordOf }) {
  const fwd = (op, args, does) => ({ args, does, run: (ctx, a) => callBrowser(ctx, op, a) });
  return {
    login: {
      args: { as: "seed user" },
      does: "sign in through the real sign-in form",
      run: (ctx, a) => callBrowser(ctx, "login", { as: a.as, password: passwordOf(ctx, String(a.as ?? "")) }),
    },
    open: fwd("open", { path: "/path on the app" }, "navigate to a path on the app (same origin only)"),
    reload: fwd("reload", {}, "reload the current page from the server"),
    press: fwd("press", { target: "selector" }, "click the first match and let any navigation land"),
    type: fwd("type", { target: "selector", text: "string" }, "replace the field's value"),
    read: fwd("read", { target: "selector (default body)", attr: "optional attribute" }, "inner text or attribute of the first match; missing is ok:false"),
    screenshot: {
      args: { name: "file stem", width: "optional viewport width" },
      does: "full-page PNG into --out",
      run: (ctx, a) => callBrowser(ctx, "screenshot", { ...a, out: ctx.out }),
    },
    http: {
      args: { method: "GET|POST…", path: "/api/…", body: "optional JSON" },
      does: "same-origin request with the browser's cookies",
      run: (ctx, a) => callBrowser(ctx, "http", { ...a, body: typeof a.body === "string" ? JSON.parse(a.body) : a.body }),
    },
  };
}
