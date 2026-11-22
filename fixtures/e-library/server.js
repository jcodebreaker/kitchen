// Fixture E: a small lending library API. Members borrow and return books; a librarian
// adds books. Plain node:http, the data in one JSON file. Config from env only:
//   PORT, DATA_DIR
import http from "node:http";
import { availableCopies, checkBorrow, HttpError, newLoan, today } from "./lib/loans.js";
import { openStore } from "./lib/store.js";

const PORT = Number(process.env.PORT || 4100);
const DATA_DIR = process.env.DATA_DIR || "./data";

const store = openStore(DATA_DIR, new URL("./seed.json", import.meta.url));
const db = store.data;

// ---------- helpers ----------

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, "body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const findBook = (id) => db.books.find((b) => b.id === id);
const presentBook = (b) => ({ ...b, available: availableCopies(b, db.loans) });
const presentLoan = (l) => ({ ...l, title: findBook(l.book_id)?.title ?? null });

/** The member named by the X-Member header, or a 401. */
function memberOf(req) {
  const m = db.members.find((x) => x.id === req.headers["x-member"]);
  if (!m) throw new HttpError(401, "missing or unknown X-Member");
  return m;
}

const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

// ---------- routes ----------

async function addBook(req, res, member) {
  if (member.role !== "librarian") throw new HttpError(403, "only librarians can add books");
  const body = await readBody(req);
  if (!nonEmpty(body.title)) throw new HttpError(400, "title is required");
  if (!nonEmpty(body.author)) throw new HttpError(400, "author is required");
  if (!Number.isInteger(body.copies) || body.copies < 1 || body.copies > 20) throw new HttpError(400, "copies must be an integer from 1 to 20");
  const book = { id: store.nextId(db.books), title: body.title.trim(), author: body.author.trim(), copies: body.copies };
  db.books.push(book);
  store.save();
  json(res, 201, presentBook(book));
}

async function borrow(req, res, member) {
  const body = await readBody(req);
  const book = findBook(body.book_id);
  if (!book) throw new HttpError(404, "book not found");
  checkBorrow(book, member, db.loans);
  const loan = newLoan(store.nextId(db.loans), book, member, today());
  db.loans.push(loan);
  store.save();
  json(res, 201, presentLoan(loan));
}

function giveBack(res, member, id) {
  const loan = db.loans.find((l) => l.id === id);
  // Someone else's loan is not found, unless a librarian is checking it in.
  if (!loan || (loan.member !== member.id && member.role !== "librarian")) throw new HttpError(404, "loan not found");
  if (loan.returned_at) throw new HttpError(409, "this loan was already returned");
  loan.returned_at = today();
  store.save();
  json(res, 200, presentLoan(loan));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const method = req.method;

  if (path === "/healthz" && method === "GET") {
    const ok = store.healthy();
    return json(res, ok ? 200 : 503, { ok, store: ok, books: db.books.length });
  }

  const member = memberOf(req);

  if (path === "/books" && method === "GET") return json(res, 200, db.books.map(presentBook));
  if (path === "/books" && method === "POST") return addBook(req, res, member);
  const book = path.match(/^\/books\/(\d+)$/);
  if (book && method === "GET") {
    const b = findBook(Number(book[1]));
    return b ? json(res, 200, presentBook(b)) : json(res, 404, { error: "book not found" });
  }

  if (path === "/loans" && method === "GET") return json(res, 200, db.loans.filter((l) => l.member === member.id).map(presentLoan));
  if (path === "/loans" && method === "POST") return borrow(req, res, member);
  const ret = path.match(/^\/loans\/(\d+)\/return$/);
  if (ret && method === "POST") return giveBack(res, member, Number(ret[1]));

  json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  });
});
server.listen(PORT, () => console.error(`fixture-e-library listening on http://127.0.0.1:${PORT} (data: ${store.file})`));
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
