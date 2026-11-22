import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { CONFIG_VERSION, migrateConfigText, planMigration, TEMPLATE_DIR, unifiedDiff } from "./migrate.ts";

test("kitchen.yaml without a version is stamped, comments and order kept; a current one is left alone", () => {
  const old = "# my settings\nconcurrency: 1   # one at a time\nagent: { tool: claude }\n";
  const r = migrateConfigText(old);
  assert.deepEqual(r.steps.length, CONFIG_VERSION);
  assert.equal(r.from, 0);
  assert.match(r.after, /^# my settings\nversion: 1\nconcurrency: 1 {3}# one at a time\n/);
  const again = migrateConfigText(r.after);
  assert.deepEqual([again.steps, again.after], [[], r.after]);
});

test("the version goes where the parsed document says: after ---/%YAML, into flow maps, CRLF kept, version: 0 replaced", () => {
  const at = (t: string) => migrateConfigText(t).after;
  assert.equal(at("%YAML 1.2\n---\n# c\nconcurrency: 1\n"), "%YAML 1.2\n---\n# c\nversion: 1\nconcurrency: 1\n");
  assert.equal(at("---\nconcurrency: 1\n"), "---\nversion: 1\nconcurrency: 1\n");
  assert.equal(at("{concurrency: 1, agent: {tool: claude}}\n"), "{version: 1, concurrency: 1, agent: {tool: claude}}\n");
  assert.equal(at("{}\n"), "{version: 1}\n");
  assert.equal(at("# c\r\nconcurrency: 1   # one\r\n"), "# c\r\nversion: 1\r\nconcurrency: 1   # one\r\n");
  assert.equal(at("version: 0  # old\nconcurrency: 1\n"), "version: 1  # old\nconcurrency: 1\n");
  assert.equal(at(""), "version: 1\n");
  assert.equal(at("# nothing yet"), "# nothing yet\nversion: 1\n");
  assert.throws(() => migrateConfigText("- a\n- b\n"), /not a map/);
});

test("a newer kitchen.yaml, or one this Kitchen can't load after migrating, is refused", () => {
  assert.throws(() => migrateConfigText("version: 9\n"), /upgrade Kitchen/);
  assert.throws(() => migrateConfigText("bogus_key: 1\n"), /bogus_key|Unrecognized/);
});

test("Toolkit: only the template's generic files that differ, never project files or deleted modules", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-migrate-"));
  const tk = path.join(repo, ".kitchen", "toolkit");
  fs.cpSync(TEMPLATE_DIR, tk, { recursive: true });
  fs.rmSync(path.join(tk, "lib", "browser.mjs"));
  fs.writeFileSync(path.join(tk, "lib", "terminal.mjs"), "// an old copy\n");
  fs.writeFileSync(path.join(tk, "app.mjs"), "// project code\n");
  fs.writeFileSync(path.join(repo, "kitchen.yaml"), "version: 1\n");
  const p = planMigration(repo);
  assert.deepEqual(
    p.changes.map((c) => c.file),
    [path.join(".kitchen", "toolkit", "lib", "terminal.mjs")],
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

test("unifiedDiff: hunks with context, empty when equal", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "f"), "");
  const d = unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n", "1\n2\n3\n4\nfive\n6\n7\n8\n9\n", "f");
  assert.equal(d, "--- a/f\n+++ b/f\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n");
});
