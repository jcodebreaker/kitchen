-- Dev seed data. Runs once, when the postgres container initialises an empty data
-- directory (files in /docker-entrypoint-initdb.d run in name order). Dev-only passwords.
INSERT INTO users (username, password_hash, is_admin) VALUES
  ('alice', crypt('alice-dev-pw', gen_salt('bf', 6)), false),
  ('bob-admin', crypt('bob-dev-pw', gen_salt('bf', 6)), true);

INSERT INTO projects (owner_id, name, description, slug, ready_at)
  SELECT id, 'Onboarding', 'Seeded example project', 'onboarding', now() FROM users WHERE username = 'alice';
