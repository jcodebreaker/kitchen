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
