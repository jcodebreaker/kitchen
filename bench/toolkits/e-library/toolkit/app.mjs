// The project half of the fixture-e-library Toolkit. bin/dev (generic, contract v1) calls these.
// App: a Node lending library API (node:http, one JSON file under DATA_DIR). No externals.
import fs from "node:fs";
import path from "node:path";
import { killGroup, sameOrigin } from "./lib/common.mjs";

const NAME = "fixture-e-library";
const dataDir = (ctx) => path.join(ctx.stateDir, "data");
const storeFile = (ctx) => path.join(dataDir(ctx), "library.json");
const appUrl = (ctx) => `http://127.0.0.1:${ctx.ports[0]}`;
const J = (v) => JSON.stringify(v);

/** The seed members (the X-Member names), from the app's own seed.json. */
const members = (src) => JSON.parse(fs.readFileSync(path.join(src, "seed.json"), "utf8")).members.map((m) => m.id);
const seedCounts = (src) => {
  const s = JSON.parse(fs.readFileSync(path.join(src, "seed.json"), "utf8"));
  return { books: s.books.length, loans: s.loans.length };
};

function startApp(ctx) {
  // A fresh data dir: the app creates library.json from seed.json on start.
  fs.rmSync(dataDir(ctx), { recursive: true, force: true });
  fs.mkdirSync(dataDir(ctx), { recursive: true });
  ctx.spawn("app", "node", ["server.js"], { cwd: ctx.src, env: { ...ctx.env, PORT: String(ctx.ports[0]), DATA_DIR: dataDir(ctx) } });
}

async function ready(ctx) {
  await ctx.waitFor(
    async () => {
      const r = await ctx.httpJson(`${appUrl(ctx)}/healthz`, undefined, 3000);
      return r.status === 200 && r.body?.store === true;
    },
    { timeoutMs: 20000, what: "/healthz to report store: true" },
  );
  const want = seedCounts(ctx.src);
  const s = readStore(ctx);
  if (s.books.length !== want.books || s.loans.length !== want.loans)
    throw new Error(`store has ${s.books.length} books and ${s.loans.length} loans, the seed has ${want.books} and ${want.loans}`);
}

const readStore = (ctx) => JSON.parse(fs.readFileSync(storeFile(ctx), "utf8"));

async function callApp(ctx, { method = "GET", path: p = "/", body, as }) {
  const url = sameOrigin(appUrl(ctx), p);
  const h = {};
  if (as) {
    const known = members(ctx.src);
    if (!known.includes(as)) throw new Error(`unknown seed user ${J(as)} (have ${known.join(", ")})`);
    h["x-member"] = as;
  }
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: r.status, body: parsed };
}

const getPath = (obj, p) => p.split(".").reduce((o, k) => (o !== undefined && o !== null ? o[k] : undefined), obj);
const show = (v) => (typeof v === "string" ? v : J(v));

export default {
  name: NAME,
  surface: "api",
  ports: { needs: 1, order: ["app"] },
  parallel: true,
  externals: [],

  async seedUsers(ctx) {
    return members(ctx.src);
  },

  // No dependencies to install and no snapshot to build: the app seeds its own store on start.
  async prepare(ctx) {
    return { deps: "none", seed: fs.existsSync(path.join(ctx.src, "seed.json")) ? "seed.json" : "missing" };
  },

  async up(ctx) {
    fs.mkdirSync(ctx.stateDir, { recursive: true });
    startApp(ctx);
    await ready(ctx);
    return { url: appUrl(ctx) };
  },

  doctor(ctx) {
    return {
      "app healthz reports store": async () => {
        const r = await ctx.httpJson(`${appUrl(ctx)}/healthz`, undefined, 3000);
        return (r.status === 200 && r.body?.store === true) || `status ${r.status}`;
      },
      "store file parses": () => Array.isArray(readStore(ctx).books) || "library.json has no books",
      "seed member accepted": async () => (await callApp(ctx, { path: "/books", as: members(ctx.src)[0] })).status === 200 || "seed member rejected",
    };
  },

  async reset(ctx) {
    await killGroup(ctx.state.pids?.app);
    ctx.state.last = undefined;
    startApp(ctx);
    await ready(ctx);
  },

  async down(_ctx) {},

  primitives: {
    http: {
      args: {
        method: "GET|POST (default GET)",
        path: "path on the app, e.g. /books",
        body: "raw JSON string, optional",
        as: "seed user (member id) sent as X-Member; omit to send none",
        expect_status: "optional: ok is false unless the status matches",
      },
      does: "Sends one request to the app (same origin only) and remembers the response for `read`. ok when a response came back (and the status matches expect_status if given).",
      async run(ctx, a) {
        const res = await callApp(ctx, { method: a.method, path: a.path, body: a.body, as: a.as });
        ctx.state.last = res;
        return { ok: a.expect_status === undefined || String(res.status) === String(a.expect_status), out: J(res) };
      },
    },
    read: {
      args: {
        target: "status (the HTTP code) | body | body.<dotted path> or just <dotted path> into the JSON body (due_at, 0.title, body.available)",
        equals: "optional: ok is false unless the value equals this",
      },
      does: "Reads from the last http response. A missing field is ok:false.",
      async run(ctx, a) {
        const last = ctx.state.last;
        if (!last) return { ok: false, out: "no response yet" };
        const t = String(a.target ?? "body");
        const v = t === "status" ? last.status : t === "body" ? last.body : getPath(last.body, t.replace(/^body\./, ""));
        if (v === undefined) return { ok: false, out: `no ${t} in the last response` };
        const s = show(v);
        return { ok: a.equals === undefined || s === String(a.equals), out: s };
      },
    },
    stored: {
      args: {
        collection: "books | loans | members",
        record: "the record's id (a loan or book number, a member id)",
        field: "optional: one field of the record (returned_at, copies…)",
        equals: "optional: ok is false unless the value equals this (null for an empty field)",
      },
      does: "Reads one record straight from the app's library.json (the second view of what the API shows). A missing record is ok:false.",
      async run(ctx, a) {
        const rows = readStore(ctx)[a.collection];
        if (!Array.isArray(rows)) return { ok: false, out: `no collection ${J(a.collection)} (books, loans, members)` };
        const row = rows.find((r) => String(r.id) === String(a.record));
        if (!row) return { ok: false, out: `no ${a.collection} record ${a.record}` };
        const v = a.field === undefined ? row : row[a.field];
        if (v === undefined) return { ok: false, out: `${a.collection} ${a.record} has no ${a.field}` };
        const s = v === null ? "null" : show(v);
        return { ok: a.equals === undefined || s === String(a.equals), out: s };
      },
    },
  },
};
