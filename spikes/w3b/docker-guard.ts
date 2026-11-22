// M5 (ADR 0008): the Docker daemon runs outside sandbox-exec, so an unmerged
// bin/dev could `docker run -v $HOME:/h …`. Through the sandbox wrapper, Docker
// goes through Kitchen's guard: a `docker` shim (early, friendly refusal), a
// proxy on DOCKER_HOST that checks every Engine API request (the boundary), and
// a profile that denies the daemon's own socket. A tiny fake bin/dev runs the
// shell command it is given, sandboxed; the control runs it unsandboxed.
//   node spikes/w3b/docker-guard.ts [scratch]   (macOS + Docker; postgres:16-alpine local; ~30 s)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dockerSocket, sandboxedBin } from "../../src/toolkit/sandbox.ts";
import { check, finish } from "../w3a/lib.ts";

const IMAGE = "postgres:16-alpine";
const NAME = "kitchen-guard-spike";
const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".work"), "docker-guard");
if (process.platform !== "darwin") {
  console.log("not macOS: unmerged bin/dev runs unsandboxed and unguarded here (ADR 0008, Linux unhandled)");
  process.exit(0);
}
fs.rmSync(root, { recursive: true, force: true });
const repo = path.join(root, "repo");
const kHome = path.join(root, "kitchen-home");
fs.mkdirSync(path.join(repo, ".kitchen", "toolkit", "bin"), { recursive: true });
fs.mkdirSync(path.join(repo, ".worktrees", "job-1"), { recursive: true });
fs.mkdirSync(kHome, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(repo, "in-repo.txt"), "hello from the repo\n");
fs.writeFileSync(path.join(repo, ".worktrees", "job-1", "in-worktree.txt"), "hello from a worktree\n");
const dev = path.join(repo, ".kitchen", "toolkit", "bin", "dev");
fs.writeFileSync(dev, '#!/bin/sh\n# the fake bin/dev: runs the command it is given\nexec /bin/sh -c "$1"\n', { mode: 0o755 });

const realDocker = execFileSync("/bin/sh", ["-c", "command -v docker"]).toString().trim();
const realSock = dockerSocket();
if (!realSock) {
  console.log("no unix Docker socket on this machine: nothing to guard");
  process.exit(1);
}
const containers = () =>
  execFileSync("docker", ["ps", "-a", "--filter", `name=${NAME}`, "--format", "{{.Names}}"])
    .toString()
    .split("\n")
    .filter(Boolean);
const cleanup = () => {
  for (const c of containers()) spawnSync("docker", ["rm", "-f", c], { stdio: "ignore" });
  spawnSync("docker", ["compose", "-p", `${NAME}-h`, "down", "--remove-orphans"], { cwd: repo, stdio: "ignore" });
};
cleanup();
// this spike's guard folders (other Kitchen runs may have theirs at the same time): their shim names our repo
const guardDirs = () =>
  fs.readdirSync("/tmp").filter((f) => {
    try {
      return f.startsWith("kitchen-dg.") && fs.readFileSync(path.join("/tmp", f, "bin", "docker"), "utf8").includes(repo);
    } catch {
      return false;
    }
  });

const wrapper = sandboxedBin(dev, { kHome });
check(
  "the wrapper is sandboxed and starts the Docker guard",
  wrapper.sandboxed && /docker-proxy\.ts' serve/.test(fs.readFileSync(wrapper.bin, "utf8")),
  wrapper.bin,
);

type Out = { out: string; err: string; code: number };
const sandboxed = (cmd: string, input = ""): Out => {
  const p = spawnSync(wrapper.bin, [cmd], { cwd: repo, input, encoding: "utf8", timeout: 120_000 });
  return { out: p.stdout, err: p.stderr, code: p.status ?? -1 };
};
const merged = (cmd: string): Out => {
  const p = spawnSync(dev, [cmd], { cwd: repo, encoding: "utf8", timeout: 120_000 });
  return { out: p.stdout, err: p.stderr, code: p.status ?? -1 };
};
const show = (r: Out) =>
  `exit ${r.code}; ${(r.err.trim().split("\n").at(-1) ?? "").slice(0, 200)}${r.out.trim() ? ` | out ${r.out.trim().slice(0, 120)}` : ""}`;
const HOME = os.homedir();
const KITCHEN = /Kitchen \(ADR 0008\)/;

// (a) the shim refuses a bind of $HOME before anything reaches Docker
const a = sandboxed(`docker run --rm --name ${NAME}-a -v "$HOME:/h" ${IMAGE} true`);
check(
  "(a) docker run -v $HOME:/h is refused by the shim (exit 125, the reason on stderr)",
  a.code === 125 && KITCHEN.test(a.err) && /bind mount/.test(a.err),
  show(a),
);

// (b) the same request past the shim: the real CLI, and the raw API on DOCKER_HOST, are refused by the proxy
const b1 = sandboxed(`${realDocker} run --rm --name ${NAME}-b -v "$HOME:/h" ${IMAGE} true`);
check(
  "(b) the real docker CLI past the shim: the proxy refuses (Error response from daemon: Kitchen …)",
  b1.code !== 0 && /Error response from daemon: Kitchen \(ADR 0008\): bind mount/.test(b1.err),
  show(b1),
);
const body = JSON.stringify({ Image: IMAGE, Cmd: ["true"], HostConfig: { Binds: [`${HOME}:/h`] } });
const b2 = sandboxed(
  `curl -s -w ' %{http_code}' --unix-socket "\${DOCKER_HOST#unix://}" -H 'Content-Type: application/json' -d '${body}' 'http://x/v1.43/containers/create?name=${NAME}-b2'`,
);
check(
  "(b) a raw POST /containers/create with Binds [$HOME:/h] on DOCKER_HOST gets 403 from the proxy",
  /Kitchen \(ADR 0008\).* 403$/.test(b2.out.trim()),
  show(b2),
);
const b3 = sandboxed(
  `curl -s -w ' %{http_code}' --unix-socket "\${DOCKER_HOST#unix://}" -H 'Content-Type: application/json' -d '${body.replace("HostConfig", "hostconfig").replace("Binds", "binds")}' 'http://x/v1.43/containers/create?name=${NAME}-b3'`,
);
check("(b) the same with lower-case keys (Go's JSON matches any case) is refused too", / 403$/.test(b3.out.trim()), show(b3));
const vol = sandboxed(`${realDocker} volume create --opt type=none --opt o=bind --opt device="$HOME" ${NAME}-vol`);
check("(b) a local volume that binds $HOME (type=none,o=bind) is refused", vol.code !== 0 && KITCHEN.test(vol.err), show(vol));

// (c) the daemon's own socket is denied inside the sandbox; the control reaches it
const c1 = sandboxed(`curl -s -m 5 --unix-socket '${realSock}' http://x/_ping`);
const c0 = spawnSync("curl", ["-s", "-m", "5", "--unix-socket", realSock, "http://x/_ping"], { encoding: "utf8" });
check(
  `(c) curl --unix-socket ${realSock} /_ping is denied inside (OK outside)`,
  c1.code !== 0 && c1.out.trim() !== "OK" && c0.stdout.trim() === "OK",
  `inside ${show(c1)}; outside ${c0.stdout.trim()}`,
);
const c2 = sandboxed(`${realDocker} -H 'unix://${realSock}' ps -q`);
check("(c) the real CLI with -H on the daemon's socket fails inside", c2.code !== 0, show(c2));
const c3 = sandboxed(`docker --context default ps -q`);
check("(c) the shim refuses --context (it would route around the guard)", c3.code === 125 && KITCHEN.test(c3.err), show(c3));
const c4 = sandboxed(`ls "$HOME/.colima" 2>&1 >/dev/null; echo rc=$?`);
check("(c) the Docker VM's folder (~/.colima: ssh keys into the daemon's VM) is not readable inside", /rc=[1-9]/.test(c4.out), c4.out.trim());

// (d) privileged and the host's namespaces, by the shim and by the proxy
for (const flag of ["--privileged", "--pid=host", "--network=host"]) {
  const s = sandboxed(`docker run --rm --name ${NAME}-d ${flag} ${IMAGE} true`);
  const p = sandboxed(`${realDocker} run --rm --name ${NAME}-d ${flag} ${IMAGE} true`);
  check(
    `(d) ${flag} is refused by the shim and by the proxy`,
    s.code === 125 && KITCHEN.test(s.err) && p.code !== 0 && KITCHEN.test(p.err),
    `${show(s)} || ${show(p)}`,
  );
}
const dx = sandboxed(
  `docker run -d --name ${NAME}-dx ${IMAGE} sleep 30 >/dev/null && ${realDocker} exec --privileged ${NAME}-dx true; echo rc=$?; docker rm -f ${NAME}-dx >/dev/null`,
);
check(
  "(d) docker exec --privileged is refused by the proxy",
  /Kitchen \(ADR 0008\): a privileged exec/.test(dx.err) && /rc=[1-9]/.test(dx.out),
  `${dx.out.trim()} ${dx.err.trim().split("\n").at(-1)}`,
);

// (e) binds inside the repo, its worktrees and temp work; so do named volumes, ports and memory limits
const e1 = sandboxed(`docker run --rm --name ${NAME}-e -v "$PWD:/r:ro" -v "$PWD/.worktrees/job-1:/w:ro" ${IMAGE} cat /r/in-repo.txt /w/in-worktree.txt`);
check(
  "(e) a bind of the repo and of a worktree works (the container reads them)",
  e1.code === 0 && /from the repo/.test(e1.out) && /from a worktree/.test(e1.out),
  show(e1),
);
const e2 = sandboxed(
  `docker run --rm --name ${NAME}-e2 -v "$(mktemp -d):/t" -v ${NAME}-named:/n -p 127.0.0.1:0:5432 --memory 64m ${IMAGE} true && docker volume rm ${NAME}-named >/dev/null`,
);
check("(e) a bind of temp, a named volume, a port and a memory limit work", e2.code === 0, show(e2));
const e3 = sandboxed(`docker compose -p ${NAME}-h -f - config --services <<'EOF'
services:
  s: { image: ${IMAGE} }
EOF`);
check("(e) docker compose talks to the daemon through the proxy", e3.code === 0 && /^s$/m.test(e3.out), show(e3));
fs.writeFileSync(path.join(repo, "compose.yml"), `services:\n  s:\n    image: ${IMAGE}\n    command: ["true"]\n    volumes: ["\${HOME}:/h"]\n`);
const e4 = sandboxed(`docker compose -p ${NAME}-h up --no-build 2>&1 >/dev/null; echo rc=$?`);
check(
  "(e) docker compose up with a $HOME bind is refused by the proxy",
  /rc=[1-9]/.test(e4.out) && KITCHEN.test(e4.err + e4.out),
  `${e4.out.trim().split("\n").slice(-2).join(" ")}`,
);
spawnSync("docker", ["compose", "-p", `${NAME}-h`, "down", "--remove-orphans"], { cwd: repo, stdio: "ignore" });

// (h) W3b round 2 / ADR 0008, ownership: requests on existing containers only for ones created through the guard.
// A container this spike starts outside the guard (named kitchen-*, as another job's or another project's would be)
// can't be exec'd, stopped, removed, read or inspected from inside; one the sandboxed bin/dev created can.
// (Only kitchen-* containers are ever touched: never another project's.)
const foreign = `${NAME}-foreign`;
const fr = spawnSync("docker", ["run", "-d", "--name", foreign, "--memory", "32m", IMAGE, "sleep", "120"], { encoding: "utf8" });
check("(h) a container started outside the guard (the control)", fr.status === 0, fr.stderr.trim());
for (const [what, cmd] of [
  ["exec", `docker exec ${foreign} true`],
  ["stop", `docker stop -t 0 ${foreign}`],
  ["rm -f", `docker rm -f ${foreign}`],
  ["logs", `docker logs ${foreign}`],
  ["inspect", `docker inspect ${foreign}`],
  ["kill", `docker kill ${foreign}`],
  ["cp out of it", `docker cp ${foreign}:/etc/hostname -`],
] as const) {
  const h = sandboxed(`${cmd} >/dev/null; echo rc=$?`);
  check(`(h) ${what} on a container the guard didn't create is refused`, /rc=[1-9]/.test(h.out) && KITCHEN.test(h.err + h.out), `${h.out.trim()} ${h.err.trim().split("\n").at(-1)}`);
}
const still = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", foreign], { encoding: "utf8" });
check("(h) and it is still running, untouched", still.stdout.trim() === "true", still.stdout.trim() || still.stderr.trim());
const pr = sandboxed(`docker container prune -f >/dev/null; echo rc=$?`);
check("(h) container prune is refused", /rc=[1-9]/.test(pr.out) && KITCHEN.test(pr.err + pr.out), pr.err.trim().split("\n").at(-1) ?? "");
const own = sandboxed(
  `docker run -d --name ${NAME}-own --memory 32m ${IMAGE} sleep 60 >/dev/null && docker exec ${NAME}-own true && docker logs ${NAME}-own >/dev/null && docker stop -t 0 ${NAME}-own >/dev/null && docker rm ${NAME}-own >/dev/null; echo rc=$?`,
);
check("(h) its own container: exec, logs, stop, rm all work", /rc=0/.test(own.out), `${own.out.trim()} ${own.err.trim().split("\n").at(-1) ?? ""}`);
spawnSync("docker", ["rm", "-f", foreign], { stdio: "ignore" });

// (f) docker exec -i with stdin, the wrapper's stdin carried through to it
const f = sandboxed(
  `docker run -d --name ${NAME}-f --memory 64m ${IMAGE} sleep 60 >/dev/null && docker inspect -f '{{.State.Running}}' ${NAME}-f >&2 && docker exec -i ${NAME}-f cat; docker rm -f ${NAME}-f >/dev/null`,
  "stdin through the wrapper and the proxy\n",
);
check(
  "(f) docker exec -i reads the wrapper's stdin through the proxy (hijacked stream)",
  f.out === "stdin through the wrapper and the proxy\n" && /true/.test(f.err),
  show(f),
);

// the wrapper keeps bin/dev's contract: stdout exactly, the exit code, signals, and the proxy gone after
const g1 = sandboxed(`echo '{"status":"ok"}'; exit 7`);
check("the wrapper prints exactly bin/dev's stdout and returns its exit code", g1.out === '{"status":"ok"}\n' && g1.code === 7, show(g1));
const t0 = Date.now();
const slow = spawn(wrapper.bin, ["sleep 30"], { cwd: repo, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
slow.kill("SIGTERM");
const sig = await new Promise<number | null>((r) => slow.once("exit", (code, s) => r(code ?? (s ? 128 : -1))));
check("SIGTERM to the wrapper reaches bin/dev (it ends at once)", Date.now() - t0 < 10_000 && sig !== 0, `exit ${sig} after ${Date.now() - t0} ms`);
await new Promise((r) => setTimeout(r, 800));
const procs = spawnSync("pgrep", ["-f", `docker-proxy.ts serve .*--root ${repo}`], { encoding: "utf8" }).stdout.trim();
check(
  "no guard proxy or temp folder is left once the wrappers ended",
  !procs && guardDirs().length === 0,
  `proxies [${procs}] dirs [${guardDirs().join(", ")}]`,
);

// (g) a merged (unsandboxed) bin/dev is untouched: no wrapper, the daemon's socket, its binds
const g = merged(`echo "DOCKER_HOST=$DOCKER_HOST"; docker run --rm --name ${NAME}-g -v "$HOME:/h:ro" ${IMAGE} true && echo ran`);
check("(g) a merged bin/dev runs without the guard (no proxy, the $HOME bind runs)", g.code === 0 && /ran/.test(g.out) && !/kitchen-dg/.test(g.out), show(g));

cleanup();
const left = containers();
check("no kitchen-guard-spike containers left", left.length === 0, left.join(", "));
finish("w3b docker guard");
