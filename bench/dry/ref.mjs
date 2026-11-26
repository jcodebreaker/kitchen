// The hand-written reference change for each bench ticket that should be built: what the `--dry` stand-in commits as
// its Build. Each edit is anchored on the fixture's text and idempotent (applied twice, it changes nothing), so a
// catch-up can take staging's side of a conflicted file and apply the change again. With these on staging every
// oracle passes; on the fixture as filed every code oracle fails (bench/run.ts checks both in --dry).
import fs from "node:fs";
import path from "node:path";

/** Replace `from` with `to` in `file`, unless `to` is already there. Throws when neither is (the anchor moved). */
function replace(dir, file, from, to) {
  const f = path.join(dir, file);
  const text = fs.readFileSync(f, "utf8");
  if (text.includes(to)) return;
  if (!text.includes(from)) throw new Error(`${file}: anchor not found: ${from.slice(0, 60)}`);
  fs.writeFileSync(f, text.replace(from, to));
}
/** Insert `text` before `anchor` in `file`, unless it is already there. */
const before = (dir, file, anchor, text) => replace(dir, file, anchor, `${text}${anchor}`);
/** Insert `text` after `anchor` in `file`, unless it is already there. */
const after = (dir, file, anchor, text) => replace(dir, file, anchor, `${anchor}${text}`);

const NOT_FOUND = '  json(res, 404, { error: "not found" });\n}';

export const REFS = {
  search: (dir) =>
    replace(
      dir,
      "server.js",
      '  if (path === "/books" && method === "GET") return json(res, 200, db.books.map(presentBook));\n',
      '  if (path === "/books" && method === "GET") {\n    const q = (url.searchParams.get("q") ?? "").toLowerCase();\n    const hit = (b) => !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q);\n    return json(res, 200, db.books.filter(hit).map(presentBook));\n  }\n',
    ),
  "members-me": (dir) =>
    before(
      dir,
      "server.js",
      NOT_FOUND,
      '  if (path === "/members/me" && method === "GET") return json(res, 200, { id: member.id, name: member.name, role: member.role });\n\n',
    ),
  renew: (dir) => {
    before(
      dir,
      "server.js",
      "async function handle(req, res) {",
      'function renew(res, member, id) {\n  const loan = db.loans.find((l) => l.id === id && l.member === member.id);\n  if (!loan) throw new HttpError(404, "loan not found");\n  if (loan.returned_at) throw new HttpError(409, "this loan was already returned");\n  if (loan.renewed) throw new HttpError(409, "a loan can be renewed once");\n  loan.due_at = addDays(loan.due_at, 14);\n  loan.renewed = true;\n  store.save();\n  json(res, 200, presentLoan(loan));\n}\n\n',
    );
    replace(dir, "server.js", "import { availableCopies, checkBorrow,", "import { addDays, availableCopies, checkBorrow,");
    before(
      dir,
      "server.js",
      NOT_FOUND,
      '  const ren = path.match(/^\\/loans\\/(\\d+)\\/renew$/);\n  if (ren && method === "POST") return renew(res, member, Number(ren[1]));\n\n',
    );
  },
  "healthz-version": (dir) => {
    after(dir, "server.js", 'import { openStore } from "./lib/store.js";\n', 'import fs from "node:fs";\n');
    after(
      dir,
      "server.js",
      'const DATA_DIR = process.env.DATA_DIR || "./data";\n',
      'const VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;\n',
    );
    replace(dir, "server.js", "{ ok, store: ok, books: db.books.length }", "{ ok, store: ok, books: db.books.length, version: VERSION }");
  },
  "returned-stuck": (dir) =>
    replace(dir, "lib/loans.js", "loans.filter((l) => l.book_id === book.id).length", "loans.filter((l) => l.book_id === book.id && !l.returned_at).length"),
  "zero-copies": (dir) => replace(dir, "server.js", "body.copies < 0 ||", "body.copies < 1 ||"),
  "request-id": (dir) => {
    before(dir, "server.js", 'import http from "node:http";\n', 'import { randomUUID } from "node:crypto";\n');
    replace(dir, "server.js", '{ "content-type": "application/json" }', '{ "content-type": "application/json", "x-request-id": randomUUID() }');
  },
};
