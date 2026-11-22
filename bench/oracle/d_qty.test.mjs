// Hidden oracle (bench): 100 of one item is accepted, 101 refused.
import assert from "node:assert/strict";
import test from "node:test";
import { priceOrder } from "./lib/pricing.js";

const catalog = new Map([["MUG-01", 1400]]);
test("qty 100 is accepted", () => {
  assert.equal(priceOrder(catalog, [{ sku: "MUG-01", qty: 100 }]).amount, 140000);
});
test("qty 101 is refused", () => {
  assert.throws(() => priceOrder(catalog, [{ sku: "MUG-01", qty: 101 }]));
});
