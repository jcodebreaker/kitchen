// The Docker guard's two processes (ADR 0008), run with plain `node`:
//
//   docker-proxy.ts serve --dir <d> --upstream <socket> [--docker <cli>] --root <r>…
//     Outside the sandbox: listens on <d>/docker.sock, forwards every Engine
//     API request to the real daemon socket and refuses (403, JSON message the
//     docker CLI prints) a container, exec or volume that `apiRefusal` refuses.
//     Every request on a keep-alive connection goes through node's HTTP parser
//     and is checked; exec/attach/BuildKit upgrades become a raw stream only
//     after their request line was checked. Writes the `docker` shim to
//     <d>/bin/docker. Exits when its parent (the sandbox wrapper) is gone.
//   docker-proxy.ts shim-check --root <r>… -- <docker argv>
//     Inside the sandbox, from the shim: exit 125 with the refusal on stderr, or 0.
//
// Never writes to stdout: bin/dev's stdout is its one JSON line.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiPath, apiRefusal, argvRefusal, bodyChecked, refusalMessage, upgradeAllowed } from "./docker-guard.ts";

const MAX_BODY = 8 * 1024 * 1024;
const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const log = (line: string) => process.stderr.write(`[kitchen docker guard] ${line}\n`);

function opts(argv: string[]) {
  const roots: string[] = [];
  const o: Record<string, string> = {};
  let i = 0;
  for (; i < argv.length && argv[i] !== "--"; i += 2) {
    if (argv[i] === "--root") roots.push(argv[i + 1]);
    else o[argv[i].replace(/^--/, "")] = argv[i + 1];
  }
  return { roots, o, rest: argv.slice(i + 1) };
}

function refuse(res: http.ServerResponse, reason: string) {
  const body = JSON.stringify({ message: refusalMessage(reason) });
  res.writeHead(403, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function serve(dir: string, upstream: string, roots: string[], docker: string | undefined) {
  const sock = path.join(dir, "docker.sock");
  const agent = new http.Agent({ keepAlive: true });

  const forward = (req: http.IncomingMessage, res: http.ServerResponse, body?: Buffer) => {
    const headers = { ...req.headers };
    if (body) {
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.length);
    }
    const up = http.request({ socketPath: upstream, method: req.method, path: req.url, headers, agent }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      res.flushHeaders(); // a long poll (`wait`) answers its headers at once: the CLI waits for them before it starts the container
      ur.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) {
        const msg = JSON.stringify({ message: `Kitchen docker guard: the Docker daemon at ${upstream}: ${e.message}` });
        res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(msg) });
        res.end(msg);
      } else res.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    if (body) up.end(body);
    else req.pipe(up);
  };

  const server = http.createServer({ requestTimeout: 0, headersTimeout: 0 }, (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const p = apiPath(url);
    if (p === null || !bodyChecked(method, p)) {
      const reason = apiRefusal(method, url, undefined, roots);
      if (reason) {
        log(`refused ${method} ${url}: ${reason}`);
        req.resume();
        return refuse(res, reason);
      }
      return forward(req, res);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed: unknown;
      try {
        parsed = size > MAX_BODY ? undefined : JSON.parse(body.toString("utf8") || "null");
      } catch {
        parsed = undefined;
      }
      const reason = apiRefusal(method, url, parsed, roots);
      if (reason) {
        log(`refused ${method} ${url}: ${reason}`);
        return refuse(res, reason);
      }
      forward(req, res, body);
    });
  });

  server.on("upgrade", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const url = req.url ?? "/";
    const p = apiPath(url);
    const reason = !upgradeAllowed(p)
      ? `a connection upgrade on ${url.split("?")[0]} is refused for an unmerged Toolkit`
      : apiRefusal(req.method ?? "GET", url, {}, roots);
    if (reason) {
      log(`refused ${req.method} ${url}: ${reason}`);
      const body = JSON.stringify({ message: refusalMessage(reason) });
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const up = net.connect(upstream);
    const drop = () => {
      client.destroy();
      up.destroy();
    };
    up.on("error", drop);
    client.on("error", drop);
    up.on("connect", () => {
      let h = `${req.method} ${url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(`${h}\r\n`);
      // node parses an upgrade request's body (exec start's `{"Detach":false,…}`) into `req`, not `head`
      req.on("data", (d: Buffer) => up.write(d));
      req.resume();
      if (head.length) up.write(head);
      client.pipe(up);
      up.pipe(client);
    });
  });

  if (docker) {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const self = fileURLToPath(import.meta.url);
    const check = [process.execPath, self, "shim-check", ...roots.flatMap((r) => ["--root", r]), "--"].map(sh).join(" ");
    fs.writeFileSync(
      path.join(bin, "docker"),
      [
        "#!/bin/sh",
        "# Kitchen (ADR 0008): the docker CLI, with an early check of run/create (the proxy behind DOCKER_HOST is the boundary).",
        'for a in "$@"; do',
        "  case $a in",
        `    run|create|-H*|--host|--host=*|--context|--context=*|-c) ${check} "$@" </dev/null || exit $?; break ;;`,
        "  esac",
        "done",
        `exec ${sh(docker)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  const parent = process.ppid;
  const bye = () => {
    try {
      fs.rmSync(sock, { force: true });
    } catch {}
    process.exit(0);
  };
  setInterval(() => {
    if (process.ppid !== parent) bye();
  }, 300);
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, bye);
  server.on("error", (e) => {
    log(`cannot listen on ${sock}: ${e.message}`);
    process.exit(1);
  });
  const old = process.umask(0o077);
  server.listen(sock, () => process.umask(old));
}

const [mode, ...argv] = process.argv.slice(2);
if (mode === "serve") {
  const { roots, o } = opts(argv);
  if (!o.dir || !o.upstream || !roots.length) {
    log("usage: serve --dir <d> --upstream <socket> [--docker <cli>] --root <r>…");
    process.exit(2);
  }
  serve(o.dir, o.upstream, roots, o.docker);
} else if (mode === "shim-check") {
  const { roots, rest } = opts(argv);
  const reason = argvRefusal(rest, { roots, cwd: process.cwd(), home: os.homedir() });
  if (reason) {
    process.stderr.write(`docker: ${refusalMessage(reason)}\n`);
    process.exit(125);
  }
} else {
  log(`unknown mode ${mode ?? ""}`);
  process.exit(2);
}
