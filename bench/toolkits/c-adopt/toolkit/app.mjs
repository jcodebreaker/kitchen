// Project half of the Toolkit for fixture-c-adopt: wraps the repo's own
// docker-compose.yml (postgres + app), one compose project per Kitchen id.
import fs from "node:fs";
import path from "node:path";
import { browserAlive, browserPrimitives, resetBrowser, startBrowser } from "./lib/browser.mjs";
import { installNodeDeps, must, TOOLKIT_DIR } from "./lib/common.mjs";

const composeEnv = (ports) => ({ APP_PORT: String(ports[0]), DB_PORT: String(ports[1]) });
const url = (ctx) => `http://127.0.0.1:${ctx.ports[0]}`;

function psql(ctx, sql) {
  return ctx.compose(["exec", "-T", "db", "psql", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { env: composeEnv(ctx.ports) });
}

const passwordOf = (ctx, user) => ctx.env[`SEED_${user.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASSWORD`];

export default {
  name: "fixture-c-adopt",
  surface: "web",
  // app (http), db (postgres published to the host), browser daemon
  ports: { needs: 3, order: ["app", "db", "browser"] },
  parallel: true,
  externals: [],

  // Read from the seed file, not hand-kept.
  async seedUsers(ctx) {
    const sql = fs.readFileSync(path.join(ctx.src, "db", "002_seed.sql"), "utf8");
    return [...sql.matchAll(/^\s*\('([^']+)',\s*crypt\(/gm)].map((m) => m[1]);
  },

  async prepare(ctx) {
    const how = installNodeDeps(TOOLKIT_DIR);
    must(path.join(TOOLKIT_DIR, "node_modules", ".bin", "playwright"), ["install", "--only-shell", "chromium"], { cwd: TOOLKIT_DIR });
    // Build (and cache) the app image and pull postgres, so `up` is fast.
    must("docker", ["compose", "-p", "kitchen-fixture-c-adopt-prepare", "build"], { cwd: ctx.src, env: { ...process.env, ...composeEnv([3000, 5432]) } });
    must("docker", ["pull", "-q", "postgres:16-alpine"]);
    return { toolkitDeps: how };
  },

  async up(ctx) {
    ctx.compose(["up", "-d", "--build", "--wait"], { env: composeEnv(ctx.ports) });
    await ctx.waitFor(
      async () => {
        const r = await ctx.httpJson(`${url(ctx)}/healthz`);
        return r.status === 200 && r.body?.db === true;
      },
      { timeoutMs: 90000, what: "app /healthz with db" },
    );
    // The db healthcheck can pass on postgres' temporary init server, before the
    // schema/seed scripts have finished: wait until the seed users are really there.
    const seeded = () => {
      try {
        return Number(psql(ctx, "SELECT count(*) FROM users").trim()) >= 2;
      } catch {
        return false;
      }
    };
    try {
      await ctx.waitFor(seeded, { timeoutMs: 20000, what: "seed users in postgres" });
    } catch {
      // The compose bind mount of ./db into /docker-entrypoint-initdb.d did not run
      // (e.g. the Docker daemon can't see this checkout's path): apply the same files ourselves.
      ctx.log("initdb scripts did not run; applying db/*.sql through psql");
      for (const f of ["001_schema.sql", "002_seed.sql"]) {
        must("docker", ["compose", "-p", ctx.state.compose[0].project, "exec", "-T", "db", "psql", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1", "-q"], {
          cwd: ctx.src,
          env: { ...process.env, ...composeEnv(ctx.ports) },
          input: fs.readFileSync(path.join(ctx.src, "db", f), "utf8"),
        });
      }
      if (!seeded()) throw new Error("seed users missing after applying db/*.sql");
    }
    await startBrowser(ctx, {
      port: ctx.ports[2],
      base: url(ctx),
      login: {
        path: "/login",
        user: "[data-testid=login-username]",
        password: "[data-testid=login-password]",
        submit: "[data-testid=login-submit]",
        expect: { target: "[data-testid=signed-in-as]", text: "{user}" },
      },
    });
    return { url: url(ctx) };
  },

  doctor(ctx) {
    return {
      "app healthz reports db": async () => {
        const r = await ctx.httpJson(`${ctx.state.url ?? url(ctx)}/healthz`);
        return (r.status === 200 && r.body?.db === true) || `healthz ${r.status}`;
      },
      "seed users present": () => Number(psql(ctx, "SELECT count(*) FROM users WHERE username IN ('alice','bob-admin')").trim()) === 2 || "seed users missing",
      "browser session": () => browserAlive(ctx),
    };
  },

  // The seed only runs on an empty volume, so restore seed state in place.
  async reset(ctx) {
    psql(
      ctx,
      `TRUNCATE sessions, invites, projects RESTART IDENTITY;
       UPDATE users SET theme = 'light';
       INSERT INTO projects (owner_id, name, description, slug, ready_at)
         SELECT id, 'Onboarding', 'Seeded example project', 'onboarding', now() FROM users WHERE username = 'alice';`,
    );
    await resetBrowser(ctx);
  },

  primitives: {
    ...browserPrimitives({ passwordOf }),
    sql: {
      args: { query: "a single read-only SELECT against the app database" },
      does: "run a SELECT in the instance's postgres and return the rows (pipe-separated, one per line)",
      run(ctx, a) {
        const q = String(a.query ?? "");
        if (!/^\s*select\b/i.test(q) || /;\s*\S/.test(q)) return { ok: false, out: "only a single SELECT is allowed" };
        try {
          return { ok: true, out: psql(ctx, q).trim() };
        } catch (e) {
          return { ok: false, out: e.message };
        }
      },
    },
  },
};
