-- Seed data. Passwords are fake and arrive from .env.kitchen as psql variables.
INSERT INTO users (username, password_hash, is_admin) VALUES
  ('alice', crypt(:'alice_pw', gen_salt('bf', 6)), false),
  ('bob-admin', crypt(:'bob_pw', gen_salt('bf', 6)), true);

INSERT INTO projects (owner_id, name, description, slug, ready_at)
  SELECT id, 'Onboarding', 'Seeded example project', 'onboarding', now() FROM users WHERE username = 'alice';
