// Project half of the Kitchen Toolkit for library-demo (a lending-library JSON API).
// The app is plain node:http with no dependencies; its data is one JSON file that it
// loads once at start, so `reset` means: stop it, restore the seed file, start it again.
import fs from "node:fs";
import path from "node:path";
import { killGroup, sameOrigin } from "./lib/common.mjs";

const dataDir = (ctx) => path.join(ctx.stateDir, "data");
const dataFile = (ctx) => path.join(dataDir(ctx), "library.json");
const seedOf = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.src, "seed.json"), "utf8"));
const base = (ctx) => `http://127.0.0.1:${ctx.ports[0]}`;

async function request(ctx, method, p, body, as) {
  const url = sameOrigin(base(ctx), p);
  const r = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { "x-member": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: r.status, body: parsed };
}

function freshData(ctx) {
  fs.rmSync(dataDir(ctx), { recursive: true, force: true });
  fs.mkdirSync(dataDir(ctx), { recursive: true });
  fs.copyFileSync(path.join(ctx.src, "seed.json"), dataFile(ctx));
}

function start(ctx) {
  ctx.spawn("app", process.execPath, ["server.js"], {
    cwd: ctx.src,
    env: { PORT: String(ctx.ports[0]), DATA_DIR: dataDir(ctx) },
  });
}

async function ready(ctx) {
  await ctx.waitFor(
    async () => {
      const seed = seedOf(ctx);
      const h = await request(ctx, "GET", "/healthz");
      const b = await request(ctx, "GET", "/books", undefined, seed.members[0].id);
      return h.status === 200 && h.body?.ok === true && h.body.books === seed.books.length && b.status === 200;
    },
    { timeoutMs: 20000, what: "the API to answer /healthz and list books" },
  );
}

export default {
  name: "library-demo",
  surface: "api",
  ports: { needs: 1, order: ["app"] },
  parallel: true,
  externals: [],

  async seedUsers(ctx) {
    return seedOf(ctx).members.map((m) => m.id);
  },

  async prepare(_ctx) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 20 || (major === 20 && minor < 11)) throw new Error(`Node >=20.11 needed, found ${process.version}`);
    return { node: process.version, deps: "none" };
  },

  async up(ctx) {
    freshData(ctx);
    start(ctx);
    await ready(ctx);
    return { url: base(ctx) };
  },

  doctor(ctx) {
    return {
      "healthz reports store and all seed books": async () => {
        const h = await request(ctx, "GET", "/healthz");
        return (h.status === 200 && h.body?.ok === true && h.body.books >= seedOf(ctx).books.length) || `healthz: ${h.status} ${JSON.stringify(h.body)}`;
      },
      "seed member can list books, unknown member gets 401": async () => {
        const a = await request(ctx, "GET", "/books", undefined, seedOf(ctx).members[0].id);
        const u = await request(ctx, "GET", "/books", undefined, "nobody");
        return (a.status === 200 && u.status === 401) || `member ${a.status}, unknown ${u.status}`;
      },
      "data file exists and parses": () => {
        try {
          JSON.parse(fs.readFileSync(dataFile(ctx), "utf8"));
          return true;
        } catch (e) {
          return e.message;
        }
      },
    };
  },

  async reset(ctx) {
    await killGroup(ctx.state.pids?.app);
    freshData(ctx);
    ctx.state.last = undefined;
    start(ctx);
    await ready(ctx);
  },

  async down(_ctx) {},

  primitives: {
    http: {
      args: {
        method: "GET|POST",
        path: "/healthz, /books, /loans/4/return …",
        body: "optional JSON string",
        as: "seed member id sent as X-Member (omit for none)",
        expect_status: "optional: ok only for this status (e.g. 409)",
        expect_body: "optional: ok only if the compact JSON of the response contains this text",
      },
      does: "same-origin request to the API; out is {status, body}; ok whenever it answered unless an expectation differs",
      async run(ctx, a) {
        const body = typeof a.body === "string" && a.body ? JSON.parse(a.body) : a.body;
        const r = await request(ctx, String(a.method || "GET").toUpperCase(), a.path, body, a.as);
        ctx.state.last = r;
        let ok = true;
        if (a.expect_status !== undefined && a.expect_status !== "") ok = r.status === Number(a.expect_status);
        if (ok && a.expect_body) ok = JSON.stringify(r.body).includes(String(a.expect_body));
        return { ok, out: r };
      },
    },
    read: {
      args: { target: "status | body (default body)" },
      does: "the last http response's status or body; ok:false before any call",
      run(ctx, a) {
        const last = ctx.state.last;
        if (!last) return { ok: false, out: "no http call yet" };
        const t = a.target === undefined ? "body" : String(a.target);
        if (!["status", "body"].includes(t)) return { ok: false, out: `no target ${t} (status, body)` };
        return { ok: true, out: last[t] };
      },
    },
    stored: {
      args: {
        table: "books | loans | members",
        where: "optional key=value, e.g. id=1",
        expect: "optional: ok only if the compact JSON of the matching rows contains this text",
      },
      does: "read rows straight from the app's data file (second view, bypasses the API)",
      run(ctx, a) {
        let data;
        try {
          data = JSON.parse(fs.readFileSync(dataFile(ctx), "utf8"));
        } catch (e) {
          return { ok: false, out: `cannot read data file: ${e.message}` };
        }
        const rows = data[a.table];
        if (!Array.isArray(rows)) return { ok: false, out: `no table ${a.table} (books, loans, members)` };
        let found = rows;
        if (a.where) {
          const [k, ...v] = String(a.where).split("=");
          found = rows.filter((r) => String(r[k]) === v.join("="));
        }
        const ok = found.length > 0 && (!a.expect || JSON.stringify(found).includes(String(a.expect)));
        return { ok, out: found };
      },
    },
  },
};
