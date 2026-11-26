// returned-stuck (a planted bug): a returned copy is on the shelf again.
import { call, done, expect } from "./_lib.mjs";

const mm = await call("GET", "/books/6", "ben");
expect(mm.body?.available === 1, `Middlemarch (returned in the seed) has available ${mm.body?.available}, want 1`);
const lent = await call("POST", "/loans", "ana", { book_id: 4 });
if (expect(lent.status === 201, `could not borrow book 4 as ana (${lent.status})`)) {
  const back = await call("POST", `/loans/${lent.body.id}/return`, "ana");
  expect(back.status === 200, `returning answered ${back.status}`);
  const again = await call("POST", "/loans", "ben", { book_id: 4 });
  expect(again.status === 201, `borrowing the returned copy answered ${again.status}, want 201`);
}
done();
