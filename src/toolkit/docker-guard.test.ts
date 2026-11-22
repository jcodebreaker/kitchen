import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { apiPath, apiRefusal, argvRefusal, guardRoots, repoOfBin, upgradeAllowed } from "./docker-guard.ts";
import { profileText, wrappedBin, wrapperText } from "./sandbox.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kdg-test-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
// A repo outside temp, so "outside the roots" means something: under $HOME-like /Users/x (does not exist, resolves as given).
const repo = "/Users/someone/code/app";
const home = "/Users/someone";
const roots = guardRoots(repo);
const o = { roots, cwd: repo, home };
const run = (...a: string[]) => argvRefusal(a, o);
const create = (body: unknown) => apiRefusal("POST", "/v1.47/containers/create?name=x", body, roots);

describe("argvRefusal (the shim)", () => {
  it("refuses a bind of $HOME, ~ and a relative path that climbs out", () => {
    expect(run("run", "--rm", "-v", "/Users/someone:/h", "alpine", "true")).toMatch(/bind mount of \/Users\/someone outside the repo/);
    expect(run("run", "-v", "~/.ssh:/s", "alpine")).toMatch(/\.ssh/);
    expect(run("run", "-v", "../../..:/s", "alpine")).toMatch(/refused/);
    expect(run("container", "create", "--volume=/etc:/e", "alpine")).toMatch(/\/etc/);
    expect(run("run", "-itv", "/:/root", "alpine")).toMatch(/refused/);
    expect(run("run", "-v/Users:/u", "alpine")).toMatch(/refused/);
    expect(run("run", "--mount", "type=bind,source=/Users/someone,target=/h", "alpine")).toMatch(/refused/);
    expect(run("run", "--mount=type=bind,src=/Users/someone,dst=/h,readonly", "alpine")).toMatch(/refused/);
    expect(run("run", "--mount", "type=volume,dst=/h,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/Users/someone", "alpine")).toMatch(
      /volume binding/,
    );
  });
  it("allows binds inside the repo, its worktrees and temp, named volumes and anonymous ones", () => {
    expect(run("run", "--rm", "-v", `${repo}:/r:ro`, "alpine", "ls")).toBeNull();
    expect(run("run", "-v", "./db:/docker-entrypoint-initdb.d:ro", "alpine")).toBeNull();
    expect(run("run", "-v", `${repo}/.worktrees/_toolkit@abc/x:/x`, "alpine")).toBeNull();
    expect(run("run", "-v", `${tmp}:/t`, "alpine")).toBeNull();
    expect(run("run", "-v", "/tmp/x:/t", "alpine")).toBeNull();
    expect(run("run", "-v", "pgdata:/var/lib/postgresql/data", "-v", "/data", "alpine")).toBeNull();
    expect(run("run", "--mount", "type=volume,src=pg,dst=/d", "--mount", "type=tmpfs,dst=/t", "alpine")).toBeNull();
  });
  it("refuses privileged and the host's namespaces, not their harmless forms", () => {
    expect(run("run", "--privileged", "alpine")).toMatch(/--privileged/);
    expect(run("run", "--privileged=false", "alpine")).toBeNull();
    expect(run("run", "--pid=host", "alpine")).toMatch(/--pid=host/);
    expect(run("run", "--pid", "host", "alpine")).toMatch(/--pid=host/);
    expect(run("run", "--network=host", "alpine")).toMatch(/--network=host/);
    expect(run("run", "--net", "host", "alpine")).toMatch(/--net=host/);
    expect(run("run", "--ipc=host", "alpine")).toMatch(/refused/);
    expect(run("run", "--userns=host", "alpine")).toMatch(/refused/);
    expect(run("run", "--network", "bridge", "alpine")).toBeNull();
    expect(run("run", "--cap-add", "SYS_ADMIN", "alpine")).toMatch(/SYS_ADMIN/);
    expect(run("run", "--cap-add=NET_ADMIN", "alpine")).toBeNull();
    expect(run("run", "--volumes-from", "other", "alpine")).toMatch(/volumes-from/);
    expect(run("run", "--use-api-socket", "alpine")).toMatch(/socket/);
  });
  it("stops at the image: the container's own arguments are not flags", () => {
    expect(run("run", "-d", "--name", "x", "-p", "127.0.0.1:5432:5432", "--memory", "256m", "postgres", "-v", "/:/r", "--privileged")).toBeNull();
    expect(run("exec", "-i", "c", "psql", "-v", "ON_ERROR_STOP=1")).toBeNull();
    expect(run("ps", "-a")).toBeNull();
  });
  it("refuses another endpoint or context before the subcommand", () => {
    expect(run("-H", "unix:///var/run/docker.sock", "ps")).toMatch(/-H/);
    expect(run("--context=colima", "ps")).toMatch(/--context/);
    expect(run("--config", "/x", "run", "-v", "/Users:/u", "alpine")).toMatch(/refused/);
  });
});

describe("apiRefusal (the proxy)", () => {
  it("refuses Binds and bind Mounts outside the roots, in any key case and the old top-level form", () => {
    expect(create({ Image: "a", HostConfig: { Binds: ["/Users/someone:/h"] } })).toMatch(/bind mount of \/Users\/someone/);
    expect(create({ Image: "a", HostConfig: { Mounts: [{ Type: "bind", Source: "/Users/someone/.ssh", Target: "/s" }] } })).toMatch(/refused/);
    expect(create({ hostconfig: { binds: ["/etc:/e"] } })).toMatch(/refused/);
    expect(create({ HostConfig: { Binds: [] }, hostConfig: { Binds: ["/:/r"] } })).toMatch(/refused/);
    expect(create({ Image: "a", Binds: ["/Users:/u"] })).toMatch(/refused/);
    expect(create({ HostConfig: { Mounts: [{ Source: "/var/run/docker.sock", Target: "/s" }] } })).toMatch(/docker\.sock/);
    expect(
      create({
        HostConfig: {
          Mounts: [{ Type: "volume", Target: "/h", VolumeOptions: { DriverConfig: { Options: { type: "none", o: "bind", device: "/Users/someone" } } } }],
        },
      }),
    ).toMatch(/volume binding/);
  });
  it("allows the repo, its worktrees, temp and named volumes", () => {
    expect(create({ HostConfig: { Binds: [`${repo}:/r:ro`, `${repo}/.worktrees/w:/w`, "/tmp/x:/x", "pgdata:/d"] } })).toBeNull();
    expect(
      create({
        HostConfig: {
          Mounts: [
            { Type: "bind", Source: `${tmp}/a`, Target: "/a" },
            { Type: "volume", Source: "pg", Target: "/d" },
          ],
        },
      }),
    ).toBeNull();
    expect(create({ Image: "postgres", HostConfig: { PortBindings: {}, Memory: 268435456, NetworkMode: "bridge" } })).toBeNull();
  });
  it("refuses privileged, host namespaces, dangerous caps and volumes-from", () => {
    expect(create({ HostConfig: { Privileged: true } })).toMatch(/privileged/);
    expect(create({ HostConfig: { PidMode: "host" } })).toMatch(/PidMode=host/);
    expect(create({ HostConfig: { NetworkMode: "host" } })).toMatch(/NetworkMode=host/);
    expect(create({ HostConfig: { IpcMode: "host" } })).toMatch(/IpcMode/);
    expect(create({ HostConfig: { CapAdd: ["CAP_SYS_ADMIN"] } })).toMatch(/SYS_ADMIN/);
    expect(create({ HostConfig: { VolumesFrom: ["other"] } })).toMatch(/volumes-from/);
  });
  it("refuses a privileged exec, a bind volume and a body that is not JSON; lets other requests through", () => {
    expect(apiRefusal("POST", "/v1.47/containers/abc/exec", { Cmd: ["sh"], Privileged: true }, roots)).toMatch(/privileged exec/);
    expect(apiRefusal("POST", "/containers/abc/exec", { Cmd: ["cat"], AttachStdin: true }, roots)).toBeNull();
    expect(apiRefusal("POST", "/v1.47/volumes/create", { Name: "v", DriverOpts: { type: "none", o: "bind", device: "/Users/someone" } }, roots)).toMatch(
      /volume binding/,
    );
    expect(apiRefusal("POST", "/v1.47/volumes/create", { Name: "v" }, roots)).toBeNull();
    expect(create(undefined)).toMatch(/not a JSON object/);
    expect(apiRefusal("GET", "/v1.47/containers/json", undefined, roots)).toBeNull();
    expect(apiRefusal("POST", "/v1.47/services/create", undefined, roots)).toMatch(/swarm/);
  });
  it("refuses paths that are not canonical, and upgrades other than exec/attach/BuildKit", () => {
    expect(apiPath("/v1.47/containers/../containers/create")).toBeNull();
    expect(apiRefusal("POST", "//containers/create", undefined, roots)).toMatch(/not canonical/);
    expect(apiRefusal("POST", "/containers%2Fcreate", undefined, roots)).toMatch(/not a JSON object/); // decoded it is /containers/create: its body is checked
    expect(upgradeAllowed(apiPath("/v1.47/exec/abc/start"))).toBe(true);
    expect(upgradeAllowed(apiPath("/v1.47/containers/abc/attach?stream=1"))).toBe(true);
    expect(upgradeAllowed(apiPath("/v1.47/containers/create"))).toBe(false);
  });
  it("resolves symlinks: a link in the repo to outside is outside", () => {
    const r = path.join(tmp, "r2");
    fs.mkdirSync(path.join(r, "sub"), { recursive: true });
    fs.symlinkSync("/etc", path.join(r, "sub", "etc"));
    const rr = guardRoots("/Users/nobody/r").filter((x) => !x.startsWith(tmp) && !x.startsWith(os.tmpdir()));
    expect(apiRefusal("POST", "/containers/create", { HostConfig: { Binds: [`${r}/sub/etc:/e`] } }, rr)).toMatch(/refused/);
  });
});

describe("the wrapper", () => {
  it("repoOfBin: a checkout's bin/dev belongs to the repo above .worktrees", () => {
    expect(repoOfBin("/r/app/.kitchen/toolkit/bin/dev")).toBe("/r/app");
    expect(repoOfBin("/r/app/.worktrees/_toolkit@abc/.kitchen/toolkit/bin/dev")).toBe("/r/app");
  });
  it("wrappedBin reads the real bin/dev back from both wrapper forms", () => {
    const dir = path.join(tmp, "sandbox");
    fs.mkdirSync(dir, { recursive: true });
    const real = "/r/it's/.worktrees/_toolkit@abc/.kitchen/toolkit/bin/dev";
    const w = path.join(dir, "dev-0123456789ab");
    const guard = { node: "/n", proxy: "/p.ts", upstream: "/s.sock", docker: "/d", roots: ["/r/it's"] };
    fs.writeFileSync(w, wrapperText(real, "/k/sandbox/setup-bridge.sb", guard));
    expect(wrappedBin(w)).toBe(real);
    fs.writeFileSync(w, wrapperText(real, "/k/sandbox/setup-bridge.sb", null));
    expect(wrappedBin(w)).toBe(real);
    fs.writeFileSync(w, `#!/bin/sh\n# old\nexec /usr/bin/sandbox-exec -f '/k/p.sb' '/r/x/bin/dev' "$@"\n`);
    expect(wrappedBin(w)).toBe("/r/x/bin/dev");
  });
  it("the profile denies connecting to the daemon's sockets", () => {
    const p = profileText(["/h/.ssh"], [], ["/var/run/docker.sock", "/h/.colima/"]);
    expect(p).toContain('(deny network-outbound (remote unix-socket (path-literal "/var/run/docker.sock")) (remote unix-socket (subpath "/h/.colima")))');
  });
});
