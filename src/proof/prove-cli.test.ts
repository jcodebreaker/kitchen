// Dogfood finding 2 (job 006): a CLI bug whose base exits non-zero could never be
// reproduced, because the `cli` step failed on the base (`step-failed`). Now the
// template's `cli` primitive reports the exit code as the output of a step that ran,
// and the expect decides. A fake Toolkit runs the real primitive in process
// (runDrive is replaced by it), against a fake app: `tasks`, whose unknown command
// exits 0 (the bug) or 1 (fixed).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test, vi } from "vitest";
import type { DriveResult } from "./drive.ts";
import { exitOf, prove } from "./prove.ts";

type Prim = { run: (ctx: unknown, a: Record<string, unknown>) => { ok: boolean; out: unknown; files?: string[] } };
const TEMPLATE = path.resolve(import.meta.dirname, "..", "..", "toolkit-template", "lib", "terminal.mjs");
const { terminalPrimitives } = (await import(TEMPLATE)) as { terminalPrimitives: (o: unknown) => Record<string, Prim> };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-cli-repro-"));
const app = path.join(dir, "tasks.mjs");
/** The fake app: `list` works; an unknown command prints an error and exits with $UNKNOWN_EXIT (0: the bug). */
fs.writeFileSync(
  app,
  [
    "const [cmd] = process.argv.slice(2);",
    'if (cmd === "list") { console.log("1 Buy milk"); process.exit(0); }',
    'console.error("unknown command: " + cmd);',
    "process.exit(Number(process.env.UNKNOWN_EXIT));",
  ].join("\n"),
);
let unknownExit = "0";
const state: Record<string, unknown> = {};
const prims = terminalPrimitives({ command: () => [process.execPath, app], env: () => ({ UNKNOWN_EXIT: unknownExit }), cwd: () => dir });

vi.mock("./drive.ts", () => ({
  runDrive: async (o: { request: { primitive?: string; args: Record<string, unknown> } }): Promise<Partial<DriveResult>> => {
    const name = o.request.primitive ?? "";
    const r = prims[name].run({ state, out: null, src: dir }, o.request.args);
    const step = { line: 1, step: name, ok: r.ok, out: r.out, evidence: [] };
    return { ok: r.ok, drive: name, vars: {}, steps: [step], ...(r.ok ? {} : { failedAt: step }) };
  },
}));

beforeEach(() => {
  unknownExit = "0";
});

const crit = (expect: string) => ({ id: "C1", proof: "toolkit cli --argv frobnicate", expect });
const run = (expect: string) => prove({ jobDir: dir, criterion: crit(expect), role: "engine", testCmd: "true" });

test("the cli primitive: a command that ran is ok whatever its exit; it fails only when it can't run, or on a pinned expect_exit", () => {
  unknownExit = "1";
  const r = prims.cli.run({ state, out: null, src: dir }, { argv: "frobnicate" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.out, { exit: 1, stdout: "", stderr: "unknown command: frobnicate" });
  assert.equal(exitOf(r.out), 1);
  assert.equal(prims.cli.run({ state, out: null, src: dir }, { argv: "frobnicate", expect_exit: "0" }).ok, false, "a pinned exit still fails the step");
  assert.equal(prims.cli.run({ state, out: null, src: dir }, { argv: "frobnicate", expect_exit: "1" }).ok, true);
  const missing = terminalPrimitives({ command: () => [path.join(dir, "no-such-binary")] });
  const m = missing.cli.run({ state: {}, out: null, src: dir }, { argv: "list" });
  assert.equal(m.ok, false, "the Toolkit could not run it: a failed step");
});

test('repro of "unknown command exits 0 instead of 1": fails as expected on the buggy base, passes once fixed', async () => {
  const expect = 'exit 1 and contains "unknown command"';
  unknownExit = "0"; // the bug
  const base = await run(expect);
  assert.equal(base.status, "assert-fail", base.why ?? ""); // what repro counts as failedAsExpected
  assert.equal(base.outcome.exit, 0);
  unknownExit = "1"; // fixed
  const fixed = await run(expect);
  assert.equal(fixed.status, "pass", fixed.why ?? "");
});

test("a bug whose base exits non-zero is reproduced too (job 006: `kitchen version` exits 2 on the base)", async () => {
  unknownExit = "2";
  const base = await run('exit 0 and contains "1 Buy milk"');
  assert.equal(base.status, "assert-fail", "a step that ran with exit 2 is no longer step-failed");
});

test("an expect that says nothing about exit still requires exit 0, as a cmd proof does", async () => {
  unknownExit = "1";
  assert.equal((await run('contains "unknown command"')).status, "assert-fail");
  unknownExit = "0";
  assert.equal((await run('contains "unknown command"')).status, "pass");
});
