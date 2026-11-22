# fixture-d-api

A small orders API. A client posts an order (email plus SKUs and quantities); the service prices it from a catalog table, creates a Stripe PaymentIntent, stores the order as `pending` and emails an "Order received" message. When Stripe later calls the webhook the order becomes `paid` (and a receipt is emailed) or `failed`.

Plain `node:http`, storage in SQLite through the built-in `node:sqlite`. The only dependency is `nodemailer`. Needs **Node 22.5+**.

## Run

```sh
npm ci
# export the variables below (see .env.example for fake values), then:
npm start
```

The server does not read `.env` files; it uses the process environment. The database file and its folder are created on start and `db/schema.sql` is applied (it is idempotent and seeds the catalog).

## Configuration

| Variable                | Default                   | Meaning                                                        |
| ----------------------- | ------------------------- | -------------------------------------------------------------- |
| `PORT`                  | `4000`                    | HTTP port                                                      |
| `DATABASE_PATH`         | `./data/orders.db`        | SQLite file                                                    |
| `API_KEYS`              | empty (all calls get 401) | Comma-separated keys accepted in the `X-Api-Key` header        |
| `STRIPE_API_BASE`       | `https://api.stripe.com`  | Base URL for Stripe calls                                      |
| `STRIPE_SECRET_KEY`     | empty                     | Sent as `Authorization: Bearer ...`                            |
| `STRIPE_WEBHOOK_SECRET` | empty                     | Secret used to verify `Stripe-Signature` on `/webhooks/stripe` |
| `SMTP_HOST`             | `127.0.0.1`               | SMTP server (plain, no TLS, no auth)                           |
| `SMTP_PORT`             | `25`                      | SMTP port                                                      |
| `MAIL_FROM`             | `orders@example.test`     | From address of outgoing mail                                  |

## API

All `/orders` routes need an `X-Api-Key` header (401 otherwise). Validation errors return 400 with `{ "error": "..." }`.

| Route                      | Description                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `GET /healthz`             | `{ ok, db }`                                                             |
| `POST /orders`             | `{ email, items: [{ sku, qty }] }` -> 201 `{ id, status, amount, payment_intent, client_secret }` |
| `GET /orders/:id`          | One order                                                                |
| `GET /orders?email=`       | Orders for an email                                                      |
| `POST /orders/:id/cancel`  | Cancels a `pending` order (and its PaymentIntent); 409 otherwise         |
| `POST /webhooks/stripe`    | Stripe events; `payment_intent.succeeded` and `payment_intent.payment_failed` are handled, others get 200 and are ignored; a bad signature gets 400 |

Catalog (amounts are in cents): `MUG-01` 1400, `TEE-01` 2500, `STK-10` 600, `TOTE-1` 1800.

```sh
curl -s localhost:4000/healthz

curl -s -X POST localhost:4000/orders \
  -H 'X-Api-Key: dev-key-1' -H 'content-type: application/json' \
  -d '{"email":"buyer@example.test","items":[{"sku":"MUG-01","qty":2},{"sku":"STK-10","qty":1}]}'

curl -s localhost:4000/orders/1 -H 'X-Api-Key: dev-key-1'
curl -s 'localhost:4000/orders?email=buyer@example.test' -H 'X-Api-Key: dev-key-1'
curl -s -X POST localhost:4000/orders/1/cancel -H 'X-Api-Key: dev-key-1'
```

Sending a webhook by hand (signing as Stripe does, with `STRIPE_WEBHOOK_SECRET`):

```sh
BODY='{"type":"payment_intent.succeeded","data":{"object":{"id":"pi_123"}}}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$STRIPE_WEBHOOK_SECRET" | awk '{print $NF}')
curl -s -X POST localhost:4000/webhooks/stripe -H "Stripe-Signature: t=$T,v1=$SIG" -d "$BODY"
```

## Development setup

The service calls two external systems. In development we point `STRIPE_API_BASE` at a local mock (we used [stripe-mock](https://github.com/stripe/stripe-mock) in the past) and `SMTP_HOST`/`SMTP_PORT` at a mail catcher such as [Mailpit](https://mailpit.axllent.org/). This repository does not ship either of them.

## Tests

```sh
npm test
```

The tests (`node --test`) cover signature verification and price calculation and need no network or services.
