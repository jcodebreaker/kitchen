// Local stand-ins for the two externals of fixture-d-api, in one process:
//   - a Stripe mock (PaymentIntents create/cancel) on STRIPE_PORT, which also serves /__kitchen/* inspection
//   - a plain SMTP catcher on SMTP_PORT that keeps every message it receives
// Usage: node mock.mjs <stripePort> <smtpPort>
import http from "node:http";
import net from "node:net";

const [stripePort, smtpPort] = process.argv.slice(2).map(Number);
let calls = [];
let mails = [];
let failing = false;
let seq = 0;
const intents = new Map();

const send = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const raw = await readBody(req);
    if (path === "/__kitchen/state") return send(res, 200, { calls, mails, failing });
    if (path === "/__kitchen/fail") {
      failing = raw ? JSON.parse(raw).fail === true : true;
      return send(res, 200, { failing });
    }
    if (path === "/__kitchen/reset") {
      calls = [];
      mails = [];
      failing = false;
      intents.clear();
      seq = 0;
      return send(res, 200, { ok: true });
    }
    const form = Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method: req.method, path, auth: req.headers.authorization ?? null, idempotency_key: req.headers["idempotency-key"] ?? null, form });
    if (failing) return send(res, 500, { error: { message: "mock stripe failure" } });
    if (req.method === "POST" && path === "/v1/payment_intents") {
      const id = `pi_kitchen_${++seq}`;
      const pi = { id, object: "payment_intent", amount: Number(form.amount), currency: form.currency, status: "requires_payment_method", client_secret: `${id}_secret_kitchen` };
      intents.set(id, pi);
      return send(res, 200, pi);
    }
    const m = path.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
    if (req.method === "POST" && m) {
      const pi = intents.get(m[1]);
      if (!pi) return send(res, 404, { error: { message: "No such payment_intent" } });
      pi.status = "canceled";
      return send(res, 200, pi);
    }
    send(res, 404, { error: { message: "not mocked" } });
  })
  .listen(stripePort, "127.0.0.1");

net
  .createServer((sock) => {
    let buf = "";
    let data = null;
    let from = "";
    let to = [];
    sock.setEncoding("utf8");
    sock.write("220 kitchen-smtp ready\r\n");
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf += chunk;
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const msg = buf.slice(0, end);
          buf = buf.slice(end + 5);
          data = null;
          const [head, ...rest] = msg.split("\r\n\r\n");
          const subject = /^subject:\s*(.*)$/im.exec(head)?.[1] ?? "";
          mails.push({ from, to, subject, body: rest.join("\r\n\r\n").replace(/\r\n/g, "\n") });
          sock.write("250 queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const v = line.toUpperCase();
        if (v.startsWith("EHLO") || v.startsWith("HELO")) sock.write("250 kitchen-smtp\r\n");
        else if (v.startsWith("MAIL FROM")) {
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          to = [];
          sock.write("250 ok\r\n");
        } else if (v.startsWith("RCPT TO")) {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          sock.write("250 ok\r\n");
        } else if (v === "DATA") {
          data = "";
          sock.write("354 go ahead\r\n");
        } else if (v === "QUIT") {
          sock.write("221 bye\r\n");
          sock.end();
        } else sock.write("250 ok\r\n");
      }
    });
  })
  .listen(smtpPort, "127.0.0.1");
