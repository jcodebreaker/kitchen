// An http step's output is `{status, body}` (the template's and the bench Toolkits' `http`).
// d-control-version (bench e75efe0): a guard's `json .ok` read the wrapper, not the body,
// and failed a correct build. Now `json`, `rows` and `--save` read the body (a key the body
// lacks reads the response: `json .status`, `json .body.ok`), `--save v` also keeps
// `$v_status`, `contains` reads the whole response, and a failed status proves no absence.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type { DriveResult } from "./drive.ts";
import { prove, responseOut } from "./prove.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-http-"));
/** The fake app: path → [status, body]. */
const routes: Record<string, [number, unknown]> = {
  "/healthz": [200, { ok: true, db: true, version: "1.2.0" }],
  "/orders/1": [200, { id: 1, status: "paid", items: [{ sku: "MUG" }, { sku: "TEE" }] }],
  "/admin": [403, { error: "admins only" }],
};
vi.mock("./drive.ts", () => ({
  runDrive: async (o: { request: { primitive?: string; args: Record<string, string> } }): Promise<Partial<DriveResult>> => {
    const [status, body] = routes[o.request.args.path] ?? [404, { error: "not found" }];
    // As the d-api Toolkit does: the response as JSON text.
    const step = { line: 1, step: "http", ok: true, out: JSON.stringify({ status, body }), evidence: [] };
    return { ok: true, drive: "http", vars: {}, steps: [step] };
  },
}));

const run = (proof: string, expect: string) => prove({ jobDir: dir, criterion: { id: "C1", proof, expect }, role: "engine", testCmd: "true" });

test("json, rows and --save read an http step's body; the status stays reachable", async () => {
  assert.equal((await run("toolkit http --path /healthz", 'json .ok == true and json .version == "1.2.0"')).status, "pass");
  assert.equal(
    (await run("toolkit http --path /healthz", "json .status == 200 and json .body.ok == true")).status,
    "pass",
    "keys the body lacks read the response",
  );
  assert.equal((await run("toolkit http --path /orders/1", 'json .status == "paid"')).status, "pass", "the body's own status wins");
  assert.equal((await run("toolkit http --path /orders/1", 'json .items[1].sku == "TEE"')).status, "pass");
  const saved = await run("toolkit http --path /healthz --save h", '$h contains "1.2.0" and $h_status == "200" and json $h.ok == true');
  assert.equal(saved.status, "pass", saved.why ?? "");
  assert.equal((await run("toolkit http --path /healthz", 'contains "\\"status\\":200"')).status, "pass", "contains reads the whole response");
});

test("a failed response proves no absence, on the last output or a saved var", async () => {
  const last = await run("toolkit http --path /admin", 'json .error != "Bob plan"');
  assert.equal(last.status, "assert-fail");
  assert.match(last.why ?? "", /status 403/);
  const v = await run("toolkit http --path /admin --save a", '$a not contains "Bob plan"');
  assert.equal(v.status, "assert-fail");
  assert.match(v.why ?? "", /status 403/);
});

test("responseOut: only the {status, body} shape", () => {
  assert.deepEqual(responseOut({ status: 201, body: { id: 3 } })?.status, 201);
  assert.equal(responseOut('{"status":"paid","body":1}'), null, "a status that isn't an HTTP code");
  assert.equal(responseOut({ status: 200, body: 1, extra: 2 }), null);
  assert.equal(responseOut({ exit: 0, stdout: "" }), null);
});
