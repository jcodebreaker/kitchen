// Fixture C: a small web app with Postgres, local sign-in, a settings page
// with a persisted dark-mode toggle, a two-step "create project" form and
// admin invites. Plain node:http, no framework. Config from env only:
//   PORT, HOST (default 127.0.0.1), DATABASE_URL
import { randomBytes } from "node:crypto";
import http from "node:http";
import pg from "pg";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
// Idle clients die when the database is recreated; log and let the pool reconnect.
pool.on("error", (e) => console.error("pg pool:", e.message));

// ---------- tiny helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      const type = req.headers["content-type"] || "";
      try {
        if (type.includes("application/json")) resolve(data ? JSON.parse(data) : {});
        else resolve(Object.fromEntries(new URLSearchParams(data)));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((p) => p.trim().split("="))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]),
  );
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(body);
};
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "content-type": "application/json" });
const redirect = (res, to, headers = {}) => send(res, 303, "", { location: to, ...headers });

async function currentUser(req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const { rows } = await pool.query("SELECT u.id, u.username, u.is_admin, u.theme FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1", [sid]);
  return rows[0] || null;
}

// ---------- layout ----------

const CSS = `
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#e3e3de; --accent:#2f5bd3; --err:#b3261e; }
body.theme-dark { --bg:#141416; --fg:#ececea; --muted:#9a9a94; --card:#1f1f22; --line:#2f2f33; --accent:#8fb0ff; --err:#ff8a80; }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
header { display:flex; gap:16px; align-items:center; padding:12px 24px; border-bottom:1px solid var(--line); background:var(--card); }
header .brand { font-weight:600; margin-right:auto; }
header a { color:var(--accent); text-decoration:none; }
main { max-width:560px; margin:32px auto; padding:0 16px; }
section, form.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; margin-bottom:16px; }
label { display:block; margin:12px 0 4px; color:var(--muted); }
input, textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
button { margin-top:16px; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
button.link { background:none; color:var(--accent); border:none; margin:0; padding:0; }
.error { color:var(--err); }
.muted { color:var(--muted); }
.switch { display:flex; align-items:center; justify-content:space-between; }
.switch button[aria-checked=true] { background:var(--fg); color:var(--bg); }
code { font-size:1.2em; }
`;

function page(title, body, user) {
  const theme = user?.theme === "dark" ? "theme-dark" : "theme-light";
  const nav = user
    ? `<nav aria-label="Main">
        <a href="/home" data-testid="nav-home">Home</a>
        <a href="/projects" data-testid="nav-projects">Projects</a>
        <a href="/projects/new" data-testid="nav-new-project">New project</a>
        <a href="/settings" data-testid="nav-settings">Settings</a>
        ${user.is_admin ? `<a href="/admin" data-testid="nav-admin">Admin</a>` : ""}
      </nav>
      <form method="post" action="/logout"><button class="link" data-testid="sign-out">Sign out</button></form>`
    : `<a href="/login" data-testid="nav-sign-in">Sign in</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Fixture C</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head>
<body class="${theme}"><header><span class="brand">Fixture C</span>${nav}</header><main>${body}</main></body></html>`;
}

// ---------- pages ----------

const loginPage = (error = "") =>
  page(
    "Sign in",
    `<h1>Sign in</h1>
    <form class="card" method="post" action="/login" aria-label="Sign in">
      ${error ? `<p class="error" role="alert" data-testid="login-error">${esc(error)}</p>` : ""}
      <label for="username">Username</label><input id="username" name="username" data-testid="login-username" autocomplete="username">
      <label for="password">Password</label><input id="password" name="password" type="password" data-testid="login-password" autocomplete="current-password">
      <button type="submit" data-testid="login-submit">Sign in</button>
    </form>
    <p><a href="/join" data-testid="join-link">Have an invite code?</a></p>`,
  );

function step1Page(user, v = {}) {
  return page(
    "New project",
    `<h1>New project</h1><p class="muted" data-testid="wizard-step">Step 1 of 2: basics</p>
    <form class="card" method="post" action="/projects/new/step1" aria-label="New project step 1">
      <label for="name">Project name</label><input id="name" name="name" value="${esc(v.name)}" data-testid="project-name" required>
      <label for="description">Description</label><textarea id="description" name="description" data-testid="project-description">${esc(v.description)}</textarea>
      <button type="submit" data-testid="wizard-next">Next</button>
    </form>`,
    user,
  );
}

function step2Page(user, v, error = "") {
  return page(
    "New project",
    `<h1>New project</h1><p class="muted" data-testid="wizard-step">Step 2 of 2: address</p>
    <form class="card" method="post" action="/projects/new/step2" aria-label="New project step 2">
      <p>Name: <strong data-testid="wizard-name">${esc(v.name)}</strong></p>
      <input type="hidden" name="name" value="${esc(v.name)}"><input type="hidden" name="description" value="${esc(v.description)}">
      <label for="slug">Project address (slug)</label><input id="slug" name="slug" value="${esc(v.slug)}" data-testid="project-slug" aria-describedby="slug-help">
      <p id="slug-help" class="muted">3–30 lowercase letters, digits or dashes.</p>
      ${error ? `<p class="error" role="alert" data-testid="slug-error">${esc(error)}</p>` : ""}
      <button type="submit" data-testid="wizard-create">Create project</button>
    </form>`,
    user,
  );
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const method = req.method;

  if (path === "/healthz") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { ok: true, db: true });
    } catch (e) {
      return json(res, 503, { ok: false, db: false, why: e.message });
    }
  }

  if (path === "/login" && method === "GET") return send(res, 200, loginPage());
  if (path === "/login" && method === "POST") {
    const { username, password } = await readBody(req);
    const { rows } = await pool.query("SELECT id FROM users WHERE username = $1 AND password_hash = crypt($2, password_hash)", [
      username || "",
      password || "",
    ]);
    if (!rows[0]) return send(res, 401, loginPage("Wrong username or password."));
    const token = randomBytes(24).toString("hex");
    await pool.query("INSERT INTO sessions (token, user_id) VALUES ($1, $2)", [token, rows[0].id]);
    return redirect(res, "/home", { "set-cookie": `sid=${token}; HttpOnly; SameSite=Lax; Path=/` });
  }

  if (path === "/join" && method === "GET") {
    return send(
      res,
      200,
      page(
        "Join",
        `<h1>Join with an invite</h1>
        <form class="card" method="post" action="/join" aria-label="Join">
          <label for="code">Invite code</label><input id="code" name="code" data-testid="invite-input">
          <button type="submit" data-testid="invite-submit">Join</button>
        </form>`,
      ),
    );
  }
  if (path === "/join" && method === "POST") {
    const { code } = await readBody(req);
    const { rows } = await pool.query("UPDATE invites SET accepted_at = now() WHERE code = $1 AND accepted_at IS NULL RETURNING code", [
      String(code || "").trim(),
    ]);
    const msg = rows[0]
      ? `<p role="status" data-testid="invite-result">Invite accepted: ${esc(rows[0].code)}</p>`
      : `<p class="error" role="alert" data-testid="invite-result">Invite code not found or already used.</p>`;
    return send(res, rows[0] ? 200 : 400, page("Join", `<h1>Join with an invite</h1><section>${msg}</section>`));
  }

  const user = await currentUser(req);
  if (!user) {
    if (path.startsWith("/api/")) return json(res, 401, { error: "signed out" });
    return redirect(res, "/login");
  }

  if (path === "/" || path === "/home") {
    return send(res, 200, page("Home", `<h1>Home</h1><section><p data-testid="signed-in-as">Signed in as ${esc(user.username)}</p></section>`, user));
  }

  if (path === "/logout" && method === "POST") {
    await pool.query("DELETE FROM sessions WHERE token = $1", [cookies(req).sid]);
    return redirect(res, "/login", { "set-cookie": "sid=; Max-Age=0; Path=/" });
  }

  if (path === "/api/me") return json(res, 200, { username: user.username, admin: user.is_admin, theme: user.theme });

  if (path === "/settings" && method === "GET") {
    const dark = user.theme === "dark";
    return send(
      res,
      200,
      page(
        "Settings",
        `<h1>Settings</h1>
        <section aria-labelledby="appearance-h">
          <h2 id="appearance-h">Appearance</h2>
          <div class="switch">
            <span>Dark mode</span>
            <button type="button" role="switch" aria-label="Dark mode" aria-checked="${dark}" data-testid="dark-mode-toggle">${dark ? "On" : "Off"}</button>
          </div>
          <p class="muted">Current theme: <span data-testid="theme-state">${dark ? "Dark" : "Light"}</span>
            <span role="status" data-testid="theme-status"></span></p>
        </section>
        <script>
          const t = document.querySelector('[data-testid=dark-mode-toggle]');
          const status = document.querySelector('[data-testid=theme-status]');
          t.addEventListener('click', async () => {
            const next = t.getAttribute('aria-checked') === 'true' ? 'light' : 'dark';
            status.textContent = 'Saving…';
            const r = await fetch('/api/settings/theme', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: next }) });
            if (!r.ok) { status.textContent = 'Could not save'; return; }
            t.setAttribute('aria-checked', String(next === 'dark'));
            t.textContent = next === 'dark' ? 'On' : 'Off';
            document.body.className = 'theme-' + next;
            document.querySelector('[data-testid=theme-state]').textContent = next === 'dark' ? 'Dark' : 'Light';
            // Simulate a slower save confirmation so drives need a real wait.
            setTimeout(() => { status.textContent = 'Saved'; }, 400);
          });
        </script>`,
        user,
      ),
    );
  }

  if (path === "/api/settings/theme" && method === "POST") {
    const { theme } = await readBody(req);
    if (theme !== "light" && theme !== "dark") return json(res, 400, { error: "theme must be light or dark" });
    await pool.query("UPDATE users SET theme = $1 WHERE id = $2", [theme, user.id]);
    return json(res, 200, { theme });
  }

  if (path === "/projects" && method === "GET") {
    const { rows } = await pool.query("SELECT name, slug FROM projects WHERE owner_id = $1 ORDER BY id", [user.id]);
    const items = rows.map((p) => `<li><a href="/projects/${esc(p.slug)}" data-testid="project-link-${esc(p.slug)}">${esc(p.name)}</a></li>`).join("");
    return send(res, 200, page("Projects", `<h1>Projects</h1><section><ul data-testid="project-list">${items}</ul></section>`, user));
  }

  if (path === "/projects/new" && method === "GET") return send(res, 200, step1Page(user));
  if (path === "/projects/new/step1" && method === "POST") {
    const v = await readBody(req);
    if (!String(v.name || "").trim()) return send(res, 400, step1Page(user, v));
    return send(res, 200, step2Page(user, { ...v, slug: "" }));
  }
  if (path === "/projects/new/step2" && method === "POST") {
    const v = await readBody(req);
    const slug = String(v.slug || "");
    if (!/^[a-z0-9-]{3,30}$/.test(slug)) {
      return send(res, 400, step2Page(user, v, "Slug must be 3–30 lowercase letters, digits or dashes."));
    }
    const taken = await pool.query("SELECT 1 FROM projects WHERE slug = $1", [slug]);
    if (taken.rows[0]) return send(res, 400, step2Page(user, v, "That slug is already taken."));
    await pool.query("INSERT INTO projects (owner_id, name, description, slug) VALUES ($1, $2, $3, $4)", [user.id, v.name, v.description || "", slug]);
    return redirect(res, `/projects/${slug}`);
  }

  const proj = path.match(/^\/(api\/)?projects\/([a-z0-9-]+)$/);
  if (proj && method === "GET") {
    const { rows } = await pool.query("SELECT name, slug, description, now() >= ready_at AS ready FROM projects WHERE slug = $1 AND owner_id = $2", [
      proj[2],
      user.id,
    ]);
    const p = rows[0];
    if (proj[1]) return p ? json(res, 200, p) : json(res, 404, { error: "not found" });
    if (!p) return send(res, 404, page("Not found", "<h1>Project not found</h1>", user));
    return send(
      res,
      200,
      page(
        p.name,
        `<h1 data-testid="project-title">${esc(p.name)}</h1>
        <section><p class="muted">${esc(p.description)}</p>
        <p>Address: <code data-testid="project-slug-value">${esc(p.slug)}</code></p>
        <p>Status: <strong role="status" data-testid="project-status">${p.ready ? "Ready" : "Provisioning…"}</strong></p></section>
        <script>
          const s = document.querySelector('[data-testid=project-status]');
          const poll = async () => {
            const r = await fetch('/api/projects/${esc(p.slug)}');
            const j = await r.json();
            if (j.ready) s.textContent = 'Ready'; else setTimeout(poll, 300);
          };
          if (s.textContent !== 'Ready') setTimeout(poll, 300);
        </script>`,
        user,
      ),
    );
  }

  if (path === "/admin" || path === "/admin/invites") {
    if (!user.is_admin) return send(res, 403, page("Forbidden", "<h1>Admins only</h1>", user));
    if (method === "POST") {
      const code = `INV-${randomBytes(4).toString("hex").toUpperCase()}`;
      await pool.query("INSERT INTO invites (code, created_by) VALUES ($1, $2)", [code, user.id]);
      return redirect(res, `/admin?code=${code}`);
    }
    const code = url.searchParams.get("code");
    return send(
      res,
      200,
      page(
        "Admin",
        `<h1>Admin</h1>
        <section aria-labelledby="inv-h"><h2 id="inv-h">Invites</h2>
          ${code ? `<p>New invite code: <code data-testid="invite-code">${esc(code)}</code></p>` : `<p class="muted">No invite generated yet.</p>`}
          <form method="post" action="/admin/invites"><button data-testid="generate-invite">Generate invite</button></form>
        </section>`,
        user,
      ),
    );
  }

  return send(res, 404, page("Not found", "<h1>Not found</h1>", user));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  });
});
server.listen(PORT, HOST, () => console.error(`fixture-c-adopt listening on http://${HOST}:${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    server.closeAllConnections();
  });
