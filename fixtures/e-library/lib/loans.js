// Lending rules. Pure: dates are "YYYY-MM-DD" strings (UTC), nothing here reads the clock or the store.

export const LOAN_DAYS = 14;
export const MAX_LOANS = 3;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Today's date in UTC, as "YYYY-MM-DD". */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

/** `date` plus `days` days, as "YYYY-MM-DD". */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Copies of `book` on the shelf right now. */
export function availableCopies(book, loans) {
  const out = loans.filter((l) => l.book_id === book.id && !l.returned_at).length;
  return Math.max(0, book.copies - out);
}

/** Throws an HttpError when `member` may not borrow `book` now. */
export function checkBorrow(book, member, loans) {
  const mine = loans.filter((l) => l.member === member.id && !l.returned_at);
  if (mine.some((l) => l.book_id === book.id)) throw new HttpError(409, `you already have "${book.title}"`);
  if (mine.length >= MAX_LOANS) throw new HttpError(409, `you can have at most ${MAX_LOANS} books at once`);
  if (availableCopies(book, loans) === 0) throw new HttpError(409, `no copy of "${book.title}" is available`);
}

/** A new loan record for `member` borrowing `book` on `on`. */
export const newLoan = (id, book, member, on) => ({
  id,
  book_id: book.id,
  member: member.id,
  borrowed_at: on,
  due_at: addDays(on, LOAN_DAYS),
  returned_at: null,
});
