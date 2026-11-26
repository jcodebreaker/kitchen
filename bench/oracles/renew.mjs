// renew: +14 days from the current due date, once; a second renewal and a returned loan are both 409.
import { call, done, expect } from "./_lib.mjs";

const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const lent = await call("POST", "/loans", "ben", { book_id: 2 });
if (expect(lent.status === 201 && lent.body?.due_at, `could not borrow book 2 as ben (${lent.status})`)) {
  const want = addDays(lent.body.due_at, 14);
  const first = await call("POST", `/loans/${lent.body.id}/renew`, "ben");
  expect(first.status === 200 || first.status === 201, `the first renewal answered ${first.status}`);
  expect(first.body?.due_at === want, `after renewing due_at is ${first.body?.due_at}, want ${want}`);
  const second = await call("POST", `/loans/${lent.body.id}/renew`, "ben");
  expect(second.status === 409, `a second renewal answered ${second.status}, want 409`);
  const mine = await call("GET", "/loans", "ben");
  const stored = Array.isArray(mine.body) ? mine.body.find((l) => l.id === lent.body.id) : null;
  expect(stored?.due_at === want, `GET /loans shows due_at ${stored?.due_at}, want ${want}`);
}
const k = await call("POST", "/loans", "ana", { book_id: 4 });
if (expect(k.status === 201, `could not borrow book 4 as ana (${k.status})`)) {
  await call("POST", `/loans/${k.body.id}/return`, "ana");
  const r = await call("POST", `/loans/${k.body.id}/renew`, "ana");
  expect(r.status === 409, `renewing a returned loan answered ${r.status}, want 409`);
}
done();
