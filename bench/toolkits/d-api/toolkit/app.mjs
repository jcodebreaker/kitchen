// The project half of the fixture-d-api Toolkit. bin/dev (generic, contract v1) calls these.
// App: a Node orders API (node:http + node:sqlite). Externals: Stripe (mock.mjs) and SMTP (mock.mjs).
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installNodeDeps, killGroup, sameOrigin, stateRoot } from "./lib/common.mjs";

const NAME = "fixture-d-api";
const cacheDir = () => path.join(stateRoot(NAME), "_cache");
const snapshot = () => path.join(cacheDir(), "seed.db");
const dataDir = (ctx) => path.join(ctx.stateDir, "data");
const dbFile = (ctx) => path.join(dataDir(ctx), "orders.db");
const [P_APP, P_STRIPE, P_SMTP] = [0, 1, 2];
const mockUrl = (ctx) => `http://127.0.0.1:${ctx.ports[P_STRIPE]}`;
const keys = (ctx) => (ctx.env.API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);

function buildSnapshot(ctx) {
  const schema = path.join(ctx.src, "db", "schema.sql");
  const stamp = `${fs.statSync(schema).mtimeMs}:${fs.statSync(schema).size}`;
  const stampFile = path.join(cacheDir(), "seed.stamp");
  if (fs.existsSync(snapshot()) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp) return "cached";
  ctx.must("node", [path.join(ctx.toolkitDir, "seed.mjs"), schema, snapshot()]);
  fs.writeFileSync(stampFile, stamp);
  return "built";
}

function restoreData(ctx) {
  fs.mkdirSync(dataDir(ctx), { recursive: true });
  for (const f of ["orders.db", "orders.db-wal", "orders.db-shm", "orders.db-journal"]) fs.rmSync(path.join(dataDir(ctx), f), { force: true });
  fs.copyFileSync(snapshot(), dbFile(ctx));
}

function startApp(ctx) {
  ctx.spawn("app", "node", ["server.js"], {
    cwd: ctx.src,
    env: {
      ...ctx.env,
      PORT: String(ctx.ports[P_APP]),
      DATABASE_PATH: dbFile(ctx),
      STRIPE_API_BASE: mockUrl(ctx),
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(ctx.ports[P_SMTP]),
    },
  });
}

const appUrl = (ctx) => `http://127.0.0.1:${ctx.ports[P_APP]}`;

async function ready(ctx) {
  await ctx.waitFor(
    async () => {
      const r = await ctx.httpJson(`${appUrl(ctx)}/healthz`, undefined, 3000);
      return r.status === 200 && r.body?.db === true;
    },
    { timeoutMs: 20000, what: "/healthz to report db: true" },
  );
  const n = readDb(ctx, "SELECT COUNT(*) AS n FROM catalog")[0].n;
  if (n !== 4) throw new Error(`catalog has ${n} rows, expected 4 (seed missing)`);
}

function readDb(ctx, sql, ...params) {
  const db = new DatabaseSync(dbFile(ctx), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const mockState = async (ctx) => (await ctx.httpJson(`${mockUrl(ctx)}/__kitchen/state`)).body;
const J = (v) => JSON.stringify(v);

async function callApp(ctx, { method = "GET", path: p = "/", body, as, headers = {} }) {
  const url = sameOrigin(appUrl(ctx), p);
  const h = { ...headers };
  if (as) {
    if (!keys(ctx).includes(as)) throw new Error(`unknown seed user ${J(as)} (have ${keys(ctx).join(", ")})`);
    h["x-api-key"] = as;
  }
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  const r = await fetch(url, { method, headers: h, body: body === undefined ? undefined : body, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const res = { status: r.status, body: parsed };
  return res;
}

const getPath = (obj, p) => p.split(".").reduce((o, k) => (o !== undefined && o !== null ? o[k] : undefined), obj);

export default {
  name: NAME,
  surface: "api",
  ports: { needs: 3, order: ["app", "stripe", "smtp"] },
  parallel: true,
  externals: [
    { name: "stripe", mode: "mock" },
    { name: "smtp", mode: "mock" },
  ],

  async seedUsers(ctx) {
    return (ctx.env.API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  },

  async prepare(ctx) {
    const deps = installNodeDeps(ctx.src);
    const seed = buildSnapshot(ctx);
    return { deps, seed_snapshot: seed };
  },

  async up(ctx) {
    fs.mkdirSync(ctx.stateDir, { recursive: true });
    fs.mkdirSync(cacheDir(), { recursive: true });
    buildSnapshot(ctx);
    restoreData(ctx);
    ctx.spawn("mock", "node", [path.join(ctx.toolkitDir, "mock.mjs"), String(ctx.ports[P_STRIPE]), String(ctx.ports[P_SMTP])], { cwd: ctx.toolkitDir });
    await ctx.waitFor(async () => (await mockState(ctx))?.calls !== undefined, { timeoutMs: 10000, what: "the stripe/smtp mock" });
    startApp(ctx);
    await ready(ctx);
    return { url: appUrl(ctx) };
  },

  doctor(ctx) {
    return {
      "app healthz reports db": async () => {
        const r = await ctx.httpJson(`${appUrl(ctx)}/healthz`, undefined, 3000);
        return (r.status === 200 && r.body?.db === true) || `status ${r.status}`;
      },
      "catalog seeded (4 skus)": () => readDb(ctx, "SELECT COUNT(*) AS n FROM catalog")[0].n === 4 || "catalog is not the seed",
      "stripe mock answers": async () => (await mockState(ctx))?.failing === false || "mock missing or set to fail",
      "api key accepted": async () => (await callApp(ctx, { path: "/orders?email=doctor@example.test", as: keys(ctx)[0] })).status === 200 || "seed api key rejected",
    };
  },

  async reset(ctx) {
    await killGroup(ctx.state.pids?.app);
    restoreData(ctx);
    await ctx.httpJson(`${mockUrl(ctx)}/__kitchen/reset`, {});
    ctx.state.last = undefined;
    startApp(ctx);
    await ready(ctx);
  },

  async down(_ctx) {},

  primitives: {
    http: {
      args: { method: "GET|POST (default GET)", path: "path on the app, e.g. /orders", body: "raw JSON string, optional", as: "seed user (API key name) sent as X-Api-Key; omit to send none", expect_status: "optional: ok is false unless the status matches" },
      does: "Sends one request to the app (same origin only) and remembers the response for `read`. ok when a response came back (and the status matches expect_status if given).",
      async run(ctx, a) {
        const res = await callApp(ctx, { method: a.method, path: a.path, body: a.body, as: a.as });
        ctx.state.last = res;
        const ok = a.expect_status === undefined || String(res.status) === String(a.expect_status);
        return { ok, out: J(res) };
      },
    },
    order: {
      args: { order_id: "order id (e.g. saved from a create response)", as: "seed user (API key name)", expect_status: "optional" },
      does: "GET /orders/<id> with the API key; remembers the response for `read`.",
      async run(ctx, a) {
        const res = await callApp(ctx, { path: `/orders/${encodeURIComponent(a.order_id)}`, as: a.as });
        ctx.state.last = res;
        return { ok: a.expect_status === undefined || String(res.status) === String(a.expect_status), out: J(res) };
      },
    },
    cancel: {
      args: { order_id: "order id", as: "seed user (API key name)", expect_status: "optional" },
      does: "POST /orders/<id>/cancel with the API key; remembers the response for `read`.",
      async run(ctx, a) {
        const res = await callApp(ctx, { method: "POST", path: `/orders/${encodeURIComponent(a.order_id)}/cancel`, as: a.as });
        ctx.state.last = res;
        return { ok: a.expect_status === undefined || String(res.status) === String(a.expect_status), out: J(res) };
      },
    },
    read: {
      args: { target: "status (the HTTP code) | body | body.<dotted path> or just <dotted path> into the JSON body (body.status is the order's status, body.items.0.sku)", equals: "optional: ok is false unless the value equals this" },
      does: "Reads from the last http/webhook response. Missing field is ok:false.",
      async run(ctx, a) {
        const last = ctx.state.last;
        if (!last) return { ok: false, out: "no response yet" };
        const t = String(a.target ?? "body");
        const v = t === "status" ? last.status : t === "body" ? last.body : getPath(last.body, t.replace(/^body\./, ""));
        if (v === undefined) return { ok: false, out: `no ${t} in the last response` };
        const s = typeof v === "string" ? v : J(v);
        return { ok: a.equals === undefined || s === String(a.equals), out: s };
      },
    },
    webhook: {
      args: { type: "payment_intent.succeeded | payment_intent.payment_failed | any event type", payment_intent: "PaymentIntent id, e.g. pi_kitchen_1", bad_signature: "true to sign with the wrong secret", expect_status: "default 200" },
      does: "POSTs a Stripe-style event to /webhooks/stripe, signed with STRIPE_WEBHOOK_SECRET exactly like Stripe (t=,v1=hmac). Remembers the response for `read`.",
      async run(ctx, a) {
        const body = J({ id: "evt_kitchen", type: a.type, data: { object: { id: a.payment_intent } } });
        const t = Math.floor(Date.now() / 1000);
        const secret = a.bad_signature === "true" ? "whsec_wrong" : ctx.env.STRIPE_WEBHOOK_SECRET;
        const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
        const res = await callApp(ctx, { method: "POST", path: "/webhooks/stripe", body, headers: { "stripe-signature": `t=${t},v1=${v1}` } });
        ctx.state.last = res;
        return { ok: String(res.status) === String(a.expect_status ?? 200), out: J(res) };
      },
    },
    mail: {
      args: { to: "recipient filter, optional", subject: "subject substring, optional", contains: "body substring, optional", count: "exact number of matches expected (0 allowed); default at least 1" },
      does: "Lists the mails the SMTP catcher received, filtered. ok when the match count fits.",
      async run(ctx, a) {
        const m = (await mockState(ctx)).mails.filter((x) => (!a.to || x.to.includes(a.to)) && (!a.subject || x.subject.includes(a.subject)) && (!a.contains || x.body.includes(a.contains)));
        const ok = a.count === undefined ? m.length >= 1 : m.length === Number(a.count);
        return { ok, out: J(m) };
      },
    },
    payments: {
      args: { path: "request path substring, e.g. /v1/payment_intents or /cancel, optional", contains: "substring of the JSON of the call (form fields), optional", count: "exact number of matches expected; default at least 1" },
      does: "Lists the calls the Stripe mock received (path, auth header, idempotency key, form fields).",
      async run(ctx, a) {
        const c = (await mockState(ctx)).calls.filter((x) => (!a.path || x.path.includes(a.path)) && (!a.contains || J(x).includes(a.contains)));
        const ok = a.count === undefined ? c.length >= 1 : c.length === Number(a.count);
        return { ok, out: J(c) };
      },
    },
    stripe_fail: {
      args: { on: "true makes the Stripe mock answer 500, false restores it" },
      does: "Switches the Stripe mock into/out of failure mode (reset clears it).",
      async run(ctx, a) {
        const r = await ctx.httpJson(`${mockUrl(ctx)}/__kitchen/fail`, { fail: a.on === "true" });
        return { ok: r.status === 200, out: J(r.body) };
      },
    },
    db_order: {
      args: { order_id: "order id", status: "optional: ok is false unless the stored status equals this" },
      does: "Reads the stored order row straight from SQLite (the second view of what the API shows).",
      async run(ctx, a) {
        const row = readDb(ctx, "SELECT id, email, items, amount_cents, status, payment_intent FROM orders WHERE id = ?", Number(a.order_id))[0];
        if (!row) return { ok: false, out: `no order ${a.order_id}` };
        return { ok: a.status === undefined || row.status === a.status, out: J(row) };
      },
    },
  },
};
