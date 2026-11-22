import { expect, it } from "vitest";
import { bridgeServer } from "./mcp.ts";

it("the bridge gets Docker and KITCHEN_HOME explicitly, and nothing it doesn't need", () => {
  const b = bridgeServer(
    { job: "001-x", role: "builder", repo: "/r" },
    { PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///d.sock", DOCKER_CONTEXT: "colima", GH_TOKEN: "t", ANTHROPIC_API_KEY: "a", SSH_AUTH_SOCK: "/s" },
  );
  expect(b.env).toMatchObject({ PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///d.sock", DOCKER_CONTEXT: "colima" });
  expect(b.env.KITCHEN_HOME).toBeTruthy();
  for (const k of ["GH_TOKEN", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK"]) expect(b.env[k]).toBeUndefined();
  expect(b.args.slice(1)).toEqual(["mcp", "--job", "001-x", "--role", "builder", "--repo", "/r"]);
});
