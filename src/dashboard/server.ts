// `kitchen dashboard`: the page (dashboard/dashboard.html) and its data, on 127.0.0.1 only, for every repo on the
// list (repos.ts, ADR 0019); the routes below sit under /r/<key>/, and a key not on the list is a 404.
// `kitchen dashboard --private` (or --port n) serves the one repo it runs in, on the routes as written.
//   GET  /                         the page, with this launch's token in it (no CDN, nothing from elsewhere; system fonts)
//   GET  /kitchen.json             { kitchen: true, version, private }: a second `kitchen dashboard` asks the port who holds it
//   GET  /repos.json               (the list) each repo's key, name, path and its needs-you, running and job counts
//   GET  /data.json                snapshot(repo): every job, read from .kitchen/ on each request, and this launch's
//                                  id (not the token): a tab from an earlier launch sees it changed and reloads once
//   GET  /jobs/<id>/detail.json    one job: stage history with its agents' activity, thread, criteria
//   GET  /jobs/<id>/report.html    a job's rendered Report
//   GET  /models.json              ADR 0023: each lane's model and the tool's choices (kitchen models; cached ten minutes)
//   GET  /inbox.json               the outer loop (ADR 0022): sources, the collect running now, items, proposals
//   GET  /inbox/<item>/evidence/<f> a screenshot or transcript triage kept
//   POST /api/<action>             steer, answer, approve, follow-up, merge, pause, stop, resume, reject, ticket, start-runner,
//                                  collect, inbox-run, inbox-hold, inbox-unhold, inbox-remove, inbox-edit, inbox-verdict
//                                  (actions.ts; one that gives the queue work starts an orchestrator when none runs)
//
// The page can change state (ADR 0009), so a POST must come from the page this server served:
// the Host check (DNS rebinding), an Origin, when sent, that is this server's own, the per-launch
// token in `x-kitchen-token`, and `content-type: application/json`. A cross-site form or simple
// request can send neither that header nor that type, and can't read the token.
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { JOB_ID, jobDirOf, scanJobs } from "../engine/store.ts";
import { type Listing, listModels } from "../models/models.ts";
import { act, BadRequest } from "./actions.ts";
import { snapshot } from "./data.ts";
import { detail } from "./detail.ts";
import { evidenceFile, inboxSnapshot } from "./inbox.ts";
import { addRepo, type RepoEntry, type RepoList, readRepos, shownPath } from "./repos.ts";

export const DASHBOARD_HTML = path.resolve(import.meta.dirname, "..", "..", "dashboard", "dashboard.html");
const VERSION = (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
/** A POST body larger than this is refused unread. */
export const MAX_BODY = 16 * 1024;

// Sent as HTTP headers (a <meta> CSP can't say frame-ancestors, and X-Frame-Options has no meta form).
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};
/** The page's own: its inline script and styles, its own data, data: images, the system's fonts; nothing from elsewhere; never framed. */
export const PAGE_CSP =
  "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** A Report: no script at all. */
export const REPORT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const LOCAL = ["127.0.0.1", "localhost", "[::1]"];

/** Pure: why a POST is refused, or null. `port` is the one this server listens on. */
export function refusePost(h: http.IncomingHttpHeaders, token: string, port: number): { code: number; why: string } | null {
  const origin = h.origin;
  if (origin !== undefined && !LOCAL.some((n) => origin === `http://${n}:${port}`)) return { code: 403, why: "another origin" };
  const sent = Buffer.from(String(h["x-kitchen-token"] ?? ""));
  const want = Buffer.from(token);
  if (sent.length !== want.length || !timingSafeEqual(sent, want)) return { code: 403, why: "no token, or the wrong one" };
  if (!/^application\/json\s*(;|$)/i.test(String(h["content-type"] ?? ""))) return { code: 415, why: "content-type must be application/json" };
  return null;
}

/** `one`: that repo alone, on the routes without /r/<key> (--private). null: every repo `list` gives, read on each request. */
export function dashboardServer(one: string | null, o: { token?: string; list?: () => RepoList } = {}): http.Server & { token: string; launch: string } {
  const list = o.list ?? (() => readRepos());
  const token = o.token ?? randomBytes(32).toString("hex");
  // Not a secret: it only tells a tab from an earlier launch (holding that launch's token) that the server restarted.
  const launch = randomBytes(8).toString("hex");
  let page: string | null = null;
  const s = http.createServer((req, res) => {
    const send = (code: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": type, ...HEADERS, ...extra });
      res.end(body);
    };
    const json = (code: number, v: unknown) => send(code, "application/json", JSON.stringify(v));
    // DNS rebinding is refused by the Host check: a page on another site can't reach this server under its own name.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOCAL.includes(host)) return send(403, "text/plain", "localhost only\n");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const port = (s.address() as { port?: number } | null)?.port ?? 0;
    const get = req.method === "GET" || req.method === "HEAD";
    const run = async () => {
      if (get && url.pathname === "/kitchen.json") return json(200, { kitchen: true, version: VERSION, private: one !== null });
      if (get && (url.pathname === "/" || url.pathname === "/index.html")) {
        page ??= fs
          .readFileSync(DASHBOARD_HTML, "utf8")
          .replace("__KITCHEN_TOKEN__", token)
          .replace("__KITCHEN_LAUNCH__", launch)
          .replace("__KITCHEN_MODE__", one === null ? "repos" : "one");
        return send(200, "text/html; charset=utf-8", page, { "content-security-policy": PAGE_CSP });
      }
      // Which repo, and the route inside it: the one repo, or the listed repo /r/<key>/ names.
      let repo = one ?? "";
      let route = url.pathname;
      if (one === null) {
        const { repos, last } = list();
        if (get && route === "/repos.json") return json(200, { repos: await Promise.all(repos.map(counts)), last, launch });
        const r = /^\/r\/([A-Za-z0-9._-]+)(\/.*)$/.exec(route);
        const e = r && repos.find((x) => x.key === r[1]);
        if (!r || !e) return send(404, "text/plain", "not found\n");
        repo = e.path;
        route = r[2];
      }
      if (req.method === "POST") {
        const m = /^\/api\/([a-z-]+)$/.exec(route);
        if (!m) return send(404, "text/plain", "not found\n");
        // A refused POST is answered without reading its body, and the connection is closed after the answer.
        const refuse = (code: number, why: string) => {
          res.on("finish", () => req.destroy());
          return send(code, "application/json", JSON.stringify({ ok: false, lines: [why] }), { connection: "close" });
        };
        const no = refusePost(req.headers, token, port);
        if (no) return refuse(no.code, no.why);
        const tooBig = `the request is over ${MAX_BODY} bytes`;
        if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return refuse(413, tooBig);
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) return refuse(413, tooBig);
          chunks.push(c as Buffer);
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
        } catch {
          return json(400, { ok: false, lines: ["the body must be a JSON object"] });
        }
        try {
          const r = await act(repo, m[1], body);
          return json(r.ok ? 200 : 409, r);
        } catch (e) {
          if (e instanceof BadRequest) return json(400, { ok: false, lines: [e.message] });
          throw e;
        }
      }
      if (!get) return send(405, "text/plain", "GET, HEAD or POST\n", { allow: "GET, HEAD, POST" });
      if (route === "/data.json") return json(200, { ...(await snapshot(repo)), launch });
      if (route === "/inbox.json") return json(200, inboxSnapshot(repo));
      if (route === "/models.json") return json(200, await modelsListing(repo));
      if (route.startsWith("/inbox/")) {
        let rel: string;
        try {
          rel = decodeURIComponent(route.slice("/inbox/".length));
        } catch {
          return send(400, "text/plain", "bad path\n");
        }
        const f = evidenceFile(repo, rel);
        if (!f) return send(404, "text/plain", "no such evidence\n");
        const type = /\.png$/i.test(f) ? "image/png" : /\.jpe?g$/i.test(f) ? "image/jpeg" : "text/plain; charset=utf-8";
        return send(200, type, fs.readFileSync(f), { "content-security-policy": REPORT_CSP });
      }
      const m = /^\/jobs\/([^/]+)\/(report\.html|detail\.json)$/.exec(route);
      if (m) {
        let id: string;
        try {
          id = decodeURIComponent(m[1]);
        } catch {
          return send(400, "text/plain", "bad job id\n");
        }
        if (!JOB_ID.test(id) || !scanJobs(repo).some((e) => e.id === id && e.job)) return send(404, "text/plain", "no such job\n");
        if (m[2] === "detail.json") return json(200, await detail(repo, id));
        const f = path.join(jobDirOf(repo, id), "report.html");
        if (!fs.existsSync(f)) return send(404, "text/plain", "no report yet\n");
        // The Report carries its own CSP; this one keeps it from running anything either way.
        return send(200, "text/html; charset=utf-8", fs.readFileSync(f), { "content-security-policy": REPORT_CSP });
      }
      return send(404, "text/plain", "not found\n");
    };
    run().catch((e) => {
      if (!res.headersSent) send(500, "text/plain", `${(e as Error).message}\n`);
      else res.end();
    });
  });
  return Object.assign(s, { token, launch });
}

/** `kitchen models` for the page, at most every ten minutes per repo and tool (it may ask a provider for its list). */
const LISTINGS = new Map<string, { at: number; l: Promise<Listing> }>();
export function modelsListing(repo: string, now = Date.now()): Promise<Listing> {
  let key = repo;
  try {
    key = `${repo}\0${loadConfig(repo).agent.tool}`;
  } catch {}
  const c = LISTINGS.get(key);
  if (c && now - c.at < 600_000) return c.l;
  const l = listModels(repo).catch((e) => {
    LISTINGS.delete(key);
    throw e;
  });
  LISTINGS.set(key, { at: now, l });
  return l;
}
export const forgetListing = () => LISTINGS.clear();

/** A repo's line in the switcher: needs you, running, jobs (the page's own counts, from the same snapshot). */
async function counts(e: RepoEntry) {
  const s = await snapshot(e.path);
  const n = (st: string) => s.jobs.filter((j) => j.state === st && j.pausedBy !== "stop").length;
  return { key: e.key, name: path.basename(e.path), path: shownPath(e.path), you: n("you"), running: n("run"), jobs: s.jobs.length };
}

/** What holds the port: a Kitchen dashboard (shared or --private), or something else. */
async function whoHolds(port: number): Promise<{ kitchen: true; private: boolean } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/kitchen.json`, { signal: AbortSignal.timeout(2000) });
    const d = (await r.json()) as { kitchen?: unknown; private?: unknown };
    return d.kitchen === true ? { kitchen: true, private: d.private === true } : null;
  } catch {
    return null;
  }
}

/** `kitchen dashboard`: adds the repo to the list, then serves the list on `port`, or, when a Kitchen dashboard already
 *  serves it there, says where and returns null. Something else on the port is an error; it never takes another port.
 *  `private`: this repo alone, not on the list (--private, --port). */
export async function serveDashboard(
  repo: string,
  port: number,
  print: (l: string) => void,
  o: { private?: boolean; file?: string } = {},
): Promise<http.Server | null> {
  let key = "";
  if (!o.private) {
    if (!fs.existsSync(path.join(repo, ".kitchen"))) throw new Error(`${repo} has no .kitchen/ yet: kitchen init first (or kitchen dashboard --private)`);
    key = addRepo(repo, o.file).key;
  }
  const s = o.private ? dashboardServer(repo) : dashboardServer(null, o.file ? { list: () => readRepos(o.file) } : {});
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    const who = await whoHolds(port);
    if (who && !who.private && !o.private) {
      print(`already open: http://127.0.0.1:${port}/#${key}`);
      return null;
    }
    throw new Error(
      who
        ? `port ${port} already has a Kitchen dashboard${who.private ? " for one repo (--private)" : ""}: stop it, or pick another with --port`
        : `port ${port} is taken by something that isn't a Kitchen dashboard (or a Kitchen too old to answer /kitchen.json): stop it, or pick a port with --port`,
    );
  }
  const a = s.address();
  print(`dashboard: http://127.0.0.1:${typeof a === "object" && a ? a.port : port}/${key ? `#${key}` : ""}  (this machine only; Ctrl-C stops it)`);
  return s;
}
