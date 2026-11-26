// request-id (touches the response helper every route shares): every response carries a fresh X-Request-Id.
// bench/run.ts runs every oracle on the same final staging, so the other tickets' oracles show this one broke nothing.
import { call, done, expect } from "./_lib.mjs";

const rs = [
  await call("GET", "/healthz", null),
  await call("GET", "/healthz", null),
  await call("GET", "/books", "ana"),
  await call("GET", "/nope", "ana"),
  await call("GET", "/books", null),
];
const ids = rs.map((r) => r.headers.get("x-request-id"));
console.log(`ids: ${JSON.stringify(ids)}`);
expect(
  ids.every((x) => x && x.length >= 8),
  "a response has no X-Request-Id (or a very short one)",
);
expect(new Set(ids).size === ids.length, "two responses share an X-Request-Id");
expect(rs[3].status === 404 && rs[4].status === 401, `the error routes answered ${rs[3].status} and ${rs[4].status}, want 404 and 401`);
done();
