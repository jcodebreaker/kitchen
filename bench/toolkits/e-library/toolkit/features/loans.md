# Loans

A member borrows a copy of a book for 14 days and returns it; the copy goes back on the shelf. A member can have 3 books out at once and one copy of the same book.

## Sub-features

- `borrow`: `POST /loans` takes a copy off the shelf (`due_at` 14 days on).
- `return`: `POST /loans/:id/return` puts it back; a second return is 409.
- `refusals`: no free copy, the same book twice, someone else's loan.
- `mine`: `GET /loans` lists the member's own loans.

## How to get to it (user POV)

- `POST /loans` with `{ "book_id": n }`, `POST /loans/:id/return`, `GET /loans`, each with `X-Member`.

## Driving it with bin/dev

Seed state: Kindred (id 4) has one copy and nobody has it; Dune (id 3) is out with ben since 2025-01-02. Loans 2 and 3 are ana's, already returned.

```drive
drive: loans.borrow-return
args: [user, other]
steps:
  - http: { method: POST, path: /loans, as: $user, expect_status: 201, body: '{"book_id":4}' }
  - read: { target: id }
    save: id
  - read: { target: returned_at, equals: "null" }
  - stored: { collection: loans, record: $id, field: member, equals: $user }
  - http: { method: GET, path: /books/4, as: $user, expect_status: 200 }
  - read: { target: available, equals: "0" }
  - http: { method: POST, path: /loans, as: $other, expect_status: 409, body: '{"book_id":4}' }
  - http: { method: POST, path: /loans/$id/return, as: $user, expect_status: 200 }
  - stored: { collection: loans, record: $id, field: returned_at }
  - http: { method: GET, path: /books/4, as: $user, expect_status: 200 }
  - read: { target: available, equals: "1" }
  - http: { method: POST, path: /loans/$id/return, as: $user, expect_status: 409 }
```

```drive
drive: loans.refusals
args: [user, other]
steps:
  - http: { method: POST, path: /loans, as: $user, expect_status: 201, body: '{"book_id":5}' }
  - read: { target: id }
    save: id
  - http: { method: POST, path: /loans, as: $user, expect_status: 409, body: '{"book_id":5}' }
  - http: { method: POST, path: /loans/$id/return, as: $other, expect_status: 404 }
  - stored: { collection: loans, record: $id, field: returned_at, equals: "null" }
  - http: { method: POST, path: /loans, as: $user, expect_status: 404, body: '{"book_id":99999}' }
  - http: { method: GET, path: /loans, as: $user, expect_status: 200 }
  - stored: { collection: loans, record: $id, field: book_id, equals: "5" }
```

## Kitchen

```kitchen
paths: [server.js, lib/loans.js, lib/store.js]
check: { drive: loans.borrow-return, args: { user: ana, other: ben } }
check: { drive: loans.refusals, args: { user: ana, other: ben } }
```

## Gotchas

- Dates are UTC `YYYY-MM-DD` from the server's clock; a drive can't pin `due_at`, only read it.
- `read { target: returned_at }` on a fresh loan is the text `null` (the field is there, empty).
- `stored` reads `library.json` straight from the instance's data dir: the second view of a change.
- ben starts with Dune out (loan 1), so he has 2 slots left under the 3-book limit, not 3.
