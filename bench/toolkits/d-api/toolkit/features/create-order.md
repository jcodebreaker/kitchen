# Create an order

A client posts an email and SKUs with quantities; the service prices the order from the catalog, creates a Stripe PaymentIntent, stores the order as `pending` and emails "Order received".

## Sub-features

- `place`: priced order, PaymentIntent, stored row, mail.
- `validation`: bad email, unknown SKU, bad body answer 400.
- `provider-down`: Stripe failing answers 502 and stores the order as `failed`.

## How to get to it (user POV)

- `POST /orders` with `X-Api-Key` and a JSON body `{ email, items: [{ sku, qty }] }`.

## Driving it with bin/dev

Seed state: catalog MUG-01 1400, TEE-01 2500, STK-10 600, TOTE-1 1800; no orders. Seed users are the API key names (`dev-key-1`, `dev-key-2`).

```drive
drive: create-order.place
args: [user]
steps:
  - http: { method: POST, path: /orders, as: $user, expect_status: 201, body: '{"email":"place@example.test","items":[{"sku":"MUG-01","qty":2},{"sku":"STK-10","qty":1}]}' }
  - read: { target: amount, equals: "3400" }
  - read: { target: status, equals: "201" }
  - read: { target: id }
    save: id
  - read: { target: payment_intent }
    save: pi
  - db_order: { order_id: $id, status: pending }
  - order: { order_id: $id, as: $user, expect_status: 200 }
  - read: { target: payment_intent, equals: $pi }
  - payments: { path: /v1/payment_intents, contains: place@example.test }
  - mail: { to: place@example.test, subject: received, contains: "34.00" }
```

```drive
drive: create-order.rejects
args: [user]
steps:
  - http: { method: POST, path: /orders, as: $user, expect_status: 400, body: '{"email":"nope","items":[{"sku":"MUG-01","qty":1}]}' }
  - http: { method: POST, path: /orders, as: $user, expect_status: 400, body: '{"email":"rejects@example.test","items":[{"sku":"NOPE-99","qty":1}]}' }
  - http: { method: GET, path: "/orders?email=rejects@example.test", as: $user, expect_status: 200 }
  - read: { target: body, equals: "[]" }
  - mail: { to: rejects@example.test, count: 0 }
```

## Kitchen

```kitchen
paths: [server.js, lib/pricing.js, lib/stripe.js, lib/mail.js, db/schema.sql]
check: { drive: create-order.place, args: { user: dev-key-1 } }
check: { drive: create-order.rejects, args: { user: dev-key-1 } }
```

## Gotchas

- `read { target: status }` is the HTTP code; an order's own `status` field is `target: body.status`. Other fields: `id`, `amount`, `payment_intent`, `items.0.sku` (with or without `body.`).
- Values in drives must not contain `$` (it starts a variable): write `34.00`, not `$34.00`.
- `stripe_fail { on: true }` makes the mock answer 500 until `reset`; run it only in a drive that ends with `stripe_fail { on: false }`.
- The mail catcher is shared by the whole instance: filter by a unique email per drive.
