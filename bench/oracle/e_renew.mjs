// Hidden oracle (bench) for e-renew: through the oracle app's own HTTP API on loopback
// (the bench fills `{port:0}`, the app's port per the Toolkit's describe):
//   - a renewal moves the due date 14 days on from the current due date, and it sticks;
//   - a second renewal of the same loan is refused (4xx) and changes nothing;
//   - a returned loan can't be renewed (4xx).
//   node oracle_renew.mjs <app port>
const port = Number(process.argv[2]);
if (!port) {
  console.log("usage: node oracle_renew.mjs <app port>");
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
async function call(method, path, as, body) {
  const headers = { "x-member": as };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  console.log(`${method} ${path} as ${as} -> ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, body: json };
}
const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const problems = [];
const is4xx = (s) => s >= 400 && s < 500;

// ben borrows The Fellowship of the Ring (book 2, free in the seed).
const lent = await call("POST", "/loans", "ben", { book_id: 2 });
if (lent.status !== 201 || !lent.body?.due_at) {
  console.log("could not borrow book 2 as ben");
  process.exit(1);
}
const { id, due_at: due } = lent.body;
const want = addDays(due, 14);

const first = await call("POST", `/loans/${id}/renew`, "ben");
if (first.status < 200 || first.status > 299) problems.push(`the first renewal answered ${first.status}`);
else if (first.body?.due_at !== want) problems.push(`after renewing, due_at is ${first.body?.due_at}, want ${want} (14 days after ${due})`);

const second = await call("POST", `/loans/${id}/renew`, "ben");
if (!is4xx(second.status)) problems.push(`a second renewal answered ${second.status}, want a refusal (4xx)`);

const mine = await call("GET", "/loans", "ben");
const stored = Array.isArray(mine.body) ? mine.body.find((l) => l.id === id) : null;
if (stored?.due_at !== want) problems.push(`GET /loans shows due_at ${stored?.due_at}, want ${want} (the one renewal only)`);

// A returned loan: ana borrows Kindred (book 4), returns it, then tries to renew.
const k = await call("POST", "/loans", "ana", { book_id: 4 });
if (k.status === 201) {
  await call("POST", `/loans/${k.body.id}/return`, "ana");
  const r = await call("POST", `/loans/${k.body.id}/renew`, "ana");
  if (!is4xx(r.status)) problems.push(`renewing a returned loan answered ${r.status}, want a refusal (4xx)`);
} else problems.push(`could not borrow book 4 as ana (${k.status})`);

for (const p of problems) console.log(`PROBLEM: ${p}`);
process.exitCode = problems.length ? 1 : 0;
