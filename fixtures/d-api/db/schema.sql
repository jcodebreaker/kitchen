-- Applied on every start; every statement is idempotent.
CREATE TABLE IF NOT EXISTS catalog (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  items TEXT NOT NULL,             -- JSON: [{sku, qty, unit_cents}]
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'canceled')),
  payment_intent TEXT,
  client_secret TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);

INSERT OR IGNORE INTO catalog (sku, name, price_cents) VALUES
  ('MUG-01', 'Enamel mug', 1400),
  ('TEE-01', 'Logo t-shirt', 2500),
  ('STK-10', 'Sticker pack', 600),
  ('TOTE-1', 'Canvas tote bag', 1800);
