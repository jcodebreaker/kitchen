// Fixture D: a small orders API. Prices orders from a catalog, creates Stripe PaymentIntents,
// emails receipts over SMTP and reacts to Stripe webhooks. Plain node:http + node:sqlite.
// Config from env only:
//   PORT, DATABASE_PATH, API_KEYS, STRIPE_API_BASE, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   SMTP_HOST, SMTP_PORT, MAIL_FROM
import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mailer } from "./lib/mail.js";
import { isEmail, priceOrder, ValidationError } from "./lib/pricing.js";
import { verify } from "./lib/signature.js";
import { stripeClient } from "./lib/stripe.js";

const env = process.env;
const PORT = Number(env.PORT || 4000);
const DATABASE_PATH = env.DATABASE_PATH || "./data/orders.db";
const API_KEYS = (env.API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET || "";

const stripe = stripeClient({ apiBase: env.STRIPE_API_BASE || "https://api.stripe.com", secretKey: env.STRIPE_SECRET_KEY || "" });
const mail = mailer({ host: env.SMTP_HOST || "127.0.0.1", port: Number(env.SMTP_PORT || 25), from: env.MAIL_FROM || "orders@example.test" });

// ---------- storage ----------

mkdirSync(dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(readFileSync(new URL("./db/schema.sql", import.meta.url), "utf8"));

const toOrder = (r) => r && { ...r, items: JSON.parse(r.items) };
const getOrder = (id) => toOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
const present = (o) => ({
  id: o.id,
  email: o.email,
  status: o.status,
  amount: o.amount_cents,
  items: o.items,
  payment_intent: o.payment_intent,
  client_secret: o.client_secret,
});

// ---------- helpers ----------

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ValidationError("body must be valid JSON");
  }
}

// Mail is best-effort: a down SMTP server must not fail an order.
const safeMail = (promise) => promise.catch((e) => console.error("mail:", e.message));

// ---------- routes ----------

async function createOrder(req, res) {
  const body = parseJson(await readRaw(req));
  if (!isEmail(body.email)) throw new ValidationError("email is required and must look like an email");
  const catalog = new Map(
    db
      .prepare("SELECT sku, price_cents FROM catalog")
      .all()
      .map((r) => [r.sku, r.price_cents]),
  );
  const { items, amount } = priceOrder(catalog, body.items);

  const { lastInsertRowid } = db.prepare("INSERT INTO orders (email, items, amount_cents) VALUES (?, ?, ?)").run(body.email, JSON.stringify(items), amount);
  const id = Number(lastInsertRowid);
  try {
    const intent = await stripe.createPaymentIntent({ orderId: id, amount, email: body.email });
    db.prepare("UPDATE orders SET payment_intent = ?, client_secret = ? WHERE id = ?").run(intent.id, intent.client_secret, id);
  } catch (e) {
    console.error(e.message);
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(id);
    return json(res, 502, { error: "payment provider unavailable", id });
  }
  const order = getOrder(id);
  await safeMail(mail.orderReceived(order));
  json(res, 201, { id, status: order.status, amount, payment_intent: order.payment_intent, client_secret: order.client_secret });
}

async function cancelOrder(res, id) {
  const order = getOrder(id);
  if (!order) return json(res, 404, { error: "order not found" });
  if (order.status !== "pending") return json(res, 409, { error: `cannot cancel an order that is ${order.status}` });
  try {
    if (order.payment_intent) await stripe.cancelPaymentIntent(order.payment_intent);
  } catch (e) {
    console.error(e.message);
    return json(res, 502, { error: "payment provider unavailable" });
  }
  db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ?").run(id);
  json(res, 200, present(getOrder(id)));
}

async function stripeWebhook(req, res) {
  const raw = await readRaw(req);
  if (!verify(WEBHOOK_SECRET, raw, req.headers["stripe-signature"])) return json(res, 400, { error: "invalid signature" });
  const event = parseJson(raw);
  const intent = event.data?.object;
  const order = intent && db.prepare("SELECT * FROM orders WHERE payment_intent = ?").get(intent.id);
  if (order && event.type === "payment_intent.succeeded") {
    db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(order.id);
    await safeMail(mail.paymentReceived(toOrder(order)));
  } else if (order && event.type === "payment_intent.payment_failed") {
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
  }
  json(res, 200, { received: true });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const method = req.method;

  if (path === "/healthz" && method === "GET") {
    try {
      db.prepare("SELECT 1").get();
      return json(res, 200, { ok: true, db: true });
    } catch {
      return json(res, 503, { ok: false, db: false });
    }
  }

  // Stripe cannot send our API key; the signature is its authentication.
  if (path === "/webhooks/stripe" && method === "POST") return stripeWebhook(req, res);

  if (path === "/orders" || path.startsWith("/orders/")) {
    if (!API_KEYS.includes(req.headers["x-api-key"] ?? "")) return json(res, 401, { error: "missing or invalid X-Api-Key" });

    if (path === "/orders" && method === "POST") return createOrder(req, res);
    if (path === "/orders" && method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) throw new ValidationError("email query parameter is required");
      return json(
        res,
        200,
        db
          .prepare("SELECT * FROM orders WHERE email = ? ORDER BY id")
          .all(email)
          .map((r) => present(toOrder(r))),
      );
    }
    const m = path.match(/^\/orders\/(\d+)(\/cancel)?$/);
    if (m && method === "GET" && !m[2]) {
      const order = getOrder(Number(m[1]));
      return order ? json(res, 200, present(order)) : json(res, 404, { error: "order not found" });
    }
    if (m?.[2] && method === "POST") return cancelOrder(res, Number(m[1]));
  }

  json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof ValidationError) return json(res, 400, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  });
});
server.listen(PORT, () => console.error(`fixture-d-api listening on http://127.0.0.1:${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
