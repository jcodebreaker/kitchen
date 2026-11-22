import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, availableCopies, checkBorrow, HttpError, LOAN_DAYS, MAX_LOANS, newLoan, today } from "../lib/loans.js";

const hobbit = { id: 1, title: "The Hobbit", author: "J.R.R. Tolkien", copies: 2 };
const dune = { id: 3, title: "Dune", author: "Frank Herbert", copies: 1 };
const ana = { id: "ana", name: "Ana Lima", role: "member" };
const ben = { id: "ben", name: "Ben Okafor", role: "member" };

test("dates: addDays crosses months and years; today is UTC", () => {
  assert.equal(addDays("2025-01-25", 14), "2025-02-08");
  assert.equal(addDays("2025-12-25", 14), "2026-01-08");
  assert.equal(today(new Date("2025-03-01T23:30:00Z")), "2025-03-01");
});

test("newLoan: due LOAN_DAYS after borrowing, not returned", () => {
  const l = newLoan(7, hobbit, ana, "2025-03-01");
  assert.deepEqual(l, { id: 7, book_id: 1, member: "ana", borrowed_at: "2025-03-01", due_at: addDays("2025-03-01", LOAN_DAYS), returned_at: null });
});

test("availableCopies: copies minus loans still out", () => {
  assert.equal(availableCopies(hobbit, []), 2);
  assert.equal(availableCopies(hobbit, [newLoan(1, hobbit, ana, "2025-03-01")]), 1);
});

test("checkBorrow: no copy left, the same book twice, more than MAX_LOANS", () => {
  const out = [newLoan(1, dune, ben, "2025-03-01")];
  assert.throws(
    () => checkBorrow(dune, ana, out),
    (e) => e instanceof HttpError && e.status === 409,
  );
  assert.throws(() => checkBorrow(hobbit, ana, [newLoan(1, hobbit, ana, "2025-03-01")]), /already have/);
  const many = Array.from({ length: MAX_LOANS }, (_, i) => newLoan(i + 1, { ...hobbit, id: 100 + i }, ana, "2025-03-01"));
  assert.throws(() => checkBorrow(hobbit, ana, many), /at most/);
  assert.doesNotThrow(() => checkBorrow(hobbit, ben, many));
});
