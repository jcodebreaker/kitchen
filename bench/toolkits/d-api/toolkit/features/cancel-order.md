# Cancel an order

A client cancels a `pending` order: its PaymentIntent is canceled at Stripe and the order becomes `canceled`. Orders in any other state answer 409.

## Sub-features

- `pending`: cancel works, Stripe is told.
- `twice`: a second cancel answers 409.
- `paid`: a paid order can't be canceled (409).

## How to get to it (user POV)

- `POST /orders/:id/cancel` with `X-Api-Key`.

## Driving it with bin/dev

Seed state: no orders.

```drive
drive: cancel-order.pending
args: [user]
steps:
  - http: { method: POST, path: /orders, as: $user, expect_status: 201, body: '{"email":"cancel@example.test","items":[{"sku":"TOTE-1","qty":1}]}' }
  - read: { target: id }
    save: id
  - read: { target: payment_intent }
    save: pi
  - cancel: { order_id: $id, as: $user, expect_status: 200 }
  - read: { target: body.status, equals: canceled }
  - payments: { path: "/cancel", contains: $pi }
  - db_order: { order_id: $id, status: canceled }
  - order: { order_id: $id, as: $user, expect_status: 200 }
  - read: { target: body.status, equals: canceled }
  - cancel: { order_id: $id, as: $user, expect_status: 409 }
```

## Kitchen

```kitchen
paths: [server.js, lib/stripe.js]
check: { drive: cancel-order.pending, args: { user: dev-key-1 } }
```

## Gotchas

- The Stripe mock records the cancel path as `/v1/payment_intents/<pi>/cancel`; `payments` with `contains: $pi` proves that exact intent was canceled.
- If Stripe is failing (`stripe_fail`), cancel answers 502 and the order stays `pending`.
