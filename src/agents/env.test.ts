import { describe, expect, it } from "vitest";
import { parseEnvFile, scrubEnv, untrustedEnvOf } from "./env.ts";

const home = { gitConfig: "/k/scrub/gitconfig", ghConfigDir: "/k/scrub/gh" };
const parent = {
  HOME: "/Users/x",
  PATH: "/usr/bin",
  LC_ALL: "C",
  GH_TOKEN: "t",
  GITHUB_TOKEN: "t",
  SSH_AUTH_SOCK: "/tmp/s",
  AWS_SECRET_ACCESS_KEY: "s",
  GIT_SSH_COMMAND: "ssh -i key",
  GIT_CONFIG_GLOBAL: "/Users/x/.gitconfig",
  ANTHROPIC_API_KEY: "a",
  OPENAI_API_KEY: "o",
  DOCKER_HOST: "unix:///d.sock",
};

const closesPush = (env: Record<string, string>) =>
  expect(env).toMatchObject({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: home.gitConfig,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "url.kitchen-push-blocked:///.pushInsteadOf",
    GIT_CONFIG_VALUE_1: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "false",
    GH_CONFIG_DIR: home.ghConfigDir,
  });

describe("scrubEnv (agents)", () => {
  const env = scrubEnv(parent, home);
  it("keeps only allowlisted variables, including the agent tool's auth", () => {
    expect(env.HOME).toBe("/Users/x");
    expect(env.LC_ALL).toBe("C");
    expect(env.ANTHROPIC_API_KEY).toBe("a");
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY", "DOCKER_HOST"]) expect(env[k]).toBeUndefined();
  });
  it("closes every push path", () => closesPush(env));
});

describe("untrustedEnvOf (app, tests, Toolkit)", () => {
  const env = untrustedEnvOf(parent, home, { PGPASSWORD: "fake", GIT_CONFIG_VALUE_0: "osxkeychain", GH_CONFIG_DIR: "/Users/x/.config/gh" });
  it("gets no agent auth, no tokens, no Docker", () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY", "DOCKER_HOST"]) {
      expect(env[k]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
  });
  it("adds .env.kitchen values, but they can't undo the scrub", () => {
    expect(env.PGPASSWORD).toBe("fake");
    closesPush(env);
  });
});

it("parseEnvFile reads KEY=value lines and skips comments", () => {
  expect(parseEnvFile("# fake\nA=1\n  B = two words \nnot a line\n")).toEqual({ A: "1", B: "two words" });
});
