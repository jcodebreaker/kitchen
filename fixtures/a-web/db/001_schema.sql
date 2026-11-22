CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id serial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark'))
);

CREATE TABLE sessions (
  token text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id serial PRIMARY KEY,
  owner_id int NOT NULL REFERENCES users(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  slug text UNIQUE NOT NULL,
  ready_at timestamptz NOT NULL DEFAULT now() + interval '1.5 seconds',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  code text PRIMARY KEY,
  created_by int NOT NULL REFERENCES users(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
