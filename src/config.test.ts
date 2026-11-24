import assert from "node:assert/strict";
import { test } from "vitest";
import { appUrl, ConfigError, modelFor, parseConfig } from "./config.ts";

test("defaults: staging from main, 400 lines, four lanes at once, no app", () => {
  const c = parseConfig("");
  assert.equal(c.round_limit, 3);
  assert.equal(c.parallel, 4);
  assert.deepEqual(c.staging, { branch: "staging", base: "main", max_lines: 400, auto_merge: true });
  assert.equal(c.app.start, "");
  assert.equal(appUrl(c.app), null);
  assert.equal(modelFor(c, "builder"), "opus");
  assert.equal(modelFor(c, "qa"), "sonnet");
});

test("an unknown key is refused; staging can never be the base, main or master", () => {
  assert.throws(() => parseConfig("roundlimit: 2\n"), ConfigError);
  assert.throws(() => parseConfig("staging: { branch: main }\n"), /never merges/);
  assert.throws(() => parseConfig("staging: { branch: dev, base: dev }\n"), /never merges/);
});

test("a kitchen.yaml from before ADR 0016 still loads: its old keys are dropped and named", () => {
  const c = parseConfig(
    [
      "concurrency: 2",
      "checks_network: false",
      'test_cmd: "npm test -- {file}"',
      "retro: { every_jobs: 5 }",
      "models: { verifier: haiku, smith: strong }",
      "agent: { tool: claude, timeout_sec: 100 }",
      "forge: { kind: local, base: develop }",
      "checks: [npm test]",
    ].join("\n"),
  );
  assert.equal(c.models.qa, "haiku");
  assert.equal(c.staging.base, "develop");
  assert.equal(c.checkList[0].run, "npm test");
  for (const k of ["concurrency", "checks_network", "test_cmd", "retro", "models.verifier", "models.smith", "agent.timeout_sec", "forge.base"])
    assert.ok(c.dropped.includes(k), k);
});

test("the app's URL fills {port}", () => {
  assert.equal(appUrl(parseConfig("app: { start: npm start, port: 4100 }").app), "http://127.0.0.1:4100");
});
