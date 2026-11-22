import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { devEnvValues, refusal, scanText, secretLike } from "./secrets.ts";

// Built at runtime so this file itself holds no credential-shaped literal.
const live = (prefix: string, body: string) => `${prefix}${body}`;

describe("secret scan", () => {
  it("names the key of a known live-credential shape in .env.kitchen", () => {
    const text = [
      "STRIPE_KEY=sk_test_fake000000000000",
      `STRIPE_LIVE=${live("sk_live_", "51Habcdefghijklmnop")}`,
      `AWS_ACCESS_KEY_ID=${live("AKIA", "ABCDEFGHIJKLMNOP")}`,
      `GH=${live("ghp_", "a".repeat(36))}`,
      `GHO=${live("gho_", "b".repeat(36))}`,
      `SLACK=${live("xoxb-", "1234567890-abcdef")}`,
    ].join("\n");
    const f = scanText(".env.kitchen", text);
    expect(f.map((x) => x.key)).toEqual(["STRIPE_LIVE", "AWS_ACCESS_KEY_ID", "GH", "GHO", "SLACK"]);
  });
  it("names AI-provider, GitHub fine-grained, Google, GitLab and npm keys", () => {
    const alnum = (n: number) => "aB3dE5gH7jK9".repeat(8).slice(0, n);
    const text = [
      `ANTHROPIC_API_KEY=${live("sk-ant-", `api03-${alnum(40)}`)}`,
      `OPENAI_PROJECT=${live("sk-proj-", alnum(40))}`,
      `OPENAI_LEGACY=${live("sk-", alnum(48))}`,
      `GH_PAT=${live("github_pat_", `11ABCDEFG0_${alnum(40)}`)}`,
      `GOOGLE=${live("AIza", alnum(35))}`,
      `GITLAB=${live("glpat-", alnum(20))}`,
      `NPM=${live("npm_", alnum(36))}`,
    ].join("\n");
    const f = scanText(".env.kitchen", text);
    expect(f.map((x) => `${x.key}: ${x.why}`)).toEqual([
      "ANTHROPIC_API_KEY: an Anthropic API key (sk-ant-…)",
      "OPENAI_PROJECT: an OpenAI API key (sk-proj-…)",
      "OPENAI_LEGACY: an OpenAI API key (sk-…)",
      "GH_PAT: a GitHub fine-grained token (github_pat_…)",
      "GOOGLE: a Google API key (AIza…)",
      "GITLAB: a GitLab token (glpat-…)",
      "NPM: an npm token (npm_…)",
    ]);
  });
  it("leaves fake sk- values alone (short, dashed, digits only, all letters)", () => {
    const text = [
      "OPENAI_API_KEY=sk-test",
      "OPENAI_API_KEY=sk-kitchen-fake-key-for-the-mock-0000",
      `OPENAI_API_KEY=sk-${"0".repeat(48)}`,
      `OPENAI_API_KEY=sk-${"fake".repeat(10)}`,
      "OPENAI_API_KEY=sk-abc123",
      "ANTHROPIC_API_KEY=sk-ant-fake",
      "NPM_CONFIG=npm_config_cache",
      "TASK=disk-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6", // sk- inside a word is not a key
    ].join("\n");
    expect(scanText(".env.kitchen", text)).toEqual([]);
  });
  it("finds a private key block in any file", () => {
    const f = scanText(".kitchen/toolkit/app.mjs", `const k = \`${live("-----BEGIN RSA ", "PRIVATE KEY-----")}\nMIIE…\`;`);
    expect(f).toHaveLength(1);
    expect(f[0].why).toMatch(/private key/);
  });
  it("refuses a value copied from the developer's own env, but not ports or flags", () => {
    const dev = new Map([["s3cr3t-real-password", "DB_PASSWORD (.env)"]]);
    const f = scanText(".env.kitchen", "DB_PASSWORD=s3cr3t-real-password\nPORT=3000\nDEBUG=true", dev);
    expect(f).toEqual([{ file: ".env.kitchen", line: 1, key: "DB_PASSWORD", why: expect.stringMatching(/DB_PASSWORD \(\.env\)/) }]);
    expect(scanText("docker-compose.yml", "  POSTGRES_PASSWORD: s3cr3t-real-password", dev)).toHaveLength(1);
    expect(scanText(".env.kitchen", "DB_PASSWORD=kitchen-fake-password", dev)).toEqual([]);
  });
  it("a secret-looking value: long, not a number, flag or credential-free URL", () => {
    expect(secretLike("3000")).toBe(false);
    expect(secretLike("true")).toBe(false);
    expect(secretLike("http://localhost:3000")).toBe(false);
    expect(secretLike("postgres://app:hunter2hunter2@db.internal/app")).toBe(true);
    expect(secretLike("a1b2c3d4e5f6")).toBe(true);
  });
  it("reads only the untracked .env* files at the root, never .env.kitchen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-secrets-"));
    try {
      fs.writeFileSync(path.join(dir, ".env"), "API_TOKEN=real-token-123456\nPORT=3000\n");
      fs.writeFileSync(path.join(dir, ".env.example"), "API_TOKEN=example-token-0000\n");
      fs.writeFileSync(path.join(dir, ".env.kitchen"), "API_TOKEN=fake-token-0000000\n");
      const v = devEnvValues(dir, new Set([".env.example"]));
      expect([...v.entries()]).toEqual([["real-token-123456", "API_TOKEN (.env)"]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the refusal names file, line and key", () => {
    const msg = refusal([{ file: ".env.kitchen", line: 2, key: "STRIPE_LIVE", why: "a live Stripe secret key (sk_live_…)" }], "/repo/.worktrees/_setup");
    expect(msg).toMatch(/\.env\.kitchen:2 STRIPE_LIVE: a live Stripe secret key/);
    expect(msg).toMatch(/refusing to commit/);
  });
});
