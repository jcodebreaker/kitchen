// Pure order pricing. `catalog` is a Map of sku -> price in cents.

export class ValidationError extends Error {}

/** Validate the request items and price them; returns { items, amount }. */
export function priceOrder(catalog, items) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError("items must be a non-empty array");
  const lines = items.map((it) => {
    if (typeof it?.sku !== "string" || !catalog.has(it.sku)) throw new ValidationError(`unknown sku: ${it?.sku}`);
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 100) throw new ValidationError(`qty for ${it.sku} must be an integer from 1 to 100`);
    return { sku: it.sku, qty: it.qty, unit_cents: catalog.get(it.sku) };
  });
  return { items: lines, amount: lines.reduce((sum, l) => sum + l.qty * l.unit_cents, 0) };
}

export const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
