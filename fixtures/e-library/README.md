# fixture-e-library

A small lending library API. Members list books, borrow a copy for 14 days and return it; a librarian adds books. Each book has a number of copies; a member can have at most 3 books out at once and only one copy of the same book.

Plain `node:http`, no dependencies. The data lives in one JSON file, `<DATA_DIR>/library.json`, created from `seed.json` on the first start (delete the file to start over). Needs **Node 20.11+**.

## Run

```sh
DATA_DIR=./data npm start
```

## Configuration

| Variable   | Default  | Meaning                                  |
| ---------- | -------- | ---------------------------------------- |
| `PORT`     | `4100`   | HTTP port                                |
| `DATA_DIR` | `./data` | Folder holding `library.json`            |

## API

Every route but `/healthz` needs an `X-Member` header naming a member (`ana`, `ben`, or the librarian `lena` in the seed); 401 otherwise. Errors are `{ "error": "..." }`. Dates are `YYYY-MM-DD` (UTC).

| Route                      | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `GET /healthz`             | `{ ok, store, books }`                                                      |
| `GET /books`               | All books, each with `available` (copies on the shelf now)                  |
| `GET /books/:id`           | One book (404 when unknown)                                                 |
| `POST /books`              | Librarians only (403): `{ title, author, copies }` -> 201 the book          |
| `GET /loans`               | The member's loans, returned ones included                                  |
| `POST /loans`              | `{ book_id }` -> 201 the loan (`borrowed_at`, `due_at`, `returned_at: null`); 409 when no copy is free, the member already has it, or has 3 out |
| `POST /loans/:id/return`   | Returns a loan (the member's own; a librarian may return any) -> 200; 409 when already returned |

```sh
curl -s localhost:4100/healthz
curl -s localhost:4100/books -H 'X-Member: ana'
curl -s -X POST localhost:4100/loans -H 'X-Member: ana' -H 'content-type: application/json' -d '{"book_id":4}'
curl -s -X POST localhost:4100/loans/4/return -H 'X-Member: ana'
```

## Tests

```sh
npm test
```

The tests (`node --test`) cover the lending rules in `lib/loans.js` and need no server.
