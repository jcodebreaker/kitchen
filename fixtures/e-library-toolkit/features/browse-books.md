# Browse books

A member lists the catalogue or opens one book and sees how many copies are on the shelf now (`available`).

## Sub-features

- `list`: `GET /books` with availability for every book
- `detail`: `GET /books/:id`, 404 for an unknown id

## How to get to it (user POV)

- `GET /books` and `GET /books/:id` with an `X-Member` header (any seed member).
- Without a known member the API answers 401.

## Driving it with bin/dev

Seed state: six books; book 5 ("The Left Hand of Darkness") has 2 copies and no open loan, and no other drive touches it.

```drive
drive: browse-books.catalogue
args: [user]
steps:
  - http: { method: GET, path: /books, as: $user, expect_status: 200, expect_body: "Middlemarch" }
  - http: { method: GET, path: /books/5, as: $user, expect_status: 200, expect_body: '"available":2' }
  - read: { target: body }
  - http: { method: GET, path: /books/999, as: $user, expect_status: 404 }
  - http: { method: GET, path: /books, expect_status: 401 }
  - stored: { table: books, where: id=5, expect: '"copies":2' }
```

## Kitchen

```kitchen
paths: [server.js, lib/loans.js, seed.json]
check: { drive: browse-books.catalogue, args: { user: ana } }
```

## Gotchas

- Every route but `/healthz` needs `X-Member`.
- Book 5 is the browse fixture: don't borrow it in other drives, or its `available` changes.
