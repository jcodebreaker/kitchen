// `kitchen dashboard [--port n]`: a tiny static server for dashboard/dashboard.html, on
// 127.0.0.1 only, read-only. Three things are served, nothing else:
//   GET /                         dashboard.html (self-contained: no CDN, no fonts, no scripts from elsewhere)
//   GET /data.json                snapshot(repo): the board, read from .kitchen/ on every request
//   GET /jobs/<id>/report.html    a job's rendered Report, for a job that exists
// Any other method or path is 405/404. The page polls /data.json while jobs run.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { jobDirOf, scanJobs } from "../engine/store.ts";
import { snapshot } from "./data.ts";

export const DASHBOARD_HTML = path.resolve(import.meta.dirname, "..", "..", "dashboard", "dashboard.html");

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

export function dashboardServer(repo: string): http.Server {
  return http.createServer((req, res) => {
    const send = (code: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": type, ...HEADERS, ...extra });
      res.end(body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "read-only\n", { allow: "GET, HEAD" });
    // A page on another site can't read this server's answers, and DNS rebinding is refused by the Host check.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(403, "text/plain", "localhost only\n");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") return send(200, "text/html; charset=utf-8", fs.readFileSync(DASHBOARD_HTML));
      if (url.pathname === "/data.json") return send(200, "application/json", JSON.stringify(snapshot(repo)));
      const m = /^\/jobs\/([^/]+)\/report\.html$/.exec(url.pathname);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!scanJobs(repo).some((e) => e.id === id)) return send(404, "text/plain", "no such job\n");
        const f = path.join(jobDirOf(repo, id), "report.html");
        if (!fs.existsSync(f)) return send(404, "text/plain", "no report yet\n");
        // The Report carries its own CSP; this one keeps it from running anything either way.
        return send(200, "text/html; charset=utf-8", fs.readFileSync(f), {
          "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        });
      }
      return send(404, "text/plain", "not found\n");
    } catch (e) {
      return send(500, "text/plain", `${(e as Error).message}\n`);
    }
  });
}

export async function serveDashboard(repo: string, port: number, print: (l: string) => void): Promise<http.Server> {
  const s = dashboardServer(repo);
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve());
  });
  const a = s.address();
  print(`dashboard: http://127.0.0.1:${typeof a === "object" && a ? a.port : port}/  (read-only, this machine only; Ctrl-C stops it)`);
  return s;
}
