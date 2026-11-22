# Read and list orders

A client fetches one order by id, lists the orders of an email, and checks service health; every `/orders` route needs a valid `X-Api-Key`.

## Sub-features

- `get`: `GET /orders/:id` (404 when unknown).
- `list`: `GET /orders?email=` (400 without email).
- `auth`: no or wrong key answers 401.
- `health`: `GET /healthz` reports `{ ok, db }`.

## How to get to it (user POV)

- `GET /healthz`, `GET /orders/:id`, `GET /orders?email=` with `X-Api-Key`.

## Driving it with bin/dev

Seed state: no orders. The drives create their own order for a unique email.

```drive
drive: read-orders.list
args: [user]
steps:
  - http: { method: POST, path: /orders, as: $user, expect_status: 201, body: '{"email":"list@example.test","items":[{"sku":"TEE-01","qty":1}]}' }
  - read: { target: id }
    save: id
  - http: { method: GET, path: "/orders?email=list@example.test", as: $user, expect_status: 200 }
  - read: { target: "body.0.amount", equals: "2500" }
  - read: { target: "body.0.status", equals: pending }
  - order: { order_id: $id, as: $user, expect_status: 200 }
  - read: { target: body.email, equals: list@example.test }
  - order: { order_id: "99999", as: $user, expect_status: 404 }
  - db_order: { order_id: $id, status: pending }
```

```drive
drive: read-orders.auth
args: []
steps:
  - http: { method: GET, path: /healthz, expect_status: 200 }
  - read: { target: body.db, equals: "true" }
  - http: { method: GET, path: "/orders?email=anyone@example.test", expect_status: 401 }
  - http: { method: GET, path: "/orders?email=anyone@example.test", as: dev-key-2, expect_status: 200 }
```

## Kitchen

```kitchen
paths: [server.js, db/schema.sql]
check: { drive: read-orders.list, args: { user: dev-key-1 } }
check: { drive: read-orders.auth }
```

## Gotchas

- `as` must be a seed user (an API key name from `.env.kitchen`); omitting it sends no key, which is how 401 is tested.
- Order ids restart at 1 after `reset`; never hard-code one except an id that cannot exist (99999).
