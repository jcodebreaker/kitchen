// Generic helpers for a Kitchen Toolkit's bin/dev (contract v1). Project-neutral:
// argv parsing, the one JSON line, per-id state, process and Docker helpers.
// Everything project-specific lives in ../app.mjs.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT = 1;
export const TOOLKIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const log = (...a) => console.error("[dev]", ...a);

/** Print the single JSON result line and exit. Nothing else ever goes to stdout. */
export function out(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(code ?? (obj.status === "fail" || obj.ok === false ? 1 : 0));
}

/**
 * `--k=v`, `--k v` or a bare `--flag` (true). A flag given twice is refused, so
 * nothing appended after the engine's own flags (--id, --src, --out, --ports)
 * can override them.
 */
export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    let k;
    let v;
    if (eq > 2) {
      k = a.slice(2, eq);
      v = a.slice(eq + 1);
    } else {
      k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) v = true;
      else {
        v = next;
        i++;
      }
    }
    if (!/^[a-z][a-z0-9_-]*$/.test(k)) throw new Error(`bad flag ${JSON.stringify(a)}`);
    if (Object.hasOwn(flags, k)) throw new Error(`flag --${k} given twice`);
    flags[k] = v;
  }
  return { flags, pos };
}

/**
 * The env for anything that runs app code (the app, its CLI, a browser driver):
 * what the engine gave bin/dev minus the control-plane variables it names in
 * KITCHEN_CONTROL_ENV (Docker). The engine already scrubbed the rest and added
 * the `.env.kitchen` values (fake only).
 */
export function appEnv(extra = {}) {
  const control = new Set([
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    ...String(process.env.KITCHEN_CONTROL_ENV || "")
      .split(",")
      .filter(Boolean),
  ]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!control.has(k)) env[k] = v;
  return { ...env, ...extra };
}

export function checkId(id) {
  if (!id || typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error(`--id must match [a-z0-9][a-z0-9-]* (got ${JSON.stringify(id)})`);
  return id;
}

/** State lives outside the source tree, so `down --id` works without --src. */
export const stateRoot = (name) => process.env.KITCHEN_TOOLKIT_STATE || path.join(os.tmpdir(), `kitchen-toolkit-${name}`);

export function readEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Run a command, capture output. The child's stderr goes to ours unless quiet. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.stderr && !opts.quiet) process.stderr.write(r.stderr);
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
}

export function must(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.code}: ${r.stderr.trim().slice(-400)}`);
  return r.stdout;
}

/** Start a long-lived process in its own process group, output to a log file. Returns its pid. */
export function spawnDetached(cmd, args, { cwd, env, logFile }) {
  const fd = fs.openSync(logFile, "a");
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process group we started (never by name). */
export async function killGroup(pid) {
  if (!alive(pid)) return false;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(100);
  if (alive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  return true;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs, everyMs = 200, what }) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

export async function httpJson(url, body, timeoutMs = 60000, method) {
  const r = await fetch(url, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: r.status, body: parsed };
}

/** True when a TCP port on 127.0.0.1 accepts connections. */
export function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

export const imageExists = (tag) => run("docker", ["image", "inspect", tag], { quiet: true }).code === 0;

/**
 * Node dependencies of a folder (the app or the Toolkit itself), with npm's shared
 * cache: `npm ci` when a lock file is committed, else `npm install` (which writes one;
 * commit it later so installs are reproducible).
 */
export function installNodeDeps(dir) {
  if (!fs.existsSync(path.join(dir, "package.json"))) return "no package.json";
  const lock = fs.existsSync(path.join(dir, "package-lock.json"));
  must("npm", [lock ? "ci" : "install", "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir });
  return lock ? "npm ci" : "npm install";
}

/** A path under the app that may not leave it: `//evil`, `http://other`, `@host` tricks are refused. */
export function sameOrigin(base, p) {
  const b = new URL(base);
  const u = new URL(String(p ?? "/"), b);
  if (u.origin !== b.origin) throw new Error(`${JSON.stringify(p)} leaves the app (${u.origin}): refused`);
  return u.href;
}
