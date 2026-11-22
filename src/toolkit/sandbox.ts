// The OS sandbox for agent-written bin/dev that no human has merged yet (ADR 0008):
// the setup bridge's runs (`kitchen setup-mcp`), and every run of a Toolkit sha
// that is not an ancestor of the base (init's own check and its fix rounds,
// `toolkit check --rev kitchen/setup`, `toolkit up --rev …`: checkout.ts). On
// macOS each such run goes through `sandbox-exec` with a profile that denies
// reading or writing the developer's credentials and Kitchen's own secrets, and
// allows everything else bin/dev needs (the repo, temp, the Docker CLI config,
// the network). Docker goes through the guard: the profile denies the real
// daemon socket, and the wrapper starts `docker-proxy.ts` outside the sandbox,
// which forwards the Engine API and refuses bind mounts outside the repo, its
// worktrees and temp (and privileged / host-namespace containers). Linux: not
// handled yet (no profile; logged).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, kitchenHome } from "../home.ts";
import { guardRoots, repoOfBin } from "./docker-guard.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Under $HOME: the developer's credentials and the agent tools' auth. */
const DENIED_IN_HOME = [
  ".ssh",
  ".aws",
  ".config/gh",
  ".config/gcloud",
  ".azure",
  ".kube",
  ".gnupg",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".claude",
  ".claude.json",
  ".config/claude",
  ".codex",
  ".config/codex",
  ".anthropic",
  ".openai",
  "Library/Keychains",
  "Library/Application Support/Claude",
  // the Docker VMs' ssh keys: a shell in the VM is the daemon, unguarded
  ".colima",
  ".lima",
  ".orbstack",
];

/** Pure: the denied paths, given home and KITCHEN_HOME (both as given and resolved: the profile matches real paths). */
export function deniedPaths(home: string, kHome: string, extra: string[] = []): string[] {
  const out = new Set<string>();
  for (const p of [...DENIED_IN_HOME.map((d) => path.join(home, d)), kHome, ...extra]) {
    out.add(p);
    try {
      out.add(fs.realpathSync(p));
    } catch {}
  }
  return [...out];
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Pure: the SBPL profile. Allow by default, then deny every read and write
 * under each denied path; `$KITCHEN_HOME/scrub` (the empty git and gh config
 * the untrusted env points at) is allowed back for reading. Connecting to a
 * real Docker daemon socket is denied (`dockerSockets`: each a socket, or a
 * folder ending in `/` whose every socket is denied): Docker goes through the
 * guard's proxy. In SBPL the last matching rule wins.
 */
export function profileText(denied: string[], allowRead: string[], dockerSockets: string[] = []): string {
  const sub = (p: string) => `(subpath ${q(p)})`;
  const sock = (p: string) => `(remote unix-socket ${p.endsWith("/") ? `(subpath ${q(p.slice(0, -1))})` : `(path-literal ${q(p)})`})`;
  return [
    "(version 1)",
    ";; Kitchen setup bridge: bin/dev written by the setup agent (ADR 0008).",
    "(allow default)",
    `(deny file-read* file-write* ${denied.map(sub).join(" ")})`,
    ...(allowRead.length ? [`(allow file-read* ${allowRead.map(sub).join(" ")})`] : []),
    ...(dockerSockets.length
      ? [
          ";; Docker goes through Kitchen's guard (docker-proxy.ts), never the daemon's own socket.",
          `(deny network-outbound ${dockerSockets.map(sock).join(" ")})`,
        ]
      : []),
    "",
  ].join("\n");
}

/** The daemon socket the engine's docker CLI talks to (`DOCKER_HOST`, else the current context), or null: none, or not a unix socket (TCP is not guarded, ADR 0008). */
let endpoint: { socket: string | null } | undefined;
export function dockerSocket(): string | null {
  if (endpoint) return endpoint.socket;
  let host = process.env.DOCKER_HOST ?? "";
  if (!host)
    try {
      host = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 })
        .toString()
        .trim();
    } catch {
      host = fs.existsSync("/var/run/docker.sock") ? "unix:///var/run/docker.sock" : "";
    }
  endpoint = { socket: host.startsWith("unix://") ? host.slice("unix://".length) : null };
  return endpoint.socket;
}

/** The daemon sockets the profile denies: the resolved one and the well-known ones (each also resolved), plus the Docker VMs' folders. */
export function dockerSockets(home: string, resolved: string | null): string[] {
  const out = new Set<string>();
  for (const p of [resolved, "/var/run/docker.sock", path.join(home, ".docker", "run", "docker.sock"), path.join(home, ".rd", "docker.sock")]) {
    if (!p) continue;
    out.add(p);
    try {
      out.add(fs.realpathSync(p));
    } catch {}
  }
  for (const d of [".colima", ".lima", ".orbstack", "Library/Containers/com.docker.docker"]) out.add(`${path.join(home, d)}/`);
  return [...out];
}

const onPath = (name: string): string | null => {
  for (const d of (process.env.PATH ?? "").split(path.delimiter))
    if (d) {
      const p = path.join(d, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
  return null;
};

/** The guard's proxy script, next to this module (`.ts` from source, `.js` once built). */
const SELF = fileURLToPath(import.meta.url);
const PROXY = path.join(path.dirname(SELF), `docker-proxy${path.extname(SELF)}`);

export type DockerGuard = { node: string; proxy: string; upstream: string; docker: string | null; roots: string[] };

/**
 * Pure: the wrapper script. Outside the sandbox it starts the Docker guard's
 * proxy on a fresh socket in a short temp folder, waits for it, then runs
 * bin/dev under sandbox-exec with DOCKER_HOST on the proxy and the `docker`
 * shim first on PATH; the proxy is killed on exit, signals are passed on to
 * bin/dev, and its exit code is the wrapper's. Without a unix daemon socket
 * (`guard` null) it only runs bin/dev under sandbox-exec. stdout is bin/dev's alone.
 */
export function wrapperText(real: string, profile: string, guard: DockerGuard | null): string {
  const head = ["#!/bin/sh", `# Kitchen setup bridge: ${real} under ${profile} (ADR 0008)`, `real=${sh(real)}`];
  if (!guard) return [...head, `exec ${SANDBOX_EXEC} -f ${sh(profile)} "$real" "$@"`, ""].join("\n");
  const serve = [
    sh(guard.node),
    sh(guard.proxy),
    "serve --dir",
    '"$d"',
    "--upstream",
    sh(guard.upstream),
    ...(guard.docker ? ["--docker", sh(guard.docker)] : []),
    ...guard.roots.flatMap((r) => ["--root", sh(r)]),
  ].join(" ");
  return [
    ...head,
    "# Docker goes through the guard (docker-proxy.ts); the profile denies the daemon's own socket.",
    'd=$(mktemp -d /tmp/kitchen-dg.XXXXXX) || { echo "kitchen: no temp folder for the Docker guard" >&2; exit 125; }',
    `${serve} </dev/null >/dev/null &`,
    "p=$!",
    "trap 'kill $p 2>/dev/null; rm -rf \"$d\"' EXIT",
    "i=0",
    'while [ ! -S "$d/docker.sock" ]; do',
    '  if [ $i -ge 200 ] || ! kill -0 $p 2>/dev/null; then echo "kitchen: the Docker guard did not start (ADR 0008)" >&2; exit 125; fi',
    "  i=$((i+1)); sleep 0.05",
    "done",
    'DOCKER_HOST="unix://$d/docker.sock"; PATH="$d/bin:$PATH"; export DOCKER_HOST PATH',
    "unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH",
    "# an async command's stdin is /dev/null in sh: hand bin/dev the real one through fd 3",
    "exec 3<&0",
    `${SANDBOX_EXEC} -f ${sh(profile)} "$real" "$@" <&3 3<&- &`,
    "c=$!",
    "exec 3<&-",
    'for s in HUP INT TERM; do trap "kill -$s \\$c 2>/dev/null" $s; done',
    "while :; do wait $c; rc=$?; kill -0 $c 2>/dev/null || break; done",
    "exit $rc",
    "",
  ].join("\n");
}

/**
 * A bin/dev that runs `bin` under the setup profile, with Docker through the
 * guard: a wrapper in $KITCHEN_HOME/sandbox/. Every caller (one command, the
 * check, its drives, a stale slot's reclaim) runs bin/dev by path, so wrapping
 * the path confines them all. Returns `bin` itself, with `sandboxed: false`,
 * where there is no sandbox-exec (Linux: unhandled, ADR 0008).
 */
export function sandboxedBin(bin: string, o: { home?: string; kHome?: string } = {}): { bin: string; sandboxed: boolean } {
  const profile = setupSandboxProfile(o);
  if (!profile) return { bin, sandboxed: false };
  let real = path.resolve(bin);
  try {
    real = fs.realpathSync(bin);
  } catch {}
  const upstream = dockerSocket();
  const guard = upstream ? { node: process.execPath, proxy: PROXY, upstream, docker: onPath("docker"), roots: guardRoots(repoOfBin(real)) } : null;
  const wrapper = path.join(path.dirname(profile), `dev-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`);
  fs.writeFileSync(wrapper, wrapperText(real, profile, guard), { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
  return { bin: wrapper, sandboxed: true };
}

/** The real bin/dev behind a wrapper `sandboxedBin` wrote, or null when `bin` is not one (checkout GC: a slot running a wrapper uses its checkout). */
export function wrappedBin(bin: string): string | null {
  if (!/^dev-[0-9a-f]{12}$/.test(path.basename(bin)) || path.basename(path.dirname(bin)) !== "sandbox") return null;
  try {
    const text = fs.readFileSync(bin, "utf8");
    // `real='…'`, or an older wrapper's one line `exec sandbox-exec -f '<profile>' '<bin/dev>' "$@"`
    const m = /^real='((?:[^']|'\\'')*)'$/m.exec(text) ?? /^exec \S+ -f '(?:[^']|'\\'')*' '((?:[^']|'\\'')*)' "\$@"$/m.exec(text);
    return m ? m[1].replace(/'\\''/g, "'") : null;
  } catch {
    return null;
  }
}

const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The profile file for this machine, written into $KITCHEN_HOME/sandbox/, or
 * null where there is no sandbox-exec (Linux: unhandled, see ADR 0008).
 */
export function setupSandboxProfile(o: { home?: string; kHome?: string } = {}): string | null {
  if (process.platform !== "darwin" || !fs.existsSync(SANDBOX_EXEC)) return null;
  const kHome = ensureHome(o.kHome ?? kitchenHome());
  const home = o.home ?? os.homedir();
  const scrub = path.join(kHome, "scrub");
  fs.mkdirSync(scrub, { recursive: true, mode: 0o700 });
  const allow = [scrub];
  try {
    allow.push(fs.realpathSync(scrub));
  } catch {}
  const file = path.join(kHome, "sandbox", "setup-bridge.sb");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, profileText(deniedPaths(home, kHome), allow, dockerSockets(home, dockerSocket())), { mode: 0o600 });
  return file;
}
