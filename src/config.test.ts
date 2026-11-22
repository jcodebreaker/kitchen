import assert from "node:assert/strict";
import { test } from "vitest";
import { ConfigError, modelFor, parseConfig } from "./config.ts";

test("an empty kitchen.yaml is all PLAN §6 defaults", () => {
  const c = parseConfig("");
  assert.equal(c.concurrency, 2);
  assert.equal(c.round_limit, 3);
  assert.equal(c.models.intake, "strong");
  assert.equal(c.models.retro, "cheap");
  assert.deepEqual(c.paths.low, { spec: "inline", verify: "short", review: ["code-if-diff>150"] });
  assert.equal(c.paths.high.human, "always");
  assert.deepEqual(c.surfaces, { ui: ["ux", "ui"], security: ["security"] });
  assert.equal(c.risk_floor.diff_lines_high, 1000);
  assert.equal(c.automerge, "off");
  assert.deepEqual(c.protected, ["kitchen.yaml"]);
  assert.equal(c.retro.every_jobs, 5);
  assert.equal(c.agent.tool, "claude");
  assert.equal(c.forge.kind, "local");
  assert.deepEqual(c.checkList, []);
});

test("the PLAN §6 example parses as written (flow maps, comments, globs)", () => {
  const c = parseConfig(`
concurrency: 2
round_limit: 3
models: { intake: strong, spec: strong, builder: strong, smith: strong,
          verifier: medium, reviewer: medium, report: medium, retro: cheap }
paths:
  low:    { spec: inline, verify: short, review: [code-if-diff>150] }   # any drive diff forces the code lens
  medium: { spec: full,   verify: full,  review: [code] }
  high:   { spec: full,   verify: related-features, review: [code, security], human: always }
surfaces: { ui: [ux, ui], security: [security] }
high_paths: ["**/migrations/**", "**/auth/**", "**/*payment*", "infra/**", ".github/**"]
risk_floor: { diff_lines_medium: 300, diff_lines_high: 1000 }
automerge: off
protected: [kitchen.yaml]
retro: { every_jobs: 5 }
`);
  assert.deepEqual(c.paths.high.review, ["code", "security"]);
  assert.equal(c.automerge, "off");
});

test("partial sections keep the other defaults; checks normalise", () => {
  const c = parseConfig(
    "models: { builder: medium }\nrisk_floor: { diff_lines_medium: 50 }\nchecks:\n  - npm test\n  - { name: lint, run: npm run lint, timeout_sec: 30 }\n",
  );
  assert.equal(c.models.builder, "medium");
  assert.equal(c.models.intake, "strong");
  assert.equal(c.risk_floor.diff_lines_high, 1000);
  assert.deepEqual(c.checkList, [
    { name: "check1", run: "npm test", timeoutSec: 600 },
    { name: "lint", run: "npm run lint", timeoutSec: 30 },
  ]);
});

test("unknown keys, wrong types and bad YAML are refused with the path", () => {
  assert.throws(
    () => parseConfig("concurency: 2"),
    (e) => e instanceof ConfigError && /Unrecognized key/.test(e.message),
  );
  assert.throws(() => parseConfig("paths: { low: { spec: maybe, verify: short, review: [] } }"), /paths\.low\.spec/);
  assert.throws(() => parseConfig("concurrency: 0"), /concurrency/);
  assert.throws(() => parseConfig("a: [1,"), ConfigError);
  assert.throws(() => parseConfig("concurrency: 1\nconcurrency: 2"), ConfigError);
});

test("models map through the tool's tier table, or are given literally", () => {
  const claude = parseConfig("");
  assert.equal(modelFor(claude, "intake"), "opus");
  assert.equal(modelFor(claude, "verifier"), "sonnet");
  assert.equal(modelFor(claude, "reviewer-security"), "sonnet");
  assert.equal(modelFor(claude, "repro"), "sonnet");
  const codex = parseConfig("agent: { tool: codex, models: { cheap: gpt-6-luna } }\nmodels: { intake: cheap, spec: my-model }");
  assert.equal(modelFor(codex, "intake"), "gpt-6-luna");
  assert.equal(modelFor(codex, "spec"), "my-model");
});
