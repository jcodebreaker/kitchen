// search: GET /books?q= matches title or author, any case; no q lists everything.
import { call, done, expect } from "./_lib.mjs";

const titles = (r) => (Array.isArray(r.body) ? r.body.map((b) => b.title).sort() : []);
const author = await call("GET", "/books?q=TOLKIEN", "ana");
expect(author.status === 200, `?q=TOLKIEN answered ${author.status}`);
expect(JSON.stringify(titles(author)) === JSON.stringify(["The Fellowship of the Ring", "The Hobbit"]), `?q=TOLKIEN gave ${JSON.stringify(titles(author))}`);
const title = await call("GET", "/books?q=dUnE", "ben");
expect(JSON.stringify(titles(title)) === JSON.stringify(["Dune"]), `?q=dUnE gave ${JSON.stringify(titles(title))}`);
const all = await call("GET", "/books", "ben");
expect(titles(all).length === 6, `no q gave ${titles(all).length} books, want 6`);
const none = await call("GET", "/books?q=zzzz", "ben");
expect(none.status === 200 && titles(none).length === 0, `?q=zzzz gave ${none.status} with ${titles(none).length} books, want 200 and none`);
done();
