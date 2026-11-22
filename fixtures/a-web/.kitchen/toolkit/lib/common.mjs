// Shared bits for bin/dev: argv parsing, state per id, process + docker helpers.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLKIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SRC = path.resolve(TOOLKIT_DIR, "..", "..");
export const PG_IMAGE = "postgres:16-alpine";
export const CONTAINER_PREFIX = "kitchen-a-web-";

// State lives outside the source tree so `down --id` works with no --src.
export const STATE_ROOT = process.env.KITCHEN_TOOLKIT_STATE || path.join(os.tmpdir(), "kitchen-toolkit-a-web");

export const log = (...a) => console.error("[dev]", ...a);

/** Print the single JSON result line and exit. */
export function out(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(code ?? (obj.status === "fail" || obj.ok === false ? 1 : 0));
}

/**
 * `--k=v`, `--k v` or a bare `--flag` (true). A flag given twice is refused, so
 * nothing appended after the engine's own flags (--id, --src, --out) can
 * override them.
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
 * The env for processes that run app code (the server) or drive it (the browser
 * driver): what the engine gave bin/dev, minus the control-plane variables the
 * engine names in KITCHEN_CONTROL_ENV (Docker). The engine already scrubbed the
 * rest (no tokens, no credentials, .env.kitchen values added).
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
  if (!id || typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) {
    throw new Error(`--id must match [a-z0-9][a-z0-9-]* (got ${JSON.stringify(id)})`);
  }
  return id;
}

export const stateDir = (id) => path.join(STATE_ROOT, id);
export const statePath = (id) => path.join(stateDir(id), "state.json");
export function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(statePath(id), "utf8"));
  } catch {
    return null;
  }
}
export function writeState(id, s) {
  fs.mkdirSync(stateDir(id), { recursive: true });
  fs.writeFileSync(statePath(id), JSON.stringify(s, null, 2));
}

export function readEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Run a command, capture output; stderr of the child is forwarded to our stderr. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.stderr && !opts.quiet) process.stderr.write(r.stderr);
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

export function must(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.code}: ${r.stderr.trim().slice(-400)}`);
  return r.stdout;
}

/** Start a long-lived process in its own process group, output to a log file. */
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

export async function waitFor(fn, { timeoutMs, everyMs = 100, what }) {
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

export async function httpJson(url, body, timeoutMs = 60000) {
  const r = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export const containerName = (id) => `${CONTAINER_PREFIX}${id}`;

export function psql(container, env, sql, db = "postgres") {
  return run("docker", ["exec", "-i", container, "psql", "-U", env.POSTGRES_USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-tAc", sql], {
    quiet: true,
  });
}
