// Email via plain SMTP (no TLS, no auth): meant for an internal relay or a dev mail catcher.
import nodemailer from "nodemailer";

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

export function mailer({ host, port, from }) {
  const transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true, connectionTimeout: 5000, greetingTimeout: 5000 });
  const send = (to, subject, text) => transport.sendMail({ from, to, subject, text });

  return {
    orderReceived: (o) =>
      send(
        o.email,
        `Order #${o.id} received`,
        `Thanks for your order #${o.id}.\n\n${o.items.map((i) => `${i.qty} x ${i.sku}`).join("\n")}\n\nTotal: ${dollars(o.amount_cents)}\nWe will email you again when the payment goes through.\n`,
      ),
    paymentReceived: (o) =>
      send(o.email, `Receipt for order #${o.id}`, `We received your payment of ${dollars(o.amount_cents)} for order #${o.id}. Thank you!\n`),
  };
}
