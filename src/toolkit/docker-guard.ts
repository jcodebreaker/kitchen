// The Docker bind-mount guard for unmerged Toolkit code (ADR 0008): the rules
// that decide whether a container an unmerged bin/dev asks Docker for may be
// created. The daemon runs outside sandbox-exec, so without this a sandboxed
// bin/dev could `docker run -v $HOME:/h …` and read what the profile denies.
// Two entry points: the `docker` CLI's argv (the shim: an early, friendly
// refusal) and the Engine API request (the proxy: the boundary). A bind source
// must resolve inside the allowed roots: the repo (its `.worktrees/` included)
// and temp. Privileged containers, the host's pid/ipc/user/network namespaces,
// dangerous capabilities and `--volumes-from` are refused; named volumes are
// fine unless they are local bind volumes pointing outside the roots.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REFUSED = "is refused for an unmerged Toolkit";
/** How a refusal is shown (the docker CLI prints the proxy's as `Error response from daemon: …`). */
export const refusalMessage = (reason: string) => `Kitchen (ADR 0008): ${reason}`;

/** The roots a bind source may resolve into: the repo (its worktrees live in `<repo>/.worktrees/`) and temp, each as given and resolved. */
export function guardRoots(repo: string): string[] {
  const out = new Set<string>();
  for (const p of [repo, os.tmpdir(), "/tmp", "/private/tmp", "/var/folders"]) {
    out.add(path.resolve(p));
    try {
      out.add(fs.realpathSync(p));
    } catch {}
  }
  return [...out];
}

/** The repo a bin/dev belongs to: `<root>/.kitchen/toolkit/bin/dev`, where a checkout's root is `<repo>/.worktrees/<name>`. */
export function repoOfBin(bin: string): string {
  const root = path.resolve(bin, "..", "..", "..", "..");
  return path.basename(path.dirname(root)) === ".worktrees" ? path.dirname(path.dirname(root)) : root;
}

/**
 * Where a path really leads: `..` folded, then the deepest existing ancestor
 * resolved through its symlinks (a source that does not exist yet is created by
 * the daemon under that ancestor).
 */
export function resolveReal(p: string): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...rest);
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.join(head, ...rest);
      rest.unshift(path.basename(head));
      head = up;
    }
  }
}

export const insideRoots = (p: string, roots: string[]) => {
  const real = resolveReal(p);
  return roots.some((r) => real === r || real.startsWith(r.endsWith("/") ? r : `${r}/`));
};

const bindRefusal = (source: string, roots: string[]): string | null =>
  insideRoots(source, roots) ? null : `bind mount of ${source} outside the repo, its worktrees and temp ${REFUSED}`;

/** Capabilities that reach past the container (mounts, raw devices, kernel modules, file handles of the host's view). */
const DANGEROUS_CAPS = new Set(["ALL", "SYS_ADMIN", "SYS_MODULE", "SYS_RAWIO", "SYS_PTRACE", "DAC_READ_SEARCH", "SYS_BOOT"]);
const capName = (c: string) => c.toUpperCase().replace(/^CAP_/, "");

/** A local volume whose driver options make it a bind of a host path (`type=none,o=bind,device=…`): the device must be inside the roots. */
function volumeOptsRefusal(opts: Record<string, unknown>, roots: string[]): string | null {
  const o = Object.fromEntries(Object.entries(opts).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const bindish = /(^|,)\s*r?bind\s*(,|$)/.test(o.o ?? "") || o.type === "none" || o.type === "bind";
  if (!bindish || o.device === undefined) return null;
  return insideRoots(o.device, roots) ? null : `a volume binding ${o.device} outside the repo, its worktrees and temp ${REFUSED}`;
}

// ---------- the Engine API (the proxy) ----------

/**
 * Go's encoding/json matches field names case-insensitively, so `binds` sets
 * Binds: every key that matches, in any case, is checked.
 */
function fields(obj: unknown, key: string): unknown[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const k = key.toLowerCase();
  return Object.entries(obj as Record<string, unknown>)
    .filter(([n]) => n.toLowerCase() === k)
    .map(([, v]) => v);
}
const truthy = (v: unknown) => v === true || v === "true" || v === 1;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** The refusal for one HostConfig (or the deprecated top-level host config fields), or null. */
function hostConfigRefusal(hc: unknown, roots: string[]): string | null {
  for (const binds of fields(hc, "Binds"))
    for (const b of strings(binds)) {
      const src = b.split(":")[0];
      if (src.startsWith("/")) {
        const r = bindRefusal(src, roots);
        if (r) return r;
      }
    }
  for (const mounts of fields(hc, "Mounts")) {
    if (!Array.isArray(mounts)) continue;
    for (const m of mounts) {
      const type = String(fields(m, "Type")[0] ?? "").toLowerCase();
      if (type === "volume") {
        for (const vo of fields(m, "VolumeOptions"))
          for (const dc of fields(vo, "DriverConfig"))
            for (const opts of fields(dc, "Options")) {
              const r = opts && typeof opts === "object" ? volumeOptsRefusal(opts as Record<string, unknown>, roots) : null;
              if (r) return r;
            }
        continue;
      }
      if (type === "tmpfs" || type === "npipe" || type === "cluster" || type === "image") continue;
      for (const s of fields(m, "Source")) {
        const r = typeof s === "string" && s ? bindRefusal(s, roots) : null;
        if (r) return r;
      }
    }
  }
  if (fields(hc, "Privileged").some(truthy)) return `a privileged container ${REFUSED}`;
  for (const [key, what] of [
    ["PidMode", "the host's pid namespace"],
    ["NetworkMode", "the host's network"],
    ["IpcMode", "the host's ipc namespace"],
    ["UsernsMode", "the host's user namespace"],
  ] as const)
    if (fields(hc, key).some((v) => typeof v === "string" && v.toLowerCase() === "host")) return `${what} (${key}=host) ${REFUSED}`;
  for (const caps of fields(hc, "CapAdd")) for (const c of strings(caps)) if (DANGEROUS_CAPS.has(capName(c))) return `the capability ${c} ${REFUSED}`;
  for (const vf of fields(hc, "VolumesFrom")) if (strings(vf).length) return `--volumes-from (another container's mounts) ${REFUSED}`;
  return null;
}

/** The request path, decoded and checked: null when it is not in canonical form (a daemon-side clean-up could route it elsewhere). */
export function apiPath(url: string): string | null {
  const raw = url.split("?")[0];
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return p.startsWith("/") && path.posix.normalize(p) === p && !p.includes("\\") ? p : null;
}

const V = "(?:/v[0-9.]+)?";
const CREATE = new RegExp(`^${V}/containers/create$`);
const EXEC = new RegExp(`^${V}/containers/[^/]+/exec$`);
const VOLUME = new RegExp(`^${V}/volumes/create$`);
const SWARM = new RegExp(`^${V}/(?:services|swarm|plugins)(?:/|$)`);
const UPGRADABLE = new RegExp(`^${V}/(?:exec/[^/]+/start|containers/[^/]+/attach|session|grpc)$`);

/** Whether the proxy must read and check this request's JSON body before forwarding it. */
export const bodyChecked = (method: string, p: string) => method === "POST" && (CREATE.test(p) || EXEC.test(p) || VOLUME.test(p));

/** Requests that switch the connection to a raw stream (exec/attach streams, BuildKit sessions); every other upgrade is refused. */
export const upgradeAllowed = (p: string | null) => p !== null && UPGRADABLE.test(p);

/**
 * The refusal for one Engine API request, or null when it may go to the
 * daemon. `body` is the parsed JSON body when `bodyChecked` (undefined when it
 * did not parse: refused).
 */
export function apiRefusal(method: string, url: string, body: unknown, roots: string[]): string | null {
  const p = apiPath(url);
  if (p === null) return `the request path ${JSON.stringify(url.split("?")[0])} is not canonical and ${REFUSED}`;
  if (method !== "GET" && method !== "HEAD" && SWARM.test(p)) return `swarm services and plugins ${REFUSED}`;
  if (!bodyChecked(method, p)) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return `a request body that is not a JSON object ${REFUSED}`;
  if (EXEC.test(p)) return fields(body, "Privileged").some(truthy) ? `a privileged exec ${REFUSED}` : null;
  if (VOLUME.test(p)) {
    for (const opts of fields(body, "DriverOpts")) {
      const r = opts && typeof opts === "object" ? volumeOptsRefusal(opts as Record<string, unknown>, roots) : null;
      if (r) return r;
    }
    return null;
  }
  // containers/create: HostConfig, and the deprecated top-level host config fields old API versions still merge in.
  for (const hc of [...fields(body, "HostConfig"), body]) {
    const r = hostConfigRefusal(hc, roots);
    if (r) return r;
  }
  return null;
}

// ---------- the docker CLI (the shim) ----------

/** `docker run`/`create` flags that take no value (everything else that starts with `-` takes one). */
const BOOL_LONG = new Set([
  "detach",
  "interactive",
  "tty",
  "rm",
  "privileged",
  "init",
  "publish-all",
  "read-only",
  "no-healthcheck",
  "oom-kill-disable",
  "sig-proxy",
  "disable-content-trust",
  "quiet",
  "help",
  "use-api-socket",
]);
const BOOL_SHORT = new Set(["d", "i", "t", "P", "q"]);
const SHORT_LONG: Record<string, string> = {
  v: "volume",
  e: "env",
  p: "publish",
  w: "workdir",
  u: "user",
  h: "hostname",
  l: "label",
  m: "memory",
  a: "attach",
  c: "cpu-shares",
};
/** Global docker flags that take a value (before the subcommand). */
const GLOBAL_VALUE = new Set(["--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]);

/** Expand `~` and resolve a CLI path against cwd, as the docker CLI (and the shell before it) would. */
const cliPath = (p: string, cwd: string, home: string) => path.resolve(cwd, p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
const looksLikePath = (s: string) => s.startsWith("/") || s.startsWith(".") || s.startsWith("~");

function flagRefusal(name: string, value: string | true, o: { roots: string[]; cwd: string; home: string }): string | null {
  const v = value === true ? "true" : value;
  switch (name) {
    case "volume": {
      const parts = v.split(":");
      if (parts.length < 2 || !looksLikePath(parts[0])) return null; // an anonymous or named volume
      return bindRefusal(cliPath(parts[0], o.cwd, o.home), o.roots);
    }
    case "mount": {
      const kv = Object.fromEntries(
        v.split(",").map((f) => {
          const i = f.indexOf("=");
          return i < 0 ? [f.trim().toLowerCase(), "true"] : [f.slice(0, i).trim().toLowerCase(), f.slice(i + 1).trim()];
        }),
      );
      const type = (kv.type ?? "volume").toLowerCase();
      if (type === "bind") {
        const src = kv.source ?? kv.src;
        return src ? bindRefusal(cliPath(src, o.cwd, o.home), o.roots) : null;
      }
      if (type === "volume") {
        const opts: Record<string, string> = {};
        for (const f of v.split(",")) {
          const m = /^\s*volume-opt=([^=]+)=(.*)$/.exec(f);
          if (m) opts[m[1]] = m[2];
        }
        return volumeOptsRefusal(opts, o.roots);
      }
      return null;
    }
    case "privileged":
      return v === "false" ? null : `--privileged ${REFUSED}`;
    case "pid":
    case "network":
    case "net":
    case "ipc":
    case "userns":
      return v.toLowerCase() === "host" ? `--${name}=host ${REFUSED}` : null;
    case "cap-add":
      return v.split(",").some((c) => DANGEROUS_CAPS.has(capName(c.trim()))) ? `--cap-add=${v} ${REFUSED}` : null;
    case "volumes-from":
      return `--volumes-from (another container's mounts) ${REFUSED}`;
    case "use-api-socket":
      return v === "false" ? null : `--use-api-socket (the Docker socket in the container) ${REFUSED}`;
    default:
      return null;
  }
}

/**
 * The refusal for one `docker` command line (argv after `docker`), or null.
 * Only `run`/`create` (and `container run|create`) are checked; global `-H`
 * and `--context` are refused, since they would route around the guard.
 */
export function argvRefusal(argv: string[], o: { roots: string[]; cwd: string; home: string }): string | null {
  let i = 0;
  for (; i < argv.length && argv[i].startsWith("-"); i++) {
    const a = argv[i];
    if (/^(-H|--host|-c|--context)(=|$)/.test(a) || /^-H./.test(a))
      return `${a.split("=")[0]}: Docker goes through Kitchen's guard, another endpoint or context ${REFUSED}`;
    if (GLOBAL_VALUE.has(a)) i++;
  }
  let sub = argv[i];
  if (sub === "container") sub = argv[++i];
  if (sub !== "run" && sub !== "create") return null;
  for (i++; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || !a.startsWith("-") || a === "-") return null; // the image: the rest is the container's command
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      let value: string | true = eq < 0 ? true : a.slice(eq + 1);
      if (value === true && !BOOL_LONG.has(name)) value = argv[++i] ?? "";
      const r = flagRefusal(name, value, o);
      if (r) return r;
      continue;
    }
    // shorthand: `-it`, `-v/a:/b`, `-itv /a:/b` (pflag: a value flag takes the rest of the word, or the next arg)
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (BOOL_SHORT.has(c)) continue;
      const value = j + 1 < a.length ? a.slice(j + 1) : (argv[++i] ?? "");
      const r = flagRefusal(SHORT_LONG[c] ?? c, value.startsWith("=") ? value.slice(1) : value, o);
      if (r) return r;
      break;
    }
  }
  return null;
}
