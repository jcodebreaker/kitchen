# Stripe webhook

Stripe tells the service a payment finished: `payment_intent.succeeded` marks the order `paid` and emails a receipt; `payment_intent.payment_failed` marks it `failed`. The `Stripe-Signature` HMAC is the only authentication; a bad signature gets 400.

## Sub-features

- `paid`: succeeded event, order paid, receipt mailed.
- `failed`: payment_failed event, order failed.
- `bad-signature`: wrong secret answers 400 and changes nothing.
- `ignored`: other event types answer 200 and are ignored.

## How to get to it (user POV)

- `POST /webhooks/stripe` (Stripe calls it; the `webhook` primitive plays Stripe, signed like the real service).

## Driving it with bin/dev

Seed state: no orders. Each drive creates its own order first to get a PaymentIntent id.

```drive
drive: stripe-webhook.paid
args: [user]
steps:
  - http: { method: POST, path: /orders, as: $user, expect_status: 201, body: '{"email":"paid@example.test","items":[{"sku":"MUG-01","qty":1}]}' }
  - read: { target: id }
    save: id
  - read: { target: payment_intent }
    save: pi
  - webhook: { type: payment_intent.succeeded, payment_intent: $pi }
  - read: { target: body.received, equals: "true" }
  - db_order: { order_id: $id, status: paid }
  - order: { order_id: $id, as: $user, expect_status: 200 }
  - read: { target: body.status, equals: paid }
  - mail: { to: paid@example.test, subject: Receipt }
```

```drive
drive: stripe-webhook.bad-signature
args: []
steps:
  - http: { method: POST, path: /orders, as: dev-key-1, expect_status: 201, body: '{"email":"badsig@example.test","items":[{"sku":"STK-10","qty":1}]}' }
  - read: { target: id }
    save: id
  - read: { target: payment_intent }
    save: pi
  - webhook: { type: payment_intent.succeeded, payment_intent: $pi, bad_signature: "true", expect_status: 400 }
  - db_order: { order_id: $id, status: pending }
  - mail: { to: badsig@example.test, subject: Receipt, count: 0 }
```

## Kitchen

```kitchen
paths: [server.js, lib/signature.js, lib/mail.js]
check: { drive: stripe-webhook.paid, args: { user: dev-key-1 } }
check: { drive: stripe-webhook.bad-signature }
```

## Gotchas

- The `webhook` primitive signs with `STRIPE_WEBHOOK_SECRET` from `.env.kitchen`, timestamp = now (tolerance is 300 s).
- An event for an unknown PaymentIntent still answers 200 (nothing changes).
