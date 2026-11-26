// zero-copies (a planted bug): copies 0 is a 400; 1 is still fine and 21 still refused.
import { call, done, expect } from "./_lib.mjs";

const zero = await call("POST", "/books", "lena", { title: "Zero", author: "Nobody", copies: 0 });
expect(zero.status === 400, `copies 0 answered ${zero.status}, want 400`);
const one = await call("POST", "/books", "lena", { title: "One", author: "Somebody", copies: 1 });
expect(one.status === 201, `copies 1 answered ${one.status}, want 201`);
const many = await call("POST", "/books", "lena", { title: "Many", author: "Somebody", copies: 21 });
expect(many.status === 400, `copies 21 answered ${many.status}, want 400`);
const all = await call("GET", "/books", "ana");
expect(Array.isArray(all.body) && !all.body.some((b) => b.title === "Zero"), "the 0-copy book was stored");
done();
