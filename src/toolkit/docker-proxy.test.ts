// The guard's proxy as a process, against a fake daemon (no Docker): it records
// the containers it creates, and a later proxy (a later `bin/dev down`) still
// lets those through while another project's container is refused.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const dir = fs.mkdtempSync("/tmp/kdp-");
const upstream = path.join(dir, "daemon.sock");
const owned = path.join(dir, "owned.jsonl");
const PROXY = path.resolve(import.meta.dirname, "docker-proxy.ts");
const MINE = "a".repeat(64);
const THEIRS = "b".repeat(64);
const seen: string[] = [];

// The fake daemon: create answers MINE; names resolve as Docker would (name, full id or prefix).
const daemon = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  req.resume();
  const url = req.url ?? "";
  if (url.startsWith("/v1.47/containers/create")) return send(201, { Id: MINE, Warnings: [] });
  const m = /^\/containers\/([^/]+)\/json$/.exec(url);
  if (m) {
    const n = decodeURIComponent(m[1]);
    if (n === "kitchen-app-001" || MINE.startsWith(n)) return send(200, { Id: MINE });
    if (n === "supabase_db_offstage" || THEIRS.startsWith(n)) return send(200, { Id: THEIRS });
    return send(404, { message: "No such container" });
  }
  send(200, { ok: true });
});
await new Promise<void>((r) => daemon.listen(upstream, r));

const procs: ChildProcess[] = [];
async function proxy(name: string): Promise<string> {
  const d = path.join(dir, name);
  fs.mkdirSync(d);
  procs.push(
    spawn(process.execPath, [PROXY, "serve", "--dir", d, "--upstream", upstream, "--owned", owned, "--root", dir], { stdio: ["ignore", "ignore", "ignore"] }),
  );
  const sock = path.join(d, "docker.sock");
  for (let i = 0; i < 200 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 25));
  return sock;
}
const call = (sock: string, method: string, p: string, body?: unknown) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { socketPath: sock, method, path: p, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    r.on("error", reject);
    r.end(data);
  });

afterAll(() => {
  for (const p of procs) p.kill();
  daemon.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it("records what it creates; `down` through a new proxy may act on it, never on another project's container", async () => {
  const up = await proxy("up");
  expect((await call(up, "POST", "/v1.47/containers/create?name=kitchen-app-001", { Image: "postgres" })).status).toBe(201);
  expect((await call(up, "POST", "/v1.47/containers/kitchen-app-001/exec", { Cmd: ["psql"] })).status).toBe(200);
  const theirs = await call(up, "POST", "/v1.47/containers/supabase_db_offstage/exec", { Cmd: ["psql"] });
  expect(theirs.status).toBe(403);
  expect(JSON.parse(theirs.text).message).toMatch(/not created through Kitchen's guard/);
  expect(seen.some((s) => s.includes("supabase_db_offstage/exec"))).toBe(false);
  expect(fs.readFileSync(owned, "utf8")).toContain(MINE);

  const down = await proxy("down"); // another bin/dev call, another proxy
  expect((await call(down, "DELETE", `/v1.47/containers/${MINE.slice(0, 12)}?force=1`)).status).toBe(200);
  expect((await call(down, "POST", "/v1.47/containers/kitchen-app-001/kill")).status).toBe(200);
  expect((await call(down, "POST", `/v1.47/containers/${THEIRS.slice(0, 12)}/kill`)).status).toBe(403);
  expect((await call(down, "PUT", "/v1.47/containers/supabase_db_offstage/archive?path=/tmp", {})).status).toBe(403);
  expect((await call(down, "POST", "/v1.47/containers/no-such/stop")).status).toBe(403);
  expect((await call(down, "GET", "/v1.47/containers/json?all=1")).status).toBe(200);
});
