# Books

A member lists the catalog and looks at one book, with how many copies are on the shelf right now (`available`); a librarian adds books.

## Sub-features

- `list`: `GET /books`, every book with `available`.
- `get`: `GET /books/:id` (404 when unknown).
- `add`: `POST /books` by a librarian (403 for a member, 400 on bad input).
- `auth`: no or unknown `X-Member` answers 401.

## How to get to it (user POV)

- `GET /books`, `GET /books/:id`, `POST /books` with an `X-Member` header naming a member.

## Driving it with bin/dev

Seed state (`seed.json`): 6 books. The Hobbit (id 1, 2 copies), The Fellowship of the Ring (2, 1 copy), Dune (3, 1 copy, out with ben), Kindred (4, 1 copy), The Left Hand of Darkness (5, 2 copies), Middlemarch (6, 1 copy). Members `ana`, `ben` and the librarian `lena`.

```drive
drive: books.list
args: [user]
steps:
  - http: { method: GET, path: /books, as: $user, expect_status: 200 }
  - read: { target: 0.title, equals: The Hobbit }
  - read: { target: 0.available, equals: "2" }
  - read: { target: 2.title, equals: Dune }
  - read: { target: 2.available, equals: "0" }
  - http: { method: GET, path: /books/6, as: $user, expect_status: 200 }
  - read: { target: body.available, equals: "1" }
  - http: { method: GET, path: /books/99999, as: $user, expect_status: 404 }
  - http: { method: GET, path: /books, expect_status: 401 }
```

```drive
drive: books.add
args: [librarian, member]
steps:
  - http: { method: POST, path: /books, as: $librarian, expect_status: 201, body: '{"title":"Piranesi","author":"Susanna Clarke","copies":2}' }
  - read: { target: id }
    save: id
  - read: { target: available, equals: "2" }
  - stored: { collection: books, record: $id, field: title, equals: Piranesi }
  - http: { method: GET, path: /books/$id, as: $member, expect_status: 200 }
  - read: { target: body.author, equals: Susanna Clarke }
  - http: { method: POST, path: /books, as: $member, expect_status: 403, body: '{"title":"Nope","author":"Nobody","copies":1}' }
  - http: { method: POST, path: /books, as: $librarian, expect_status: 400, body: '{"title":"Nope","author":"Nobody","copies":0}' }
```

## Kitchen

```kitchen
paths: [server.js, lib/loans.js, lib/store.js, seed.json]
check: { drive: books.list, args: { user: ana } }
check: { drive: books.add, args: { librarian: lena, member: ben } }
```

## Gotchas

- `read { target: status }` is the HTTP code; a JSON field is `target: <path>` (or `body.<path>`); a list's items are `0.title`, `1.available`.
- `available` is copies minus loans not yet returned; the seed's returned loans (ids 2 and 3) must not count.
- Book ids restart after `reset`; a new book is id 7 on a fresh instance, but save it from the response, never hard-code it.
