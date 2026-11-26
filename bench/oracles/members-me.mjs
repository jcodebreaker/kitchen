// members-me: GET /members/me is the caller's { id, name, role }; no member is a 401.
import { call, done, expect } from "./_lib.mjs";

const ben = await call("GET", "/members/me", "ben");
expect(ben.status === 200, `as ben answered ${ben.status}`);
expect(ben.body?.id === "ben" && ben.body?.name === "Ben Okafor" && ben.body?.role === "member", `as ben gave ${JSON.stringify(ben.body)}`);
const lena = await call("GET", "/members/me", "lena");
expect(lena.body?.role === "librarian", `as lena the role is ${lena.body?.role}`);
const nobody = await call("GET", "/members/me", null);
expect(nobody.status === 401, `without X-Member answered ${nobody.status}, want 401`);
done();
