import assert from "node:assert/strict";
import { test } from "node:test";
import { priceOrder, ValidationError } from "../lib/pricing.js";
import { header, TOLERANCE_SECONDS, verify } from "../lib/signature.js";

const SECRET = "whsec_test_fake";
const BODY = JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: "pi_123" } } });
const NOW = 1_700_000_000;

test("signature: a fresh, correct signature verifies", () => {
  assert.equal(verify(SECRET, BODY, header(SECRET, BODY, NOW), NOW), true);
});

test("signature: wrong secret, tampered body or missing header fail", () => {
  assert.equal(verify(SECRET, BODY, header("other", BODY, NOW), NOW), false);
  assert.equal(verify(SECRET, `${BODY} `, header(SECRET, BODY, NOW), NOW), false);
  assert.equal(verify(SECRET, BODY, undefined, NOW), false);
  assert.equal(verify(SECRET, BODY, "garbage", NOW), false);
});

test("signature: outside the 5 minute tolerance fails", () => {
  assert.equal(verify(SECRET, BODY, header(SECRET, BODY, NOW - TOLERANCE_SECONDS), NOW), true);
  assert.equal(verify(SECRET, BODY, header(SECRET, BODY, NOW - TOLERANCE_SECONDS - 1), NOW), false);
  assert.equal(verify(SECRET, BODY, header(SECRET, BODY, NOW + TOLERANCE_SECONDS + 1), NOW), false);
});

const catalog = new Map([
  ["MUG-01", 1400],
  ["STK-10", 600],
]);

test("pricing: sums qty * unit price in cents", () => {
  const { amount, items } = priceOrder(catalog, [
    { sku: "MUG-01", qty: 2 },
    { sku: "STK-10", qty: 1 },
  ]);
  assert.equal(amount, 3400);
  assert.deepEqual(items[0], { sku: "MUG-01", qty: 2, unit_cents: 1400 });
});

test("pricing: rejects empty orders, unknown skus and bad quantities", () => {
  assert.throws(() => priceOrder(catalog, []), ValidationError);
  assert.throws(() => priceOrder(catalog, [{ sku: "NOPE", qty: 1 }]), /unknown sku/);
  assert.throws(() => priceOrder(catalog, [{ sku: "MUG-01", qty: 0 }]), /qty/);
  assert.throws(() => priceOrder(catalog, [{ sku: "MUG-01", qty: 1.5 }]), /qty/);
});
