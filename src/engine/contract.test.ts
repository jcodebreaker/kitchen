import assert from "node:assert/strict";
import { test } from "vitest";
import { featureFileProblems } from "../toolkit/feature-check.ts";
import { builderPolicy, drivesPolicy, filesChecksRunThrough, scriptsChanged } from "./contract.ts";

test("the files Gate's checks and the test command run through: scripts and config, not the app file a check reads", () => {
  assert.deepEqual(filesChecksRunThrough(["node --check server.js"]), [], "node --check only reads server.js");
  assert.deepEqual(filesChecksRunThrough(["./scripts/check.sh --fast"]).sort(), ["scripts/check.sh"]);
  assert.deepEqual(filesChecksRunThrough(["sh ci/lint.sh && node tools/test.mjs"]).sort(), ["ci/lint.sh", "tools/test.mjs"]);
  assert.deepEqual(filesChecksRunThrough(["npx vitest run -c vitest.config.ts", "npx tsc -p tsconfig.json"]).sort(), ["tsconfig.json", "vitest.config.ts"]);
  assert.deepEqual(filesChecksRunThrough(["npm test -- {file}"]), [], "npm's scripts are guarded by the scripts rule");
});

test("a package.json counts as changed only when its scripts did", () => {
  const a = JSON.stringify({ scripts: { test: "vitest run" }, dependencies: { a: "1" } });
  assert.equal(scriptsChanged(a, JSON.stringify({ scripts: { test: "vitest run" }, dependencies: { a: "2", b: "1" } })), false, "a dependency bump");
  assert.equal(scriptsChanged(a, JSON.stringify({ scripts: { test: "true" } })), true);
  assert.equal(scriptsChanged(null, JSON.stringify({ scripts: { test: "true" } })), true, "a new package.json with scripts");
  assert.equal(scriptsChanged(a, "{ not json"), true);
});

test("the builder may not touch what proofs run through", () => {
  const p = builderPolicy({
    protectedGlobs: ["kitchen.yaml"],
    reproFiles: ["test/repro.test.js"],
    proofFiles: ["test/admin.test.js"],
    checkFiles: ["scripts/check.sh"],
    scriptsChanged: ["package.json"],
  });
  assert.match(p("test/repro.test.js", "M") ?? "", /repro/);
  assert.match(p("test/admin.test.js", "A") ?? "", /`test` proof/, "the builder may not write the contract's test");
  assert.match(p("scripts/check.sh", "M") ?? "", /Gate/);
  assert.match(p("package.json", "M") ?? "", /scripts/);
  assert.match(p(".kitchen/toolkit/features/x.md", "A") ?? "", /Toolkit/);
  assert.match(p("kitchen.yaml", "M") ?? "", /protected/);
  assert.equal(p("server.js", "M"), null);
  assert.equal(p("db/003_add_column.sql", "A"), null, "a migration is allowed (and raises the risk floor at Gate)");
});

test("the drives stage keeps feature drives and the contract's test files only", () => {
  const p = drivesPolicy(["test/admin.test.js"]);
  assert.equal(p(".kitchen/toolkit/features/admin.md", "A"), null);
  assert.equal(p("test/admin.test.js", "A"), null);
  assert.match(p("server.js", "M") ?? "", /only/);
  assert.match(p(".kitchen/toolkit/features/admin.md", "D") ?? "", /not deleted/);
});

test("a feature file a job writes must pass W2's rules: parseable, a check line per drive, listed by describe", () => {
  const drive = "```drive\ndrive: admin.projects\nargs: [user]\nsteps:\n  - login: { as: $user }\n  - read: { target: body }\n    save: page\n```\n";
  const block = "```kitchen\npaths: [server.js]\ncheck: { drive: admin.projects, args: { user: bob-admin } }\n```\n";
  const rel = ".kitchen/toolkit/features/admin.md";
  assert.deepEqual(featureFileProblems(rel, `# Admin\n\n${drive}\n${block}`, ["features/admin.md"]), []);
  assert.match(featureFileProblems(rel, `# Admin\n\n${drive}`, ["features/admin.md"]).join(), /has no check line|no paths/);
  assert.match(featureFileProblems(rel, `# Admin\n\n${drive}\n${block}`, []).join(), /describe doesn't list features\/admin.md/);
  assert.match(featureFileProblems(rel, `${drive}\n${block}\n${block}`, ["features/admin.md"]).join(), /more than one kitchen block/);
});
