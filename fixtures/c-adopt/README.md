# fixture-c-adopt

A small web app (plain Node, no framework) with Postgres, local username/password sign-in and a few pages. Development runs in Docker Compose.

## Development

```sh
docker compose up --build
```

Then open http://localhost:3000 and sign in as one of the seeded dev users:

| User        | Password       | Role  |
| ----------- | -------------- | ----- |
| `alice`     | `alice-dev-pw` | user  |
| `bob-admin` | `bob-dev-pw`   | admin |

The schema (`db/001_schema.sql`) and seed data (`db/002_seed.sql`) are mounted into the postgres image's `/docker-entrypoint-initdb.d`, so they run once, the first time the database volume is created. To reset the database to a clean seeded state:

```sh
docker compose down -v      # -v drops the pgdata volume
docker compose up --build
```

Host ports can be overridden with `APP_PORT` (default 3000) and `DB_PORT` (default 5432), e.g. `APP_PORT=3100 docker compose up`. See `.env.example`.
The database is reachable from the host with `psql postgres://app:app-dev-pw@localhost:5432/app`.

## Configuration

| Variable       | Default     | Meaning                                                  |
| -------------- | ----------- | -------------------------------------------------------- |
| `PORT`         | `3000`      | Port the server listens on                               |
| `HOST`         | `127.0.0.1` | Interface to bind (compose sets `0.0.0.0` in the container) |
| `DATABASE_URL` | none        | Postgres connection string                               |

All values in `docker-compose.yml` are fake, dev-only credentials.

## Features

- **Sign in / sign out** with username and password (passwords are bcrypt-hashed in Postgres by pgcrypto); `GET /healthz` reports `{ok, db}`.
- **Settings**: a dark-mode switch at `/settings`; the choice is saved per user and applied to every page.
- **Two-step project form**: `/projects/new` collects a name and description, step 2 asks for a unique slug (3-30 lowercase letters, digits or dashes). A new project shows "Provisioning..." for about 1.5 seconds before it flips to "Ready".
- **Projects list** at `/projects` and a detail page at `/projects/<slug>`.
- **Admin invites**: admins (`bob-admin`) open `/admin` and generate single-use invite codes; anyone can redeem a code at `/join`.

## Without Docker

You need Node 20+ and a Postgres with `db/001_schema.sql` and `db/002_seed.sql` applied:

```sh
npm ci
DATABASE_URL=postgres://app:app-dev-pw@localhost:5432/app npm start
```
