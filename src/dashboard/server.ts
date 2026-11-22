// `kitchen dashboard [--port n]`: the page (dashboard/dashboard.html) and its data, on 127.0.0.1 only.
//   GET  /                         the page, with this launch's token in it (no CDN, nothing from elsewhere; system fonts)
//   GET  /data.json                snapshot(repo): every job, read from .kitchen/ on each request
//   GET  /jobs/<id>/detail.json    one job: stage history with its agents' activity, thread, criteria
//   GET  /jobs/<id>/report.html    a job's rendered Report
//   GET  /setup.json               the Setup run
//   POST /api/<action>             steer, answer, follow-up, pause, stop, resume, reject, ticket, setup-answers (actions.ts)
//
// The page can change state (ADR 0009), so a POST must come from the page this server served:
// the Host check (DNS rebinding), an Origin, when sent, that is this server's own, the per-launch
// token in `x-kitchen-token`, and `content-type: application/json`. A cross-site form or simple
// request can send neither that header nor that type, and can't read the token.
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { JOB_ID, jobDirOf, scanJobs } from "../engine/store.ts";
import { act, BadRequest } from "./actions.ts";
import { snapshot } from "./data.ts";
import { detail } from "./detail.ts";
import { setupView } from "./setup.ts";

export const DASHBOARD_HTML = path.resolve(import.meta.dirname, "..", "..", "dashboard", "dashboard.html");
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
  "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
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

export function dashboardServer(repo: string, o: { token?: string } = {}): http.Server & { token: string } {
  const token = o.token ?? randomBytes(32).toString("hex");
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
    const run = async () => {
      if (req.method === "POST") {
        const m = /^\/api\/([a-z-]+)$/.exec(url.pathname);
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
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "GET, HEAD or POST\n", { allow: "GET, HEAD, POST" });
      if (url.pathname === "/" || url.pathname === "/index.html") {
        page ??= fs.readFileSync(DASHBOARD_HTML, "utf8").replace("__KITCHEN_TOKEN__", token);
        return send(200, "text/html; charset=utf-8", page, { "content-security-policy": PAGE_CSP });
      }
      if (url.pathname === "/data.json") return json(200, await snapshot(repo));
      if (url.pathname === "/setup.json") return json(200, setupView(repo));
      const m = /^\/jobs\/([^/]+)\/(report\.html|detail\.json)$/.exec(url.pathname);
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
  return Object.assign(s, { token });
}

export async function serveDashboard(repo: string, port: number, print: (l: string) => void): Promise<http.Server> {
  const s = dashboardServer(repo);
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve());
  });
  const a = s.address();
  print(`dashboard: http://127.0.0.1:${typeof a === "object" && a ? a.port : port}/  (this machine only; Ctrl-C stops it)`);
  return s;
}
