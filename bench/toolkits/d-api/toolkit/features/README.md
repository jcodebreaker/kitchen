# Feature map: fixture-d-api

This folder is the maintained source for proving the user-facing behaviour of
fixture-d-api (a small orders API: Stripe PaymentIntents, Stripe webhooks, email
receipts). One file per feature; Kitchen (`kitchen toolkit check`, the verifier)
reads them.

| Feature | Drive | Args |
|---|---|---|
| [Create an order](create-order.md) | `create-order.place` | `user` (seed API key) |
| [Create an order](create-order.md) | `create-order.rejects` | `user` |
| [Read and list orders](read-orders.md) | `read-orders.list` | `user` |
| [Read and list orders](read-orders.md) | `read-orders.auth` | none |
| [Cancel an order](cancel-order.md) | `cancel-order.pending` | `user` |
| [Stripe webhook](stripe-webhook.md) | `stripe-webhook.paid` | `user` |
| [Stripe webhook](stripe-webhook.md) | `stripe-webhook.bad-signature` | none |

## Feature file contract

Each `features/<feature>.md` starts with an H1 title and one paragraph that
says what the user can do. Then these sections, in order:

1. `## Sub-features`: short ids, one line each.
2. `## How to get to it (user POV)`: every entry point a user has.
3. `## Driving it with bin/dev`: preconditions (seed state), then one fenced
   `drive` block per journey, in Kitchen's drive format:

   ````
   ```drive
   drive: <feature>.<journey>
   args: [user]
   steps:
     - order: { order_id: $id, as: $user }
       save: x
   ```
   ````

   One step per line, a flow mapping naming a primitive from `describe`. Only
   `wait`, `retry: { times: n, on: fail }`, `save:` and `$var` are built in. No
   loops, no branches, no code: anything that needs code is a primitive.
   `id`, `src`, `out` and `ports` are set by the engine and can't be passed.
   In this API Toolkit, a primitive returns `ok: false` when an expectation
   argument (`expect_status`, `equals`, `status`, `count`) isn't met: that is how
   a drive asserts.
4. `## Kitchen`: one fenced `kitchen` block:

   ````
   ```kitchen
   paths: [src/settings/**, "db/migrations/**"]
   check: { drive: <feature>.<journey>, args: { user: alice } }
   ```
   ````

   `paths`: the source paths the feature lives in (a change there makes
   `kitchen run` re-prove the Toolkit). `check`: one line per drive that
   `kitchen toolkit check` runs, with concrete args (seed users, fresh values).
   Every drive the check runs must pass twice: once on a fresh instance, once
   after `reset`.
5. `## Gotchas`: traps that waste or invalidate a run.

Never weaken a journey to make it pass: if seed data lacks a precondition, the
drive fails and the reason goes in Gotchas.
